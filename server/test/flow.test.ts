import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PAGER_TUNE } from '../src/protocol.js';
import { connectDevice, httpClient, startServer, until } from './harness.js';

const DEV = 'a1b2c3d4e5f6';
const SECRET = 'f'.repeat(64);

describe('device lifecycle', () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  let admin: ReturnType<typeof httpClient>;
  let channelId: number;

  beforeAll(async () => {
    srv = await startServer();
    admin = httpClient(srv.url);
    expect((await admin('POST', '/api/auth/dev-login', { email: 'admin@example.com', name: 'Administrator' })).status).toBe(200);
    const ch = await admin('POST', '/api/channels', { slug: 'callout', name: 'Callouts' });
    expect(ch.status).toBe(201);
    channelId = ch.body.id;
  });

  afterAll(() => srv.stop());

  it('rejects unauthenticated API calls', async () => {
    expect((await httpClient(srv.url)('GET', '/api/devices')).status).toBe(401);
  });

  it('registers, pairs and configures a device', async () => {
    const reg = await admin('POST', '/api/device/register', { id: DEV, secret: SECRET, fw: '0.1.0' });
    expect(reg.status).toBe(200);
    expect(reg.body.claimed).toBe(false);
    expect(reg.body.claimCode).toMatch(/^[A-Z2-9]{6}$/);
    expect(reg.body.claimUrl).toBe(`${srv.url}/pair?code=${reg.body.claimCode}`);
    expect(reg.body.mqttUrl).toBe(srv.url.replace('http', 'ws') + '/mqtt');

    // Registering again returns the same code.
    const again = await admin('POST', '/api/device/register', { id: DEV, secret: SECRET });
    expect(again.body.claimCode).toBe(reg.body.claimCode);

    expect((await admin('POST', '/api/pair', { code: 'ZZZZZZ' })).status).toBe(404);
    const pair = await admin('POST', '/api/pair', { code: reg.body.claimCode.toLowerCase(), name: 'Bedside' });
    expect(pair.status).toBe(200);

    // A different secret can't hijack a claimed device.
    const hijack = await admin('POST', '/api/device/register', { id: DEV, secret: 'e'.repeat(64) });
    expect(hijack.status).toBe(409);

    const claimed = await admin('POST', '/api/device/register', { id: DEV, secret: SECRET });
    expect(claimed.body).toMatchObject({ claimed: true, name: 'Bedside', owner: 'Administrator' });

    expect((await admin('PATCH', `/api/devices/${DEV}`, { channelIds: [channelId] })).status).toBe(200);
  });

  it('refuses MQTT with a bad secret', async () => {
    await expect(connectDevice(srv.url, DEV, 'wrong-secret-wrong-secret-wrong-secret')).rejects.toThrow();
  });

  it('delivers pages live and records receipt and ack', async () => {
    const dev = await connectDevice(srv.url, DEV, SECRET);
    await dev.hello({ rssi: -60, ip: '192.168.1.50' });
    expect(await dev.next('config')).toEqual({ claimed: true, name: 'Bedside', channels: ['callout'] });

    const list = await admin('GET', '/api/devices');
    expect(list.body[0]).toMatchObject({ id: DEV, online: true, rssi: -60, fwVersion: '0.1.0' });

    const sent = await admin('POST', '/api/pages', { channelId, title: 'Callout', body: 'Lost hiker, Mt Si. Respond.' });
    expect(sent.body.targets).toBe(1);
    const page = await dev.next('page');
    expect(page).toMatchObject({ id: sent.body.id, ch: 'callout', title: 'Callout', alarm: true, tune: PAGER_TUNE });

    // Tests play the server's tune unless the request brings its own; bad tunes never reach the device.
    expect((await admin('POST', `/api/devices/${DEV}/command`, { cmd: 'test' })).status).toBe(200);
    expect(await dev.next('cmd')).toEqual({ cmd: 'test', tune: PAGER_TUNE });
    const tune = 'scale:d=8,o=6,b=160:c,d,e,f,g,a,b,4c7';
    expect((await admin('POST', `/api/devices/${DEV}/command`, { cmd: 'test', tune })).status).toBe(200);
    expect(await dev.next('cmd')).toEqual({ cmd: 'test', tune });
    expect((await admin('POST', `/api/devices/${DEV}/command`, { cmd: 'test', tune: 'not a tune' })).status).toBe(400);

    await dev.send('ack', { page: page.id, state: 'received' });
    await dev.send('ack', { page: page.id, state: 'acked' });
    await until(async () => (await admin('GET', `/api/pages/${page.id}`)).body.deliveries[0].ackedAt !== null);

    const pages = await admin('GET', '/api/pages');
    expect(pages.body[0]).toMatchObject({ targets: 1, received: 1, acked: 1 });

    // Devices may not publish onto another device's topics; the broker drops the client.
    const closed = new Promise<void>((r) => dev.client.once('close', () => r()));
    dev.client.publish('dev/000000000000/ack', JSON.stringify({ page: page.id, state: 'acked' }), { qos: 1 });
    await closed;
    await until(async () => (await admin('GET', '/api/devices')).body[0].online === false);
  });

  it('replays missed pages on reconnect without re-alarming stale ones', async () => {
    const sent = await admin('POST', '/api/pages', { channelId, body: 'Sent while offline' });
    const dev = await connectDevice(srv.url, DEV, SECRET);
    await dev.hello();
    await dev.next('config');
    const page = await dev.next('page');
    expect(page.id).toBe(sent.body.id);
    expect(page.alarm).toBe(true); // still within the alarm window
    await dev.send('ack', { page: page.id, state: 'received' });
    await until(async () => (await admin('GET', `/api/pages/${page.id}`)).body.deliveries[0].receivedAt !== null);
    await dev.close();

    // Received pages aren't replayed again.
    const dev2 = await connectDevice(srv.url, DEV, SECRET);
    await dev2.hello();
    await dev2.next('config');
    await expect(dev2.next('page', 300)).rejects.toThrow('timed out');
    await dev2.close();
  });

  it('accepts ingest with the bearer token only', async () => {
    const anon = httpClient(srv.url);
    expect((await anon('POST', '/api/ingest/page', { channel: 'callout', body: 'x' })).status).toBe(401);
    const res = await fetch(`${srv.url}/api/ingest/page`, {
      method: 'POST',
      headers: { authorization: 'Bearer ingest-token', 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'callout', body: 'From the callout system' }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ targets: 1 });
  });

  it("pages <slug>@ email from the VM's mail service", async () => {
    const email = (body: object, token = 'ingest-token') =>
      fetch(`${srv.url}/api/ingest/email`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: 'dispatch@example.org', ...body }),
      });
    const mail = {
      to: 'Callout@beepers.example.org',
      subject: 'SAR callout:\r\n  lost hiker',
      text: 'Lost hiker near Mt Si.\r\n\r\n\r\n\r\nRespond to base.\r\n-- \r\nKing County Dispatch\r\n',
    };
    expect((await email(mail, 'wrong')).status).toBe(401);

    const res = await email(mail);
    expect(res.status).toBe(201);
    const { id } = await res.json();
    const page = (await admin('GET', `/api/pages/${id}`)).body;
    expect(page).toMatchObject({ title: 'SAR callout: lost hiker', body: 'Lost hiker near Mt Si.\n\nRespond to base.', source: 'email' });

    // A 4xx bounces the email, with the error as its reason.
    const unknown = await email({ ...mail, to: 'nope@beepers.example.org' });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: 'No channel "nope"' });
    expect((await email({ ...mail, subject: ' ', text: '\r\n' })).status).toBe(400);
    // Subject only: the subject is the page.
    const subjectOnly = await email({ ...mail, text: '' });
    expect((await admin('GET', `/api/pages/${(await subjectOnly.json()).id}`)).body.body).toBe('SAR callout: lost hiker');
  });

  it('members only see their own devices', async () => {
    const sam = httpClient(srv.url);
    expect((await sam('POST', '/api/auth/dev-login', { email: 'Sam@Example.com', name: 'Sam' })).status).toBe(200);
    expect((await sam('GET', '/api/devices')).body).toEqual([]);
    expect((await sam('GET', `/api/devices/${DEV}`)).status).toBe(404);
    expect((await sam('POST', '/api/pages', { channelId, body: 'x' })).status).toBe(403);
  });
});
