import { timingSafeEqual } from 'node:crypto';
import { and, count, eq, gt, isNotNull, isNull, like } from 'drizzle-orm';
import { Hono } from 'hono';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { Db } from './db/index.js';
import { channels, deliveries, devices, pages, settings } from './db/schema.js';

import { DEFAULT_FW_PREFIX } from './hub.js';

/** Seconds from page creation; reaching a pager that was offline can take hours. */
const LATENCY_BUCKETS = [0.5, 1, 2, 5, 10, 30, 60, 120, 300, 900, 3600, 4 * 3600];

/** Event types logged by the server (hub, routes) and by the firmware (ota.c). */
const KNOWN_EVENTS = new Set([
  'connect',
  'disconnect',
  'hello',
  'command',
  'claimed',
  'released',
  'reset',
  'ota_start',
  'ota_ok',
  'ota_installed',
  'ota_failed',
  'ota_rollback',
]);

/** Paired pagers below this signal count as weak (sar_devices_weak_signal). */
const WEAK_RSSI_DBM = -80;
/** Paired pagers silent for longer than this count as offline (sar_devices_offline_30m), as the pager's own chirp. */
const OFFLINE_MS = 30 * 60_000;

/**
 * Prometheus metrics for admins (Grafana). Counters and histograms are updated as things
 * happen; the device gauges are read from the database on each scrape. There are no
 * per-device series: the gauges count pagers, and the web UI shows each one.
 */
export class Metrics {
  readonly registry = new Registry();

  readonly pages = this.counter('sar_pages_total', 'Pages created', ['channel', 'source']);
  readonly pagesSent = this.counter('sar_page_messages_sent_total', 'Page messages published to devices, including replays');
  readonly pageReceipts = this.counter('sar_page_receipts_total', 'First receipt or ack of a page by a device', ['state']);
  readonly receiveSeconds = this.histogram('sar_page_receive_seconds', 'Page creation to first receipt by a device');
  readonly ackSeconds = this.histogram('sar_page_ack_seconds', 'Page creation to acknowledgement on a device');
  readonly mqttConnects = this.counter('sar_mqtt_connects_total', 'Device MQTT sessions opened');
  readonly mqttDisconnects = this.counter('sar_mqtt_disconnects_total', 'Device MQTT sessions closed');
  readonly mqttAuthFailures = this.counter('sar_mqtt_auth_failures_total', 'Rejected device MQTT logins');
  private deviceEvents = this.counter('sar_device_events_total', 'Device log events, e.g. ota_rollback', ['type']);
  readonly ingest = this.counter('sar_ingest_requests_total', 'POST /api/ingest/page and /api/ingest/email requests', ['result']);

  private devices = this.gauge('sar_devices', 'Devices, by board, firmware, whether paired, and whether connected', [
    'board',
    'fw_version',
    'paired',
    'online',
  ]);
  private quiet = this.gauge('sar_devices_quiet', 'Paired pagers with the arm/quiet switch on quiet');
  private offline = this.gauge('sar_devices_offline_30m', 'Paired pagers not heard from for over 30 minutes');
  private weakSignal = this.gauge('sar_devices_weak_signal', `Connected paired pagers with Wi-Fi below ${WEAK_RSSI_DBM} dBm`);
  private minHeap = this.gauge('sar_devices_free_heap_min_bytes', "Lowest free heap of the connected pagers' last status");
  private defaultFw = this.gauge('sar_firmware_default_info', "Each board's rollout default firmware version", [
    'board',
    'version',
  ]);
  private unreceived = this.gauge(
    'sar_deliveries_unreceived',
    'Unexpired page deliveries not yet received by their device',
  );

  constructor(private db: Db) {
    collectDefaultMetrics({ register: this.registry });
    // Every counter series starts at 0, not at its first increment: increase() can't count a series' first sample, so
    // otherwise the first page, receipt or rollback after each restart would be missed. Channels are added on scrape.
    for (const state of ['received', 'acked']) this.pageReceipts.inc({ state }, 0);
    for (const type of KNOWN_EVENTS) this.deviceEvents.inc({ type }, 0);
    this.deviceEvents.inc({ type: 'other' }, 0);
    for (const result of ['ok', 'unauthorized', 'unknown_channel', 'empty']) this.ingest.inc({ result }, 0);
  }

  /** Devices choose their own event types, so unknown ones are lumped together to bound the labels. */
  deviceEvent(type: string) {
    this.deviceEvents.inc({ type: KNOWN_EVENTS.has(type) ? type : 'other' });
  }

  /** Prometheus text exposition, after refreshing the device gauges. */
  async scrape(): Promise<string> {
    await this.refresh();
    return this.registry.metrics();
  }

  get contentType() {
    return this.registry.contentType;
  }

  private async refresh() {
    const rows = await this.db
      .select({
        board: devices.hwRev,
        fwVersion: devices.fwVersion,
        paired: isNotNull(devices.ownerId),
        online: devices.online,
        armed: devices.armed,
        rssi: devices.rssi,
        freeHeap: devices.freeHeap,
        lastSeenAt: devices.lastSeenAt,
      })
      .from(devices);
    const defaults = await this.db.select().from(settings).where(like(settings.key, `${DEFAULT_FW_PREFIX}%`));
    const [pending] = await this.db
      .select({ n: count() })
      .from(deliveries)
      .innerJoin(pages, eq(pages.id, deliveries.pageId))
      .where(and(isNull(deliveries.receivedAt), gt(pages.expiresAt, new Date())));
    // Each channel's page counters from 0 (see the constructor); adding 0 leaves one that's counting alone.
    for (const { slug } of await this.db.select({ slug: channels.slug }).from(channels)) {
      for (const source of ['web', 'api', 'email']) this.pages.inc({ channel: slug, source }, 0);
    }

    // Reset so combinations nobody has any more disappear instead of reporting stale counts.
    this.devices.reset();
    this.defaultFw.reset();
    const now = Date.now();
    let quiet = 0;
    let offline = 0;
    let weak = 0;
    let minHeap: number | null = null;
    for (const d of rows) {
      const labels = { board: d.board ?? '', fw_version: d.fwVersion ?? '', paired: String(d.paired), online: String(d.online) };
      this.devices.inc(labels);
      if (d.online && d.freeHeap != null) minHeap = Math.min(minHeap ?? d.freeHeap, d.freeHeap);
      if (!d.paired) continue;
      if (d.armed === false) quiet++;
      if (!d.online && (!d.lastSeenAt || now - d.lastSeenAt.getTime() > OFFLINE_MS)) offline++;
      if (d.online && d.rssi != null && d.rssi < WEAK_RSSI_DBM) weak++;
    }
    this.quiet.set(quiet);
    this.offline.set(offline);
    this.weakSignal.set(weak);
    // NaN rather than 0 when no pager is connected, so it can't look like one ran out (comparisons with NaN are false).
    this.minHeap.set(minHeap ?? NaN);
    for (const d of defaults) this.defaultFw.set({ board: d.key.slice(DEFAULT_FW_PREFIX.length), version: d.value }, 1);
    this.unreceived.set(pending?.n ?? 0);
  }

  private counter<L extends string = never>(name: string, help: string, labelNames: L[] = []) {
    return new Counter<L>({ name, help, labelNames, registers: [this.registry] });
  }

  private gauge<L extends string = never>(name: string, help: string, labelNames: L[] = []) {
    return new Gauge<L>({ name, help, labelNames, registers: [this.registry] });
  }

  private histogram(name: string, help: string) {
    return new Histogram({ name, help, buckets: LATENCY_BUCKETS, registers: [this.registry] });
  }
}

/** GET /metrics, served on its own port so the public reverse proxy never exposes it. */
export function metricsApp(metrics: Metrics, token?: string) {
  const app = new Hono();
  app.get('/metrics', async (c) => {
    if (token) {
      const given = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      if (given.length !== token.length || !timingSafeEqual(Buffer.from(given), Buffer.from(token))) {
        return c.text('Unauthorized', 401);
      }
    }
    return c.body(await metrics.scrape(), 200, { 'content-type': metrics.contentType });
  });
  return app;
}
