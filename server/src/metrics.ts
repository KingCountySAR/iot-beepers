import { timingSafeEqual } from 'node:crypto';
import { and, count, eq, gt, isNull, like } from 'drizzle-orm';
import { Hono } from 'hono';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { Db } from './db/index.js';
import { deliveries, devices, pages, settings, users } from './db/schema.js';

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

/**
 * Prometheus metrics for admins (Grafana). Counters and histograms are updated as things
 * happen; per-device gauges are read from the database on each scrape.
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
  readonly ingest = this.counter('sar_ingest_requests_total', 'POST /api/ingest/page requests', ['result']);

  private deviceInfo = this.gauge('sar_device_info', 'One per device; join on `device` for names', [
    'device',
    'name',
    'owner',
    'fw_version',
    'board',
  ]);
  private online = this.gauge('sar_device_online', '1 if the device has a live MQTT session', ['device']);
  private armed = this.gauge('sar_device_armed', '1 if the arm/quiet switch is on armed', ['device']);
  private rssi = this.gauge('sar_device_rssi_dbm', 'Wi-Fi signal at the last status message', ['device']);
  private heap = this.gauge('sar_device_free_heap_bytes', 'Free heap at the last status message', ['device']);
  private uptime = this.gauge('sar_device_uptime_seconds', 'Uptime at the last status message', ['device']);
  private lastSeen = this.gauge('sar_device_last_seen_timestamp_seconds', 'Last message from the device', ['device']);
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
  }

  /** Devices choose their own event types, so unknown ones are lumped together to bound the labels. */
  deviceEvent(type: string) {
    this.deviceEvents.inc({ type: KNOWN_EVENTS.has(type) ? type : 'other' });
  }

  /** Prometheus text exposition, after refreshing the per-device gauges. */
  async scrape(): Promise<string> {
    await this.refresh();
    return this.registry.metrics();
  }

  get contentType() {
    return this.registry.contentType;
  }

  private async refresh() {
    const rows = await this.db
      .select({ dev: devices, owner: users.displayName })
      .from(devices)
      .leftJoin(users, eq(users.id, devices.ownerId));
    const defaults = await this.db.select().from(settings).where(like(settings.key, `${DEFAULT_FW_PREFIX}%`));
    const [pending] = await this.db
      .select({ n: count() })
      .from(deliveries)
      .innerJoin(pages, eq(pages.id, deliveries.pageId))
      .where(and(isNull(deliveries.receivedAt), gt(pages.expiresAt, new Date())));

    // Reset so deleted devices disappear instead of reporting stale values.
    for (const g of [this.deviceInfo, this.online, this.armed, this.rssi, this.heap, this.uptime, this.lastSeen, this.defaultFw]) {
      g.reset();
    }
    for (const { dev, owner } of rows) {
      const device = dev.id;
      this.deviceInfo.set(
        { device, name: dev.name, owner: owner ?? '', fw_version: dev.fwVersion ?? '', board: dev.hwRev ?? '' },
        1,
      );
      this.online.set({ device }, dev.online ? 1 : 0);
      this.armed.set({ device }, dev.armed ? 1 : 0);
      if (dev.rssi != null) this.rssi.set({ device }, dev.rssi);
      if (dev.freeHeap != null) this.heap.set({ device }, dev.freeHeap);
      if (dev.uptimeS != null) this.uptime.set({ device }, dev.uptimeS);
      if (dev.lastSeenAt) this.lastSeen.set({ device }, dev.lastSeenAt.getTime() / 1000);
    }
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
