import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import mqtt from 'mqtt';
import { createApp } from '../src/app.js';
import { ensureBootstrapAdmin } from '../src/auth.js';
import { createBroker } from '../src/broker.js';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { Hub, type Publish } from '../src/hub.js';
import { Metrics } from '../src/metrics.js';

/**
 * With TEST_DATABASE_URL set (a Postgres server URL), each server gets its own fresh
 * database there; otherwise an in-memory PGlite DB.
 */
async function testDatabaseUrl(): Promise<string | undefined> {
  const admin = process.env.TEST_DATABASE_URL;
  if (!admin) return undefined;
  const name = `notifier_test_${randomBytes(4).toString('hex')}`;
  const client = new pg.Client({ connectionString: admin });
  await client.connect();
  await client.query(`CREATE DATABASE ${name}`);
  await client.end();
  const url = new URL(admin);
  url.pathname = `/${name}`;
  return url.toString();
}

/** Boots the full server (HTTP + MQTT-over-WS) on a random port. */
export async function startServer(env: Record<string, string> = {}) {
  const DATABASE_URL = await testDatabaseUrl();
  const base = loadConfig({
    PGLITE_DIR: 'memory://',
    ADMIN_PASSWORD: 'admin-pass',
    INGEST_TOKEN: 'ingest-token',
    ...(DATABASE_URL ? { DATABASE_URL } : {}),
    ...env,
  });
  const { db, close } = await openDatabase(base);
  await ensureBootstrapAdmin(db, base.ADMIN_USERNAME, base.ADMIN_PASSWORD);

  let publish: Publish = async () => {};
  // PUBLIC_URL is only known after listening; the hub reads cfg lazily so patch it in place.
  const cfg = { ...base };
  const hub = new Hub(db, cfg, (t, p) => publish(t, p), new Metrics(db));
  const broker = await createBroker(db, hub);
  publish = broker.publish;
  const app = createApp({ db, cfg, hub, disconnect: broker.disconnect });

  const server = await new Promise<Server>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0 }, () => resolve(s as Server)) as Server;
  });
  broker.attach(server);
  const port = (server.address() as AddressInfo).port;
  cfg.PUBLIC_URL = `http://127.0.0.1:${port}`;

  return {
    url: cfg.PUBLIC_URL,
    db,
    hub,
    async stop() {
      await new Promise<void>((r) => broker.broker.close(() => r()));
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await close();
    },
  };
}

/** Tiny fetch wrapper that keeps the session cookie. */
export function httpClient(url: string) {
  let cookie = '';
  return async function call<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const isForm = body instanceof FormData;
    const res = await fetch(url + path, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(body && !isForm ? { 'content-type': 'application/json' } : {}),
        origin: url,
      },
      body: isForm ? body : body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0]!;
    const text = await res.text();
    let parsed: any = text;
    try {
      parsed = JSON.parse(text);
    } catch {}
    return { status: res.status, body: parsed };
  };
}

/** Simulated device: MQTT client plus a queue of received messages per topic kind. */
export async function connectDevice(url: string, id: string, secret: string) {
  const client = await mqtt.connectAsync(url.replace(/^http/, 'ws') + '/mqtt', {
    clientId: id,
    username: id,
    password: secret,
    reconnectPeriod: 0,
    protocolVersion: 4,
  });
  const inbox: { kind: string; msg: any }[] = [];
  const waiters: (() => void)[] = [];
  client.on('message', (topic, payload) => {
    inbox.push({ kind: topic.split('/')[2]!, msg: JSON.parse(payload.toString()) });
    waiters.splice(0).forEach((w) => w());
  });
  await client.subscribeAsync(`dev/${id}/#`, { qos: 1 });

  return {
    client,
    inbox,
    send: (kind: string, msg: object) => client.publishAsync(`dev/${id}/${kind}`, JSON.stringify(msg), { qos: 1 }),
    hello: (extra: object = {}) =>
      client.publishAsync(
        `dev/${id}/status`,
        JSON.stringify({ type: 'hello', fw: '0.1.0', armed: true, ...extra }),
        { qos: 1 },
      ),
    /** Wait for (and remove) the next message of a kind. */
    async next(kind: string, timeoutMs = 3000): Promise<any> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const i = inbox.findIndex((m) => m.kind === kind);
        if (i >= 0) return inbox.splice(i, 1)[0]!.msg;
        const left = deadline - Date.now();
        if (left <= 0) throw new Error(`timed out waiting for ${kind}`);
        await new Promise<void>((r) => {
          waiters.push(r);
          setTimeout(r, left);
        });
      }
    },
    close: () => client.endAsync(),
  };
}

export const until = async (fn: () => Promise<boolean> | boolean, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 20));
  }
};
