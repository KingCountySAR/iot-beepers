import { timingSafeEqual } from 'node:crypto';
import { zValidator } from '@hono/zod-validator';
import { and, count, desc, eq, inArray, isNotNull, like, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import {
  createSession,
  destroySession,
  hashPassword,
  requireAdmin,
  requireUser,
  verifyPassword,
  type AppEnv,
  type SessionUser,
} from '../auth.js';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
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
} from '../db/schema.js';
import { FIRMWARE_PROJECT, parseFirmwareUpload } from '../firmware.js';
import { DEFAULT_FW_PREFIX, type Hub } from '../hub.js';

export interface ApiDeps {
  db: Db;
  cfg: Config;
  hub: Hub;
  /** Drop a device's MQTT session. */
  disconnect: (deviceId: string) => void;
}

const MAX_FIRMWARE_BYTES = 4 * 1024 * 1024;

const deviceColumns = {
  id: devices.id,
  name: devices.name,
  ownerId: devices.ownerId,
  ownerName: users.displayName,
  claimedAt: devices.claimedAt,
  createdAt: devices.createdAt,
  online: devices.online,
  lastSeenAt: devices.lastSeenAt,
  lastConnectAt: devices.lastConnectAt,
  fwVersion: devices.fwVersion,
  fwTarget: devices.fwTarget,
  hwRev: devices.hwRev,
  ip: devices.ip,
  rssi: devices.rssi,
  uptimeS: devices.uptimeS,
  freeHeap: devices.freeHeap,
  armed: devices.armed,
  resetReason: devices.resetReason,
};

const Login = z.object({ username: z.string(), password: z.string() });
const Pair = z.object({ code: z.string().trim().toUpperCase(), name: z.string().max(60).optional() });
const DevicePatch = z.object({
  name: z.string().max(60).optional(),
  channelIds: z.array(z.number().int()).optional(),
});
const DeviceCommand = z.object({ cmd: z.enum(['test', 'identify', 'reboot']) });
const ChannelBody = z.object({
  slug: z.string().regex(/^[a-z0-9-]{1,32}$/, 'lowercase letters, digits and dashes'),
  name: z.string().min(1).max(60),
  description: z.string().max(200).default(''),
});
const PageBody = z.object({
  channelId: z.number().int(),
  title: z.string().max(80).default(''),
  body: z.string().min(1).max(2000),
  ttlMin: z.number().int().positive().max(24 * 60).optional(),
});
const IngestBody = z.object({
  channel: z.string(),
  title: z.string().max(80).default(''),
  body: z.string().min(1).max(2000),
  ttlMin: z.number().int().positive().max(24 * 60).optional(),
});
const UserBody = z.object({
  username: z.string().regex(/^[a-z0-9._-]{2,40}$/),
  displayName: z.string().min(1).max(80),
  password: z.string().min(8),
  isAdmin: z.boolean().default(false),
});
const UserPatch = z.object({
  displayName: z.string().min(1).max(80).optional(),
  password: z.string().min(8).optional(),
  isAdmin: z.boolean().optional(),
});
const VersionBody = z.object({ version: z.string().nullable() });
const DefaultFirmwareBody = z.object({ board: z.string().min(1), version: z.string().nullable() });

export function apiRoutes({ db, cfg, hub, disconnect }: ApiDeps) {
  const app = new Hono<AppEnv>();

  /** Load a device the current user may manage (its owner, or any admin). */
  async function ownedDevice(user: SessionUser, id: string) {
    const [dev] = await db.select().from(devices).where(eq(devices.id, id));
    if (!dev || (!user.isAdmin && dev.ownerId !== user.id)) {
      throw new HTTPException(404, { message: 'Device not found' });
    }
    return dev;
  }

  async function channelIdsByDevice(ids: string[]) {
    const map = new Map<string, number[]>();
    if (ids.length === 0) return map;
    const rows = await db.select().from(deviceChannels).where(inArray(deviceChannels.deviceId, ids));
    for (const r of rows) map.set(r.deviceId, [...(map.get(r.deviceId) ?? []), r.channelId]);
    return map;
  }

  // ---- auth ---------------------------------------------------------------

  app.post('/auth/login', zValidator('json', Login), async (c) => {
    const { username, password } = c.req.valid('json');
    const [user] = await db.select().from(users).where(eq(users.username, username.toLowerCase()));
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      return c.json({ error: 'Invalid username or password' }, 401);
    }
    await createSession(db, c, user.id);
    return c.json({ id: user.id, username: user.username, displayName: user.displayName, isAdmin: user.isAdmin });
  });

  app.post('/auth/logout', async (c) => {
    await destroySession(db, c);
    return c.json({ ok: true });
  });

  app.get('/auth/me', (c) => c.json(c.var.user));

  app.put(
    '/auth/password',
    requireUser,
    zValidator('json', z.object({ current: z.string(), password: z.string().min(8) })),
    async (c) => {
      const body = c.req.valid('json');
      const [user] = await db.select().from(users).where(eq(users.id, c.var.user!.id));
      if (!user || !(await verifyPassword(body.current, user.passwordHash))) {
        return c.json({ error: 'Current password is wrong' }, 400);
      }
      await db.update(users).set({ passwordHash: await hashPassword(body.password) }).where(eq(users.id, user.id));
      return c.json({ ok: true });
    },
  );

  // ---- ingest (machine-to-machine) ---------------------------------------

  app.post('/ingest/page', zValidator('json', IngestBody), async (c) => {
    const token = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    const expected = cfg.INGEST_TOKEN;
    const ok =
      !!expected &&
      token.length === expected.length &&
      timingSafeEqual(Buffer.from(token), Buffer.from(expected));
    if (!ok) {
      hub.metrics.ingest.inc({ result: 'unauthorized' });
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const body = c.req.valid('json');
    const [ch] = await db.select().from(channels).where(eq(channels.slug, body.channel));
    if (!ch) {
      hub.metrics.ingest.inc({ result: 'unknown_channel' });
      return c.json({ error: `Unknown channel "${body.channel}"` }, 404);
    }
    const { page, targets } = await hub.createPage({ ...body, channelId: ch.id, source: 'api' });
    hub.metrics.ingest.inc({ result: 'ok' });
    return c.json({ id: page.id, targets }, 201);
  });

  // Everything below needs a logged-in user.
  app.use('*', requireUser);

  // ---- pairing ------------------------------------------------------------

  app.post('/pair', zValidator('json', Pair), async (c) => {
    const { code, name } = c.req.valid('json');
    const user = c.var.user!;
    const [dev] = await db.select().from(devices).where(eq(devices.claimCode, code));
    if (!dev || !dev.claimExpiresAt || dev.claimExpiresAt < new Date()) {
      return c.json({ error: 'That code is invalid or has expired. Restart setup on the device for a new one.' }, 404);
    }
    if (dev.ownerId !== null) return c.json({ error: 'Device is already claimed' }, 409);
    await db
      .update(devices)
      .set({
        ownerId: user.id,
        name: name || `${user.displayName}'s pager`,
        claimCode: null,
        claimExpiresAt: null,
        claimedAt: new Date(),
      })
      .where(eq(devices.id, dev.id));
    await hub.logEvent(dev.id, 'claimed', user.username);
    await hub.sendConfig(dev.id);
    return c.json({ id: dev.id });
  });

  // ---- devices ------------------------------------------------------------

  app.get('/devices', async (c) => {
    const user = c.var.user!;
    const rows = await db
      .select(deviceColumns)
      .from(devices)
      .leftJoin(users, eq(users.id, devices.ownerId))
      .where(user.isAdmin ? undefined : eq(devices.ownerId, user.id))
      .orderBy(devices.name, devices.id);
    const chans = await channelIdsByDevice(rows.map((r) => r.id));
    return c.json(rows.map((r) => ({ ...r, channelIds: chans.get(r.id) ?? [] })));
  });

  app.get('/devices/:id', async (c) => {
    const dev = await ownedDevice(c.var.user!, c.req.param('id'));
    const [row] = await db
      .select(deviceColumns)
      .from(devices)
      .leftJoin(users, eq(users.id, devices.ownerId))
      .where(eq(devices.id, dev.id));
    const chans = await channelIdsByDevice([dev.id]);
    const events = await db
      .select()
      .from(deviceEvents)
      .where(eq(deviceEvents.deviceId, dev.id))
      .orderBy(desc(deviceEvents.at))
      .limit(50);
    const recentPages = await db
      .select({
        pageId: pages.id,
        title: pages.title,
        body: pages.body,
        createdAt: pages.createdAt,
        sentAt: deliveries.sentAt,
        receivedAt: deliveries.receivedAt,
        ackedAt: deliveries.ackedAt,
      })
      .from(deliveries)
      .innerJoin(pages, eq(pages.id, deliveries.pageId))
      .where(eq(deliveries.deviceId, dev.id))
      .orderBy(desc(pages.createdAt))
      .limit(20);
    return c.json({ ...row, channelIds: chans.get(dev.id) ?? [], events, recentPages });
  });

  app.patch('/devices/:id', zValidator('json', DevicePatch), async (c) => {
    const dev = await ownedDevice(c.var.user!, c.req.param('id'));
    const body = c.req.valid('json');
    if (body.name !== undefined) await db.update(devices).set({ name: body.name }).where(eq(devices.id, dev.id));
    if (body.channelIds) {
      await db.transaction(async (tx) => {
        await tx.delete(deviceChannels).where(eq(deviceChannels.deviceId, dev.id));
        if (body.channelIds!.length > 0) {
          await tx
            .insert(deviceChannels)
            .values(body.channelIds!.map((channelId) => ({ deviceId: dev.id, channelId })));
        }
      });
    }
    await hub.sendConfig(dev.id);
    return c.json({ ok: true });
  });

  app.post('/devices/:id/command', zValidator('json', DeviceCommand), async (c) => {
    const dev = await ownedDevice(c.var.user!, c.req.param('id'));
    const sent = await hub.sendCommand(dev.id, c.req.valid('json'));
    if (!sent) return c.json({ error: 'Device is offline' }, 409);
    return c.json({ ok: true });
  });

  /** Owner gives the device up; it keeps its identity and can be claimed again. */
  app.post('/devices/:id/release', async (c) => {
    const dev = await ownedDevice(c.var.user!, c.req.param('id'));
    await db.delete(deviceChannels).where(eq(deviceChannels.deviceId, dev.id));
    await db.update(devices).set({ ownerId: null, claimedAt: null, name: '' }).where(eq(devices.id, dev.id));
    await hub.logEvent(dev.id, 'released', c.var.user!.username);
    await hub.sendConfig(dev.id);
    return c.json({ ok: true });
  });

  /** Admin: forget the device's secret so it can re-register after a flash erase. */
  app.post('/devices/:id/reset', requireAdmin, async (c) => {
    const id = c.req.param('id');
    await db.delete(deviceChannels).where(eq(deviceChannels.deviceId, id));
    await db
      .update(devices)
      .set({ secretHash: null, ownerId: null, claimedAt: null, name: '' })
      .where(eq(devices.id, id));
    await hub.logEvent(id, 'reset', c.var.user!.username);
    disconnect(id);
    return c.json({ ok: true });
  });

  app.put('/devices/:id/firmware-target', requireAdmin, zValidator('json', VersionBody), async (c) => {
    const id = c.req.param('id');
    const { version } = c.req.valid('json');
    if (version !== null) {
      const [dev] = await db.select({ board: devices.hwRev }).from(devices).where(eq(devices.id, id));
      if (!dev) return c.json({ error: 'Not found' }, 404);
      if (!dev.board) return c.json({ error: "This pager hasn't reported its board yet" }, 409);
      const [fw] = await db
        .select({ v: firmware.version })
        .from(firmware)
        .where(and(eq(firmware.board, dev.board), eq(firmware.version, version)));
      if (!fw) return c.json({ error: `No ${version} image for board ${dev.board}` }, 404);
    }
    await db.update(devices).set({ fwTarget: version }).where(eq(devices.id, id));
    const started = await hub.otaAll({ ids: [id] });
    return c.json({ ok: true, started: started > 0 });
  });

  app.delete('/devices/:id', requireAdmin, async (c) => {
    const id = c.req.param('id');
    disconnect(id);
    await db.delete(devices).where(eq(devices.id, id));
    return c.json({ ok: true });
  });

  // ---- channels -----------------------------------------------------------

  app.get('/channels', async (c) => c.json(await db.select().from(channels).orderBy(channels.name)));

  app.post('/channels', requireAdmin, zValidator('json', ChannelBody), async (c) => {
    const [row] = await db.insert(channels).values(c.req.valid('json')).returning();
    return c.json(row, 201);
  });

  app.patch('/channels/:id', requireAdmin, zValidator('json', ChannelBody.partial()), async (c) => {
    const id = Number(c.req.param('id'));
    const [row] = await db.update(channels).set(c.req.valid('json')).where(eq(channels.id, id)).returning();
    if (!row) return c.notFound();
    return c.json(row);
  });

  app.delete('/channels/:id', requireAdmin, async (c) => {
    await db.delete(channels).where(eq(channels.id, Number(c.req.param('id'))));
    return c.json({ ok: true });
  });

  // ---- pages --------------------------------------------------------------

  app.get('/pages', async (c) => {
    const limit = Math.min(Number(c.req.query('limit') ?? 50), 200);
    const rows = await db
      .select({
        id: pages.id,
        channelId: pages.channelId,
        channelName: channels.name,
        title: pages.title,
        body: pages.body,
        source: pages.source,
        createdAt: pages.createdAt,
        expiresAt: pages.expiresAt,
        targets: count(deliveries.deviceId),
        received: sql<number>`count(${deliveries.receivedAt})::int`,
        acked: sql<number>`count(${deliveries.ackedAt})::int`,
      })
      .from(pages)
      .innerJoin(channels, eq(channels.id, pages.channelId))
      .leftJoin(deliveries, eq(deliveries.pageId, pages.id))
      .groupBy(pages.id, channels.name)
      .orderBy(desc(pages.createdAt))
      .limit(limit);
    return c.json(rows);
  });

  app.get('/pages/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const [page] = await db.select().from(pages).where(eq(pages.id, id));
    if (!page) return c.notFound();
    const rows = await db
      .select({
        deviceId: deliveries.deviceId,
        deviceName: devices.name,
        ownerName: users.displayName,
        sentAt: deliveries.sentAt,
        receivedAt: deliveries.receivedAt,
        ackedAt: deliveries.ackedAt,
      })
      .from(deliveries)
      .innerJoin(devices, eq(devices.id, deliveries.deviceId))
      .leftJoin(users, eq(users.id, devices.ownerId))
      .where(eq(deliveries.pageId, id))
      .orderBy(users.displayName);
    return c.json({ ...page, deliveries: rows });
  });

  app.post('/pages', requireAdmin, zValidator('json', PageBody), async (c) => {
    const body = c.req.valid('json');
    const { page, targets } = await hub.createPage({ ...body, source: 'web', createdBy: c.var.user!.id });
    return c.json({ id: page.id, targets }, 201);
  });

  // ---- firmware -----------------------------------------------------------

  const firmwareColumns = {
    board: firmware.board,
    version: firmware.version,
    chip: firmware.chip,
    sha256: firmware.sha256,
    size: firmware.size,
    idfVersion: firmware.idfVersion,
    notes: firmware.notes,
    flashable: sql<boolean>`${firmware.bootloader} is not null`,
    uploadedAt: firmware.uploadedAt,
  };

  /** Board -> default version, for every board that has one. */
  async function firmwareDefaults(): Promise<Record<string, string>> {
    const rows = await db.select().from(settings).where(like(settings.key, `${DEFAULT_FW_PREFIX}%`));
    return Object.fromEntries(rows.map((r) => [r.key.slice(DEFAULT_FW_PREFIX.length), r.value]));
  }

  app.get('/firmware', requireAdmin, async (c) => {
    const rows = await db.select(firmwareColumns).from(firmware).orderBy(firmware.board, desc(firmware.uploadedAt));
    return c.json({ defaults: await firmwareDefaults(), images: rows });
  });

  app.post('/firmware', requireAdmin, async (c) => {
    const form = await c.req.parseBody();
    const file = form['file'];
    if (!(file instanceof File)) return c.json({ error: 'Attach the .bin as "file"' }, 400);
    if (file.size > MAX_FIRMWARE_BYTES) return c.json({ error: 'Image too large' }, 400);
    let upload;
    try {
      upload = parseFirmwareUpload(Buffer.from(await file.arrayBuffer()));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    const { desc: d, app: image, flash } = upload;
    if (d.project !== FIRMWARE_PROJECT) {
      return c.json({ error: `Image is for project "${d.project}", expected "${FIRMWARE_PROJECT}"` }, 400);
    }
    const [existing] = await db
      .select({ v: firmware.version })
      .from(firmware)
      .where(and(eq(firmware.board, d.board), eq(firmware.version, d.version)));
    if (existing) return c.json({ error: `Version ${d.version} for ${d.board} already uploaded` }, 409);
    await db.insert(firmware).values({
      board: d.board,
      version: d.version,
      chip: d.chip,
      sha256: d.sha256,
      size: d.size,
      idfVersion: d.idfVersion,
      notes: typeof form['notes'] === 'string' ? form['notes'] : '',
      image,
      bootloader: flash?.bootloader ?? null,
      partitionTable: flash?.partitionTable ?? null,
      flashLayout: flash?.layout ?? null,
    });
    return c.json({ board: d.board, version: d.version, sha256: d.sha256, size: d.size, flashable: !!flash }, 201);
  });

  /** Set the version every device of a board without its own target should run, and start rolling it out. */
  app.put('/firmware/default', requireAdmin, zValidator('json', DefaultFirmwareBody), async (c) => {
    const { board, version } = c.req.valid('json');
    if (version !== null) {
      const [fw] = await db
        .select({ v: firmware.version })
        .from(firmware)
        .where(and(eq(firmware.board, board), eq(firmware.version, version)));
      if (!fw) return c.json({ error: 'Unknown version' }, 404);
    }
    await hub.setDefaultFirmware(board, version);
    return c.json({ ok: true, started: version === null ? 0 : await hub.otaAll({ board }) });
  });

  app.delete('/firmware/:board/:version', requireAdmin, async (c) => {
    const { board, version } = c.req.param();
    if ((await hub.defaultFirmware(board)) === version) {
      return c.json({ error: 'That version is the current default' }, 409);
    }
    await db.delete(firmware).where(and(eq(firmware.board, board), eq(firmware.version, version)));
    return c.json({ ok: true });
  });

  // ---- browser flasher ----------------------------------------------------

  /** Boards with flashable images, newest first, and which version each defaults to. */
  app.get('/flash', async (c) => {
    const rows = await db
      .select({
        board: firmware.board,
        version: firmware.version,
        chip: firmware.chip,
        layout: firmware.flashLayout,
        uploadedAt: firmware.uploadedAt,
      })
      .from(firmware)
      .where(isNotNull(firmware.bootloader))
      .orderBy(firmware.board, desc(firmware.uploadedAt));
    const defaults = await firmwareDefaults();
    const boards = new Map<string, { board: string; chip: string; default: string | null; images: typeof rows }>();
    for (const r of rows) {
      const b = boards.get(r.board) ?? { board: r.board, chip: r.chip, default: defaults[r.board] ?? null, images: [] };
      b.images.push(r);
      boards.set(r.board, b);
    }
    return c.json({ publicUrl: cfg.PUBLIC_URL, boards: [...boards.values()] });
  });

  const FLASH_PARTS = { bootloader: firmware.bootloader, 'partition-table': firmware.partitionTable, app: firmware.image };

  app.get('/flash/:board/:version/:part', async (c) => {
    const { board, version, part } = c.req.param();
    const column = FLASH_PARTS[part as keyof typeof FLASH_PARTS];
    if (!column) return c.json({ error: 'Not found' }, 404);
    const [row] = await db
      .select({ data: column })
      .from(firmware)
      .where(and(eq(firmware.board, board), eq(firmware.version, version)));
    if (!row?.data) return c.json({ error: 'Not found' }, 404);
    return c.body(new Uint8Array(row.data), 200, { 'Content-Type': 'application/octet-stream' });
  });

  // ---- users --------------------------------------------------------------

  const userColumns = {
    id: users.id,
    username: users.username,
    displayName: users.displayName,
    isAdmin: users.isAdmin,
    createdAt: users.createdAt,
  };

  app.get('/users', requireAdmin, async (c) =>
    c.json(await db.select(userColumns).from(users).orderBy(users.displayName)),
  );

  app.post('/users', requireAdmin, zValidator('json', UserBody), async (c) => {
    const { password, ...rest } = c.req.valid('json');
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.username, rest.username));
    if (existing) return c.json({ error: 'Username taken' }, 409);
    const [row] = await db
      .insert(users)
      .values({ ...rest, passwordHash: await hashPassword(password) })
      .returning(userColumns);
    return c.json(row, 201);
  });

  app.patch('/users/:id', requireAdmin, zValidator('json', UserPatch), async (c) => {
    const { password, ...rest } = c.req.valid('json');
    const set = { ...rest, ...(password ? { passwordHash: await hashPassword(password) } : {}) };
    if (Object.keys(set).length === 0) return c.json({ ok: true });
    await db.update(users).set(set).where(eq(users.id, Number(c.req.param('id'))));
    return c.json({ ok: true });
  });

  app.delete('/users/:id', requireAdmin, async (c) => {
    const id = Number(c.req.param('id'));
    if (id === c.var.user!.id) return c.json({ error: "You can't delete yourself" }, 400);
    await db.delete(users).where(eq(users.id, id));
    return c.json({ ok: true });
  });

  return app;
}
