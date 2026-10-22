import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { metricsApp } from '../src/metrics.js';
import { connectDevice, httpClient, startServer, until } from './harness.js';

const DEV = 'b1b2c3d4e5f6';
const SECRET = 'a'.repeat(64);

describe('prometheus metrics', () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  let admin: ReturnType<typeof httpClient>;
  const scrape = async () => (await metricsApp(srv.hub.metrics).request('/metrics')).text();

  beforeAll(async () => {
    srv = await startServer();
    admin = httpClient(srv.url);
    await admin('POST', '/api/auth/login', { username: 'admin', password: 'admin-pass' });
    const ch = await admin('POST', '/api/channels', { slug: 'callout', name: 'Callouts' });
    const reg = await admin('POST', '/api/device/register', { id: DEV, secret: SECRET, fw: '0.1.0' });
    await admin('POST', '/api/pair', { code: reg.body.claimCode, name: 'Bedside' });
    await admin('PATCH', `/api/devices/${DEV}`, { channelIds: [ch.body.id] });
  });

  afterAll(() => srv.stop());

  it('reports devices, pages, receipts and acks', async () => {
    const dev = await connectDevice(srv.url, DEV, SECRET);
    await dev.hello({ rssi: -61, heap: 120000 });
    await dev.next('config');
    await until(async () => (await scrape()).includes(`sar_device_rssi_dbm{device="${DEV}"} -61`));

    let text = await scrape();
    expect(text).toContain(
      `sar_device_info{device="${DEV}",name="Bedside",owner="Administrator",fw_version="0.1.0",board=""} 1`,
    );
    expect(text).toContain(`sar_device_online{device="${DEV}"} 1`);
    expect(text).toContain(`sar_device_armed{device="${DEV}"} 1`);
    expect(text).toContain('sar_mqtt_connects_total 1');

    const sent = await admin('POST', '/api/pages', { channelId: 1, body: 'Callout' });
    const page = await dev.next('page');
    expect(page.id).toBe(sent.body.id);
    expect(await scrape()).toContain('sar_deliveries_unreceived 1');

    // Duplicate acks count once.
    await dev.send('ack', { page: page.id, state: 'acked' });
    await dev.send('ack', { page: page.id, state: 'acked' });
    await until(async () => (await scrape()).includes('sar_page_ack_seconds_count 1'));
    text = await scrape();
    expect(text).toContain('sar_pages_total{channel="callout",source="web"} 1');
    expect(text).toContain('sar_page_messages_sent_total 1');
    expect(text).toContain('sar_page_receipts_total{state="received"} 1');
    expect(text).toContain('sar_page_receipts_total{state="acked"} 1');
    expect(text).toContain('sar_page_receive_seconds_count 1');
    expect(text).toContain('sar_deliveries_unreceived 0');
    // The ack recorded receipt too, so the page list agrees.
    expect((await admin('GET', '/api/pages')).body[0]).toMatchObject({ received: 1, acked: 1 });

    // Device-chosen event types can't create unbounded label values.
    await dev.send('event', { type: 'ota_rollback', detail: '0.1.1' });
    await dev.send('event', { type: 'made_up_123' });
    await until(async () => (await scrape()).includes('sar_device_events_total{type="other"} 1'));
    expect(await scrape()).toContain('sar_device_events_total{type="ota_rollback"} 1');

    await dev.close();
    await until(async () => (await scrape()).includes(`sar_device_online{device="${DEV}"} 0`));
    expect(await scrape()).toContain('sar_mqtt_disconnects_total 1');
  });

  it('counts rejected MQTT logins', async () => {
    await expect(connectDevice(srv.url, DEV, 'wrong-secret-wrong-secret-wrong-secret')).rejects.toThrow();
    expect(await scrape()).toContain('sar_mqtt_auth_failures_total 1');
  });

  it('requires the token when one is set', async () => {
    const app = metricsApp(srv.hub.metrics, 'scrape-token');
    expect((await app.request('/metrics')).status).toBe(401);
    expect((await app.request('/metrics', { headers: { authorization: 'Bearer nope' } })).status).toBe(401);
    const ok = await app.request('/metrics', { headers: { authorization: 'Bearer scrape-token' } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toContain('text/plain');
  });
});
