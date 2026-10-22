import { randomInt } from 'node:crypto';
import { zValidator } from '@hono/zod-validator';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { sha256 } from '../auth.js';
import { mqttUrl, type Config } from '../config.js';
import type { Db } from '../db/index.js';
import { devices, firmware, users } from '../db/schema.js';
import { DEVICE_ID_RE } from '../protocol.js';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newClaimCode = () =>
  Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');

const RegisterBody = z.object({
  id: z.string().regex(DEVICE_ID_RE),
  secret: z.string().min(32).max(128),
  fw: z.string().max(32).optional(),
  hw: z.string().max(32).optional(),
});

/** Endpoints called by the devices themselves (not session-authenticated). */
export function deviceRoutes(db: Db, cfg: Config) {
  const app = new Hono();

  /**
   * Called by the device during setup (and on every boot). Creates the device record on
   * first contact and, while it is unclaimed, hands back a short claim code the member
   * types/opens on the server to take ownership.
   */
  app.post('/register', zValidator('json', RegisterBody), async (c) => {
    const body = c.req.valid('json');
    const secretHash = sha256(body.secret);
    let [dev] = await db.select().from(devices).where(eq(devices.id, body.id));

    if (!dev) {
      [dev] = await db.insert(devices).values({ id: body.id, secretHash }).returning();
    } else if (dev.secretHash !== secretHash) {
      // A claimed device keeps its identity; an admin must "reset" it before a new
      // secret (e.g. after a full flash erase) is accepted.
      if (dev.secretHash !== null && dev.ownerId !== null) {
        return c.json({ error: 'Device is claimed with a different secret. Ask an admin to reset it.' }, 409);
      }
      [dev] = await db.update(devices).set({ secretHash }).where(eq(devices.id, body.id)).returning();
    }
    if (!dev) throw new Error('device upsert failed');

    await db
      .update(devices)
      .set({ fwVersion: body.fw ?? dev.fwVersion, hwRev: body.hw ?? dev.hwRev })
      .where(eq(devices.id, dev.id));

    const base = { mqttUrl: mqttUrl(cfg) };
    if (dev.ownerId !== null) {
      const [owner] = await db.select().from(users).where(eq(users.id, dev.ownerId));
      return c.json({ ...base, claimed: true, owner: owner?.displayName ?? '', name: dev.name });
    }

    let code = dev.claimCode;
    if (!code || !dev.claimExpiresAt || dev.claimExpiresAt.getTime() < Date.now() + 60_000) {
      const claimExpiresAt = new Date(Date.now() + cfg.CLAIM_CODE_TTL_MIN * 60_000);
      for (let attempt = 0; ; attempt++) {
        code = newClaimCode();
        try {
          await db.update(devices).set({ claimCode: code, claimExpiresAt }).where(eq(devices.id, dev.id));
          break;
        } catch (err) {
          if (attempt >= 5) throw err; // unique collision, try another code
        }
      }
    }
    return c.json({
      ...base,
      claimed: false,
      claimCode: code,
      claimUrl: `${cfg.PUBLIC_URL}/pair?code=${code}`,
    });
  });

  /** OTA download. Firmware contains no secrets, so this is public. */
  app.get('/firmware/:board/:version', async (c) => {
    const { board, version } = c.req.param();
    const [fw] = await db
      .select({ image: firmware.image, size: firmware.size, sha256: firmware.sha256 })
      .from(firmware)
      .where(and(eq(firmware.board, board), eq(firmware.version, version)));
    if (!fw) return c.notFound();
    return c.body(new Uint8Array(fw.image), 200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(fw.size),
      'X-Firmware-Sha256': fw.sha256,
    });
  });

  return app;
}
