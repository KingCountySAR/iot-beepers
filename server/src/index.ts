import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import { Access } from './access.js';
import { createApp } from './app.js';
import { pruneSessions } from './auth.js';
import { createBroker } from './broker.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/index.js';
import { googleVerifier } from './google.js';
import { Hub, type Publish } from './hub.js';
import { createMemberDirectory } from './memberdb.js';
import { Metrics, metricsApp } from './metrics.js';

const cfg = loadConfig();
const { db, close } = await openDatabase(cfg);
console.log(cfg.DATABASE_URL ? 'Using Postgres' : `Using embedded PGlite at ${cfg.PGLITE_DIR}`);

if (cfg.GOOGLE_CLIENT_ID) console.log("Google sign-in on; its OAuth client must list this site's origins as Authorized JavaScript origins");
if (cfg.DEV_LOGIN) console.warn('DEV_LOGIN is on: anyone who can reach this server can sign in as any listed user.');
if (!cfg.GOOGLE_CLIENT_ID && !cfg.DEV_LOGIN) console.warn('Neither GOOGLE_CLIENT_ID nor DEV_LOGIN is set; nobody can sign in.');
if (cfg.SITE_ADMINS.length === 0) console.warn('SITE_ADMINS is empty; nobody has admin rights.');
if (cfg.ALLOWED_DOMAINS.length === 0) console.warn('ALLOWED_DOMAINS is empty; only SITE_ADMINS can sign in.');
if (!cfg.MEMBER_API_URL) console.warn('MEMBER_API_URL is not set; members only get channels an admin grants them directly.');

// Hub and broker reference each other; the hub publishes through the broker once it exists.
let publish: Publish = async () => {};
const hub = new Hub(db, cfg, (t, p) => publish(t, p), new Metrics(db));
await hub.resetOnline();
const mqtt = await createBroker(db, hub);
publish = mqtt.publish;
const access = new Access(db, cfg, hub, createMemberDirectory(cfg));

const app = createApp({ db, cfg, hub, disconnect: mqtt.disconnect, access, verifyGoogle: cfg.GOOGLE_CLIENT_ID ? googleVerifier(cfg.GOOGLE_CLIENT_ID) : null, logRequests: true });
const server = serve({ fetch: app.fetch, port: cfg.PORT }, (info) => {
  console.log(`Listening on :${info.port} (public URL ${cfg.PUBLIC_URL})`);
}) as Server;
mqtt.attach(server);

const metricsServer =
  cfg.METRICS_PORT > 0
    ? (serve({ fetch: metricsApp(hub.metrics, cfg.METRICS_TOKEN).fetch, port: cfg.METRICS_PORT }, (info) => {
        console.log(`Metrics on :${info.port}/metrics`);
      }) as Server)
    : null;

const prune = setInterval(() => pruneSessions(db).catch(console.error), 3600_000);

// Member sync every MEMBER_SYNC_HOURS, timed from the last run so restarts don't repeat it.
const syncIfDue = async () => {
  const last = await access.lastSync();
  if (!last || Date.now() - Date.parse(last.at) >= cfg.MEMBER_SYNC_HOURS * 3600_000) await access.sync();
};
const syncCheck = setInterval(() => syncIfDue().catch(console.error), 3600_000);
setTimeout(() => syncIfDue().catch(console.error), 60_000).unref();

const shutdown = () => {
  clearInterval(prune);
  clearInterval(syncCheck);
  metricsServer?.close();
  mqtt.broker.close(() => server.close(() => void close().then(() => process.exit(0))));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
