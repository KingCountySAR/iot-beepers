import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { Aedes, type Client } from 'aedes';
import { eq } from 'drizzle-orm';
import { WebSocketServer, createWebSocketStream } from 'ws';
import { sha256 } from './auth.js';
import type { Db } from './db/index.js';
import { devices } from './db/schema.js';
import type { Hub } from './hub.js';
import { AckMessage, DEVICE_ID_RE, EventMessage, StatusMessage } from './protocol.js';

const MQTT_PATH = '/mqtt';

/** Error with an MQTT CONNACK return code (5 = not authorized). */
const authError = (code: number) => Object.assign(new Error('Not authorized'), { returnCode: code });

/**
 * Embedded MQTT broker. Devices authenticate as username=<device id>, password=<device secret>
 * and may only touch their own dev/<id>/... topics. Only the server publishes to devices.
 */
export async function createBroker(db: Db, hub: Hub) {
  const broker = await Aedes.createBroker({ drainTimeout: 30_000 });

  // Latest live client per device id, so a stale session's disconnect doesn't mark a
  // reconnected device offline.
  const current = new Map<string, Client>();

  broker.authenticate = (client, username, password, done) => {
    const reject = () => {
      hub.metrics.mqttAuthFailures.inc();
      done(authError(5), false);
    };
    void (async () => {
      if (!username || !password || client.id !== username || !DEVICE_ID_RE.test(username)) {
        return reject();
      }
      const [dev] = await db
        .select({ secretHash: devices.secretHash })
        .from(devices)
        .where(eq(devices.id, username));
      if (!dev?.secretHash || dev.secretHash !== sha256(password)) return reject();
      done(null, true);
    })().catch((err) => done(err, false));
  };

  broker.authorizeSubscribe = (client, sub, done) => {
    if (client && sub.topic.startsWith(`dev/${client.id}/`)) return done(null, sub);
    done(new Error('subscribe not allowed'));
  };

  const inbound = new Set(['status', 'ack', 'event']);
  broker.authorizePublish = (client, packet, done) => {
    const [root, id, kind, ...rest] = packet.topic.split('/');
    if (client && root === 'dev' && id === client.id && kind && inbound.has(kind) && rest.length === 0) {
      return done(null);
    }
    done(new Error('publish not allowed'));
  };

  broker.on('clientReady', (client) => {
    current.set(client.id, client);
    hub.onConnect(client.id).catch(logErr('connect'));
  });

  broker.on('clientDisconnect', (client) => {
    if (current.get(client.id) !== client) return;
    current.delete(client.id);
    hub.onDisconnect(client.id).catch(logErr('disconnect'));
  });

  broker.on('publish', (packet, client) => {
    if (!client) return; // our own outbound publishes
    const kind = packet.topic.split('/')[2];
    let json: unknown;
    try {
      json = JSON.parse(packet.payload.toString());
    } catch {
      return console.warn(`bad JSON from ${client.id} on ${packet.topic}`);
    }
    const handle = async () => {
      if (kind === 'status') {
        const msg = StatusMessage.safeParse(json);
        if (msg.success) await hub.onStatus(client.id, msg.data);
      } else if (kind === 'ack') {
        const msg = AckMessage.safeParse(json);
        if (msg.success) await hub.onAck(client.id, msg.data);
      } else if (kind === 'event') {
        const msg = EventMessage.safeParse(json);
        if (msg.success) await hub.logEvent(client.id, msg.data.type, msg.data.detail);
      }
    };
    handle().catch(logErr(kind ?? 'publish'));
  });

  const publish = (topicName: string, payload: object) =>
    new Promise<void>((resolve, reject) =>
      broker.publish(
        {
          cmd: 'publish',
          topic: topicName,
          payload: Buffer.from(JSON.stringify(payload)),
          qos: 1,
          retain: false,
          dup: false,
        },
        (err) => (err ? reject(err) : resolve()),
      ),
    );

  /** Accept MQTT-over-WebSocket on /mqtt of the HTTP server (TLS is terminated by the proxy). */
  function attach(server: Server) {
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (new URL(req.url ?? '/', 'http://x').pathname !== MQTT_PATH) return socket.destroy();
      wss.handleUpgrade(req, socket, head, (ws) => {
        broker.handle(createWebSocketStream(ws), req);
      });
    });
    return wss;
  }

  /** Kick a device's session, e.g. after it is reset or deleted. */
  function disconnect(deviceId: string) {
    current.get(deviceId)?.close();
  }

  return { broker, publish, attach, disconnect };
}

const logErr = (what: string) => (err: unknown) => console.error(`mqtt ${what}:`, err);
