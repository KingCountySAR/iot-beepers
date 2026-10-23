import { z } from 'zod';
import { PAGER_TUNE, Rtttl } from './protocol.js';

const minutes = (def: number) => z.coerce.number().positive().default(def);

const Env = z.object({
  PORT: z.coerce.number().int().default(4100),
  /** Externally reachable base URL. Devices derive the MQTT and OTA URLs from this. */
  PUBLIC_URL: z.url().default('http://localhost:4100'),
  /** Postgres connection string. When unset, an embedded PGlite database is used (dev only). */
  DATABASE_URL: z.string().optional(),
  /** Directory for the embedded PGlite database. Use "memory://" for an ephemeral DB. */
  PGLITE_DIR: z.string().default('./data/pglite'),
  /** Bootstrap admin account, created on startup if no users exist. */
  ADMIN_USERNAME: z.string().default('admin'),
  ADMIN_PASSWORD: z.string().optional(),
  /** Bearer token for POST /api/ingest/page. Ingest is disabled when unset. */
  INGEST_TOKEN: z.string().optional(),
  /** Pages older than this are delivered silently (LED only) instead of sounding the alarm. */
  ALARM_WINDOW_MIN: minutes(10),
  /** RTTTL tune pagers sound for pages and tests. Empty = the pagers' built-in beeps. */
  ALARM_TUNE: z.union([z.literal(''), Rtttl]).default(PAGER_TUNE),
  /** Default lifetime of a page; expired pages are not replayed to reconnecting devices. */
  PAGE_TTL_MIN: minutes(120),
  CLAIM_CODE_TTL_MIN: minutes(30),
  /** Don't re-send an OTA command to the same device more often than this. */
  OTA_RETRY_MIN: minutes(60),
  /** Port for Prometheus GET /metrics, kept off the public port. 0 disables it. */
  METRICS_PORT: z.coerce.number().int().default(4101),
  /** Optional bearer token Prometheus must send to /metrics. */
  METRICS_TOKEN: z.string().optional(),
  /** Directory of the built web UI to serve. */
  WEB_DIST: z.string().default('../web/dist'),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const cfg = Env.parse(env);
  return { ...cfg, PUBLIC_URL: cfg.PUBLIC_URL.replace(/\/+$/, '') };
}

export function mqttUrl(cfg: Config): string {
  return cfg.PUBLIC_URL.replace(/^http/, 'ws') + '/mqtt';
}
