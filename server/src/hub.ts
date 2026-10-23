import { and, eq, gt, inArray, isNull } from 'drizzle-orm';
import type { Config } from './config.js';
import type { Db } from './db/index.js';
import type { Metrics } from './metrics.js';
import {
  channels,
  deliveries,
  deviceChannels,
  deviceEvents,
  devices,
  firmware,
  pages,
  settings,
  users,
} from './db/schema.js';
import {
  MAX_PAGE_TEXT,
  topic,
  type AckMessage,
  type Command,
  type DeviceConfig,
  type PageMessage,
  type StatusMessage,
} from './protocol.js';

export type Publish = (topic: string, payload: object) => Promise<void>;

/** Settings key holding a board's default firmware version. */
export const DEFAULT_FW_PREFIX = 'firmware.default.';
export const defaultFirmwareKey = (board: string) => DEFAULT_FW_PREFIX + board;

/**
 * All device-facing behaviour lives here: what to send a device when it connects,
 * fanning pages out to channels, tracking receipts/acks, and triggering OTA.
 * The MQTT broker calls in; this class calls out through `publish`.
 */
export class Hub {
  /** Devices with a live MQTT session. The DB `online` column mirrors this for queries. */
  readonly connected = new Set<string>();

  constructor(
    private db: Db,
    private cfg: Config,
    private publish: Publish,
    readonly metrics: Metrics,
  ) {}

  /** The broker is in-process, so nothing is connected when we start. */
  async resetOnline() {
    await this.db.update(devices).set({ online: false }).where(eq(devices.online, true));
  }

  async logEvent(deviceId: string, type: string, detail = '') {
    await this.db.insert(deviceEvents).values({ deviceId, type, detail });
    this.metrics.deviceEvent(type);
  }

  async onConnect(deviceId: string) {
    this.connected.add(deviceId);
    this.metrics.mqttConnects.inc();
    const now = new Date();
    await this.db
      .update(devices)
      .set({ online: true, lastConnectAt: now, lastSeenAt: now })
      .where(eq(devices.id, deviceId));
    await this.logEvent(deviceId, 'connect');
  }

  async onDisconnect(deviceId: string) {
    this.connected.delete(deviceId);
    this.metrics.mqttDisconnects.inc();
    await this.db
      .update(devices)
      .set({ online: false, lastSeenAt: new Date() })
      .where(eq(devices.id, deviceId));
    await this.logEvent(deviceId, 'disconnect');
  }

  async onStatus(deviceId: string, msg: StatusMessage) {
    await this.db
      .update(devices)
      .set({
        lastSeenAt: new Date(),
        fwVersion: msg.fw,
        armed: msg.armed,
        rssi: msg.rssi ?? null,
        ip: msg.ip ?? null,
        uptimeS: msg.uptime ?? null,
        freeHeap: msg.heap ?? null,
        ...(msg.hw ? { hwRev: msg.hw } : {}),
        ...(msg.reset ? { resetReason: msg.reset } : {}),
      })
      .where(eq(devices.id, deviceId));

    if (msg.type === 'hello') {
      await this.logEvent(deviceId, 'hello', `fw ${msg.fw}${msg.reset ? `, reset ${msg.reset}` : ''}`);
      await this.sendConfig(deviceId);
      await this.replayPending(deviceId);
      await this.maybeOta(deviceId);
    }
  }

  /** An ack implies receipt. Only the first of each is recorded; devices may repeat them. */
  async onAck(deviceId: string, msg: AckMessage) {
    const now = new Date();
    const states = msg.state === 'acked' ? (['received', 'acked'] as const) : (['received'] as const);
    for (const state of states) {
      const column = state === 'acked' ? deliveries.ackedAt : deliveries.receivedAt;
      const [row] = await this.db
        .update(deliveries)
        .set(state === 'acked' ? { ackedAt: now } : { receivedAt: now })
        .where(and(eq(deliveries.pageId, msg.page), eq(deliveries.deviceId, deviceId), isNull(column)))
        .returning({ pageId: deliveries.pageId });
      if (!row) continue;
      const [page] = await this.db.select({ createdAt: pages.createdAt }).from(pages).where(eq(pages.id, msg.page));
      this.metrics.pageReceipts.inc({ state });
      if (page) {
        const latency = (now.getTime() - page.createdAt.getTime()) / 1000;
        (state === 'acked' ? this.metrics.ackSeconds : this.metrics.receiveSeconds).observe(latency);
      }
    }
  }

  async sendConfig(deviceId: string) {
    if (!this.connected.has(deviceId)) return;
    const [dev] = await this.db.select().from(devices).where(eq(devices.id, deviceId));
    if (!dev) return;
    const subs = await this.db
      .select({ slug: channels.slug })
      .from(deviceChannels)
      .innerJoin(channels, eq(channels.id, deviceChannels.channelId))
      .where(eq(deviceChannels.deviceId, deviceId));
    const config: DeviceConfig = {
      claimed: dev.ownerId != null,
      name: dev.name,
      channels: subs.map((s) => s.slug),
    };
    await this.publish(topic.config(deviceId), config);
  }

  async sendCommand(deviceId: string, cmd: Command): Promise<boolean> {
    if (!this.connected.has(deviceId)) return false;
    if (cmd.cmd === 'test') cmd = { ...cmd, tune: cmd.tune ?? (this.cfg.ALARM_TUNE || undefined) };
    await this.publish(topic.cmd(deviceId), cmd);
    await this.logEvent(deviceId, 'command', cmd.cmd);
    return true;
  }

  /**
   * Create a page and deliver it to every claimed device subscribed to the channel.
   * Offline devices get a delivery row now and receive it when they reconnect.
   */
  async createPage(input: {
    channelId: number;
    title?: string;
    body: string;
    source: string;
    createdBy?: string | null;
    ttlMin?: number;
  }) {
    const ttl = input.ttlMin ?? this.cfg.PAGE_TTL_MIN;
    const [page] = await this.db
      .insert(pages)
      .values({
        channelId: input.channelId,
        title: input.title ?? '',
        body: input.body,
        source: input.source,
        createdBy: input.createdBy ?? null,
        expiresAt: new Date(Date.now() + ttl * 60_000),
      })
      .returning();
    if (!page) throw new Error('insert failed');

    const targets = await this.db
      .select({ id: devices.id })
      .from(deviceChannels)
      .innerJoin(devices, eq(devices.id, deviceChannels.deviceId))
      .innerJoin(users, eq(users.id, devices.ownerId))
      .where(eq(deviceChannels.channelId, input.channelId));

    if (targets.length > 0) {
      await this.db
        .insert(deliveries)
        .values(targets.map((t) => ({ pageId: page.id, deviceId: t.id })));
    }
    const [ch] = await this.db.select().from(channels).where(eq(channels.id, input.channelId));
    this.metrics.pages.inc({ channel: ch?.slug ?? '', source: input.source });
    await Promise.all(
      targets
        .filter((t) => this.connected.has(t.id))
        .map((t) => this.deliver(t.id, page, ch?.slug ?? '')),
    );
    return { page, targets: targets.length };
  }

  private async deliver(
    deviceId: string,
    page: typeof pages.$inferSelect,
    channelSlug: string,
  ) {
    const msg: PageMessage = {
      id: page.id,
      ch: channelSlug,
      title: page.title.slice(0, 80),
      body: page.body.slice(0, MAX_PAGE_TEXT),
      alarm: Date.now() - page.createdAt.getTime() < this.cfg.ALARM_WINDOW_MIN * 60_000,
      ts: Math.floor(page.createdAt.getTime() / 1000),
      tune: this.cfg.ALARM_TUNE || undefined,
    };
    await this.publish(topic.page(deviceId), msg);
    this.metrics.pagesSent.inc();
    await this.db
      .update(deliveries)
      .set({ sentAt: new Date() })
      .where(and(eq(deliveries.pageId, page.id), eq(deliveries.deviceId, deviceId)));
  }

  /** Re-send unexpired pages the device never confirmed receiving. */
  async replayPending(deviceId: string) {
    const pending = await this.db
      .select({ page: pages, slug: channels.slug })
      .from(deliveries)
      .innerJoin(pages, eq(pages.id, deliveries.pageId))
      .innerJoin(channels, eq(channels.id, pages.channelId))
      .where(
        and(
          eq(deliveries.deviceId, deviceId),
          isNull(deliveries.receivedAt),
          gt(pages.expiresAt, new Date()),
        ),
      )
      .orderBy(pages.createdAt);
    for (const p of pending) await this.deliver(deviceId, p.page, p.slug);
  }

  /** The version every device of this board without its own target should run. */
  async defaultFirmware(board: string): Promise<string | null> {
    const [row] = await this.db.select().from(settings).where(eq(settings.key, defaultFirmwareKey(board)));
    return row?.value ?? null;
  }

  async setDefaultFirmware(board: string, version: string | null) {
    const key = defaultFirmwareKey(board);
    if (version === null) {
      await this.db.delete(settings).where(eq(settings.key, key));
    } else {
      await this.db
        .insert(settings)
        .values({ key, value: version })
        .onConflictDoUpdate({ target: settings.key, set: { value: version } });
    }
  }

  /** If the device isn't running its target firmware, tell it to update. */
  async maybeOta(deviceId: string, force = false): Promise<boolean> {
    if (!this.connected.has(deviceId)) return false;
    const [dev] = await this.db.select().from(devices).where(eq(devices.id, deviceId));
    // Without a board ID we can't know which image fits, so never guess.
    if (!dev?.fwVersion || !dev.hwRev) return false;
    const board = dev.hwRev;
    const target = dev.fwTarget ?? (await this.defaultFirmware(board));
    if (!target || target === dev.fwVersion) return false;
    const retryAfter = this.cfg.OTA_RETRY_MIN * 60_000;
    if (!force && dev.otaRequestedAt && Date.now() - dev.otaRequestedAt.getTime() < retryAfter) {
      return false;
    }
    const [fw] = await this.db
      .select({ version: firmware.version, sha256: firmware.sha256, size: firmware.size })
      .from(firmware)
      .where(and(eq(firmware.board, board), eq(firmware.version, target)));
    if (!fw) return false;

    await this.db.update(devices).set({ otaRequestedAt: new Date() }).where(eq(devices.id, deviceId));
    return this.sendCommand(deviceId, {
      cmd: 'ota',
      version: fw.version,
      url: `${this.cfg.PUBLIC_URL}/api/device/firmware/${encodeURIComponent(board)}/${encodeURIComponent(fw.version)}`,
      sha256: fw.sha256,
      size: fw.size,
    });
  }

  /** After a rollout change, nudge the given devices, or every connected device of a board. */
  async otaAll(target: { ids: string[] } | { board: string }) {
    let ids = 'ids' in target ? target.ids : [...this.connected];
    if ('board' in target && ids.length > 0) {
      const rows = await this.db
        .select({ id: devices.id })
        .from(devices)
        .where(and(inArray(devices.id, ids), eq(devices.hwRev, target.board)));
      ids = rows.map((r) => r.id);
    }
    if (ids.length === 0) return 0;
    await this.db.update(devices).set({ otaRequestedAt: null }).where(inArray(devices.id, ids));
    let n = 0;
    for (const id of ids) if (await this.maybeOta(id)) n++;
    return n;
  }
}
