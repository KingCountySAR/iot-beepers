import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { devices } from '../src/db/schema.js';
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
    await admin('POST', '/api/auth/dev-login', { email: 'admin@example.com', name: 'Administrator' });
    const ch = await admin('POST', '/api/channels', { slug: 'callout', name: 'Callouts' });
    const reg = await admin('POST', '/api/device/register', { id: DEV, secret: SECRET, fw: '0.1.0' });
    await admin('POST', '/api/pair', { code: reg.body.claimCode, name: 'Bedside' });
    await admin('PATCH', `/api/devices/${DEV}`, { channelIds: [ch.body.id] });
  });

  afterAll(() => srv.stop());

  it('reports devices, pages, receipts and acks', async () => {
    const dev = await connectDevice(srv.url, DEV, SECRET);
    await dev.hello({ rssi: -85, heap: 120000 });
    await dev.next('config');
    await until(async () => (await scrape()).includes('sar_devices_free_heap_min_bytes 120000'));

    // Counts only: nothing names or identifies a pager.
    let text = await scrape();
    expect(text).not.toContain(DEV);
    expect(text).not.toContain('Bedside');
    expect(text).toContain('sar_devices{board="",fw_version="0.1.0",paired="true",online="true"} 1');
    expect(text).toContain('sar_devices_weak_signal 1');
    expect(text).toContain('sar_devices_quiet 0');
    expect(text).toContain('sar_devices_offline_30m 0');
    expect(text).toContain('sar_mqtt_connects_total 1');
    // Series exist from 0 before anything happens, so increase() counts the first page, receipt or rollback.
    expect(text).toContain('sar_pages_total{channel="callout",source="web"} 0');
    expect(text).toContain('sar_page_receipts_total{state="acked"} 0');
    expect(text).toContain('sar_device_events_total{type="ota_rollback"} 0');

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
    await until(async () => (await scrape()).includes('sar_devices{board="",fw_version="0.1.0",paired="true",online="false"} 1'));
    text = await scrape();
    expect(text).toContain('sar_mqtt_disconnects_total 1');
    expect(text).not.toContain('online="true"');
    expect(text).toContain('sar_devices_free_heap_min_bytes Nan');
    // Just disconnected isn't offline yet; 31 minutes of silence is.
    expect(text).toContain('sar_devices_offline_30m 0');
    await srv.db.update(devices).set({ lastSeenAt: new Date(Date.now() - 31 * 60_000) }).where(eq(devices.id, DEV));
    await srv.db.update(devices).set({ armed: false }).where(eq(devices.id, DEV));
    text = await scrape();
    expect(text).toContain('sar_devices_offline_30m 1');
    expect(text).toContain('sar_devices_quiet 1');
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
