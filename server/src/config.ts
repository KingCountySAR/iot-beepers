import { z } from 'zod';
import { PAGER_TUNE, Rtttl } from './protocol.js';

const minutes = (def: number) => z.coerce.number().positive().default(def);
/** A comma-separated, case-insensitive list. */
const list = () =>
  z
    .string()
    .default('')
    .transform((s) => s.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean));

const Env = z.object({
  PORT: z.coerce.number().int().default(4100),
  /** Externally reachable base URL. Devices derive the MQTT and OTA URLs from this. */
  PUBLIC_URL: z.url().default('http://localhost:4100'),
  /** Postgres connection string. When unset, an embedded PGlite database is used (dev only). */
  DATABASE_URL: z.string().optional(),
  /** Directory for the embedded PGlite database. Use "memory://" for an ephemeral DB. */
  PGLITE_DIR: z.string().default('./data/pglite'),
  /** Comma-separated Google account emails with admin rights. They can always sign in. */
  SITE_ADMINS: list(),
  /**
   * Comma-separated Google Workspace domains (e.g. "kcesar.org") whose accounts may sign in,
   * checked against the ID token's `hd` claim. Empty: any account the member database knows.
   */
  ALLOWED_DOMAINS: list(),
  /**
   * Member database (memberdb.ts): cedar's /api/v1 URL (e.g. https://cedar.kingcountysar.org/api/v1),
   * and an OAuth client-credentials client for it from cedar's Hydra (token URL <issuer>/oauth2/token). Without MEMBER_API_URL nobody has groups, so only direct grants give access.
   */
  MEMBER_API_URL: z.url().optional(),
  MEMBER_API_TOKEN_URL: z.url().optional(),
  MEMBER_API_CLIENT_ID: z.string().optional(),
  MEMBER_API_CLIENT_SECRET: z.string().optional(),
  MEMBER_API_SCOPE: z.string().default('members.read'),
  /** How often to re-read group memberships and drop subscriptions people no longer qualify for. */
  MEMBER_SYNC_HOURS: z.coerce.number().positive().default(24),
  /** Re-check a member's groups when they look at or change their channels, if older than this. */
  MEMBER_GROUPS_MAX_AGE_MIN: minutes(5),
  /**
   * OAuth client ID for "Sign in with Google" (a Web application client in Google Cloud, with
   * the site's origins as Authorized JavaScript origins). No secret needed; see google.ts.
   */
  GOOGLE_CLIENT_ID: z.string().optional(),
  /**
   * Development and tests only: sign in by typing an email, with no Google round trip. The same
   * rules decide who gets in. Refused when PUBLIC_URL is https.
   */
  DEV_LOGIN: z
    .enum(['true', 'false', '1', '0', ''])
    .default('')
    .transform((v) => v === 'true' || v === '1'),
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
  /** Directory of the Drizzle migrations. Unset: server/drizzle, found from the source's own path. */
  MIGRATIONS_DIR: z.string().optional(),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  // Compose passes unset variables through as empty strings: treat those as unset.
  const cfg = Env.parse(Object.fromEntries(Object.entries(env).filter(([, v]) => v !== '')));
  if (cfg.DEV_LOGIN && cfg.PUBLIC_URL.startsWith('https:')) {
    throw new Error('DEV_LOGIN lets anyone sign in as anyone; it is refused when PUBLIC_URL is https');
  }
  if (cfg.MEMBER_API_URL && !(cfg.MEMBER_API_TOKEN_URL && cfg.MEMBER_API_CLIENT_ID && cfg.MEMBER_API_CLIENT_SECRET)) {
    throw new Error('MEMBER_API_URL needs MEMBER_API_TOKEN_URL, MEMBER_API_CLIENT_ID and MEMBER_API_CLIENT_SECRET');
  }
  return { ...cfg, PUBLIC_URL: cfg.PUBLIC_URL.replace(/\/+$/, '') };
}

export function mqttUrl(cfg: Config): string {
  return cfg.PUBLIC_URL.replace(/^http/, 'ws') + '/mqtt';
}
