import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import { createApp } from './app.js';
import { ensureBootstrapAdmin, pruneSessions } from './auth.js';
import { createBroker } from './broker.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/index.js';
import { Hub, type Publish } from './hub.js';
import { Metrics, metricsApp } from './metrics.js';

const cfg = loadConfig();
const { db, close } = await openDatabase(cfg);
console.log(cfg.DATABASE_URL ? 'Using Postgres' : `Using embedded PGlite at ${cfg.PGLITE_DIR}`);

await ensureBootstrapAdmin(db, cfg.ADMIN_USERNAME, cfg.ADMIN_PASSWORD);

// Hub and broker reference each other; the hub publishes through the broker once it exists.
let publish: Publish = async () => {};
const hub = new Hub(db, cfg, (t, p) => publish(t, p), new Metrics(db));
await hub.resetOnline();
const mqtt = await createBroker(db, hub);
publish = mqtt.publish;

const app = createApp({ db, cfg, hub, disconnect: mqtt.disconnect, logRequests: true });
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

const shutdown = () => {
  clearInterval(prune);
  metricsServer?.close();
  mqtt.broker.close(() => server.close(() => void close().then(() => process.exit(0))));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
