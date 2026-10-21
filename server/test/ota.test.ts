import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIRMWARE_PROJECT, parseAppImage } from '../src/firmware.js';
import { connectDevice, httpClient, startServer } from './harness.js';

/** Minimal fake ESP-IDF app image: header magic plus an esp_app_desc_t at offset 32. */
function fakeImage(version: string, project = FIRMWARE_PROJECT) {
  const img = Buffer.alloc(1024);
  img[0] = 0xe9;
  img.writeUInt32LE(0xabcd5432, 32);
  img.write(version, 48);
  img.write(project, 80);
  img.write('v5.5.1', 144);
  return img;
}

describe('parseAppImage', () => {
  it('reads the embedded app description', () => {
    const img = fakeImage('1.2.3');
    expect(parseAppImage(img)).toEqual({
      version: '1.2.3',
      project: FIRMWARE_PROJECT,
      idfVersion: 'v5.5.1',
      size: 1024,
      sha256: createHash('sha256').update(img).digest('hex'),
    });
  });

  it('rejects non-images', () => {
    expect(() => parseAppImage(Buffer.alloc(1024))).toThrow();
  });
});

describe('OTA rollout', () => {
  const DEV = '0123456789ab';
  const SECRET = 'a'.repeat(64);
  let srv: Awaited<ReturnType<typeof startServer>>;
  let admin: ReturnType<typeof httpClient>;

  beforeAll(async () => {
    srv = await startServer();
    admin = httpClient(srv.url);
    await admin('POST', '/api/auth/login', { username: 'admin', password: 'admin-pass' });
    await admin('POST', '/api/device/register', { id: DEV, secret: SECRET });
  });
  afterAll(() => srv.stop());

  const upload = (img: Buffer) => {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(img)]), 'app.bin');
    return admin('POST', '/api/firmware', form);
  };

  it('validates uploads', async () => {
    expect((await upload(fakeImage('0.2.0', 'other-project'))).status).toBe(400);
    expect((await upload(fakeImage('0.2.0'))).status).toBe(201);
    expect((await upload(fakeImage('0.2.0'))).status).toBe(409);
  });

  it('commands out-of-date devices to update and serves the image', async () => {
    const dev = await connectDevice(srv.url, DEV, SECRET);
    await dev.hello({ fw: '0.1.0' });
    await dev.next('config');

    const res = await admin('PUT', '/api/firmware/default', { version: '0.2.0' });
    expect(res.body.started).toBe(1);
    const cmd = await dev.next('cmd');
    expect(cmd).toMatchObject({ cmd: 'ota', version: '0.2.0', size: 1024 });

    const bin = Buffer.from(await (await fetch(cmd.url)).arrayBuffer());
    expect(createHash('sha256').update(bin).digest('hex')).toBe(cmd.sha256);

    // Up-to-date devices are left alone.
    await dev.close();
    const dev2 = await connectDevice(srv.url, DEV, SECRET);
    await dev2.hello({ fw: '0.2.0' });
    await dev2.next('config');
    await expect(dev2.next('cmd', 300)).rejects.toThrow('timed out');
    await dev2.close();
  });
});
