import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIRMWARE_PROJECT, parseAppImage, parseFirmwareUpload } from '../src/firmware.js';
import { connectDevice, httpClient, startServer } from './harness.js';

const CHIP_ID = { esp32: 0, esp32c3: 5 } as const;

/**
 * Minimal valid ESP-IDF app image: one segment whose data starts with the esp_app_desc_t
 * (so it lands at offset 32) and contains the SAR_BOARD= marker.
 */
function fakeApp(version: string, { board = 'xiao-c3', chip = 'esp32c3' as keyof typeof CHIP_ID, project = FIRMWARE_PROJECT } = {}) {
  const data = Buffer.alloc(992);
  data.writeUInt32LE(0xabcd5432, 0);
  data.write(version, 16);
  data.write(project, 48);
  data.write('v5.5.1', 112);
  data.write(`SAR_BOARD=${board}\0`, 400);
  const header = Buffer.alloc(24);
  header[0] = 0xe9;
  header[1] = 1;
  header.writeUInt16LE(CHIP_ID[chip], 12);
  const seg = Buffer.alloc(8);
  seg.writeUInt32LE(0x3c000020, 0);
  seg.writeUInt32LE(data.length, 4);
  const body = Buffer.concat([header, seg, data]);
  return Buffer.concat([body, Buffer.alloc(16 - (body.length % 16))]); // checksum padding
}

/** Like `esptool merge_bin`: bootloader, partition table and app at their flash offsets. */
function fakeMerged(app: Buffer, bootloaderOffset = 0) {
  const APP = 0x20000;
  const img = Buffer.alloc(APP + app.length, 0xff);
  const boot = Buffer.alloc(32);
  boot[0] = 0xe9; // no segments: 24-byte header padded to 32
  boot.copy(img, bootloaderOffset);
  const entry = (i: number, type: number, subtype: number, offset: number, size: number) => {
    const p = 0x8000 + i * 32;
    img.writeUInt16LE(0x50aa, p);
    img[p + 2] = type;
    img[p + 3] = subtype;
    img.writeUInt32LE(offset, p + 4);
    img.writeUInt32LE(size, p + 8);
  };
  entry(0, 1, 2, 0x9000, 0x6000); // nvs
  entry(1, 1, 0, 0xf000, 0x2000); // otadata
  entry(2, 0, 0x10, APP, 0x1e0000); // ota_0
  app.copy(img, APP);
  return img;
}

describe('firmware images', () => {
  it('reads the embedded app description, board and chip', () => {
    const img = fakeApp('1.2.3');
    expect(parseAppImage(img)).toEqual({
      version: '1.2.3',
      project: FIRMWARE_PROJECT,
      idfVersion: 'v5.5.1',
      board: 'xiao-c3',
      chip: 'esp32c3',
      size: img.length,
      sha256: createHash('sha256').update(img).digest('hex'),
    });
  });

  it('splits a merged image into the flasher parts and the OTA app', () => {
    const app = fakeApp('1.2.3', { board: 'devkit-v1', chip: 'esp32' });
    const up = parseFirmwareUpload(fakeMerged(app, 0x1000));
    expect(up.app.equals(app)).toBe(true);
    expect(up.desc).toMatchObject({ board: 'devkit-v1', chip: 'esp32' });
    expect(up.flash?.layout).toEqual({
      bootloaderOffset: 0x1000,
      partitionTableOffset: 0x8000,
      otadataOffset: 0xf000,
      otadataSize: 0x2000,
      appOffset: 0x20000,
    });
    expect(up.flash?.bootloader.length).toBe(32);
  });

  it('rejects non-images and images without a board ID', () => {
    expect(() => parseFirmwareUpload(Buffer.alloc(1024))).toThrow();
    const untagged = fakeApp('1.2.3');
    untagged.fill(0, untagged.indexOf('SAR_BOARD='));
    expect(() => parseAppImage(untagged)).toThrow('board');
  });
});

describe('OTA rollout', () => {
  const XIAO = '0123456789ab';
  const DEVKIT = '0123456789ac';
  const SECRET = 'a'.repeat(64);
  let srv: Awaited<ReturnType<typeof startServer>>;
  let admin: ReturnType<typeof httpClient>;

  beforeAll(async () => {
    srv = await startServer();
    admin = httpClient(srv.url);
    await admin('POST', '/api/auth/login', { username: 'admin', password: 'admin-pass' });
    await admin('POST', '/api/device/register', { id: XIAO, secret: SECRET });
    await admin('POST', '/api/device/register', { id: DEVKIT, secret: SECRET });
  });
  afterAll(() => srv.stop());

  const upload = (img: Buffer) => {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(img)]), 'app.bin');
    return admin('POST', '/api/firmware', form);
  };

  it('validates uploads, one version per board', async () => {
    expect((await upload(fakeApp('0.2.0', { project: 'other-project' }))).status).toBe(400);
    expect((await upload(fakeApp('0.2.0'))).status).toBe(201);
    expect((await upload(fakeApp('0.2.0'))).status).toBe(409);
    const devkit = await upload(fakeMerged(fakeApp('0.2.0', { board: 'devkit-v1', chip: 'esp32' }), 0x1000));
    expect(devkit.status).toBe(201);
    expect(devkit.body).toMatchObject({ board: 'devkit-v1', flashable: true });
  });

  it("updates only devices of the default's board, and serves the image", async () => {
    const xiao = await connectDevice(srv.url, XIAO, SECRET);
    await xiao.hello({ fw: '0.1.0', hw: 'xiao-c3' });
    await xiao.next('config');
    const devkit = await connectDevice(srv.url, DEVKIT, SECRET);
    await devkit.hello({ fw: '0.1.0', hw: 'devkit-v1' });
    await devkit.next('config');

    const res = await admin('PUT', '/api/firmware/default', { board: 'xiao-c3', version: '0.2.0' });
    expect(res.body.started).toBe(1);
    const cmd = await xiao.next('cmd');
    expect(cmd).toMatchObject({ cmd: 'ota', version: '0.2.0', size: fakeApp('0.2.0').length });
    expect(cmd.url).toContain('/api/device/firmware/xiao-c3/0.2.0');
    await expect(devkit.next('cmd', 300)).rejects.toThrow('timed out');

    const bin = Buffer.from(await (await fetch(cmd.url)).arrayBuffer());
    expect(createHash('sha256').update(bin).digest('hex')).toBe(cmd.sha256);

    // Up-to-date devices are left alone.
    await xiao.close();
    const again = await connectDevice(srv.url, XIAO, SECRET);
    await again.hello({ fw: '0.2.0', hw: 'xiao-c3' });
    await again.next('config');
    await expect(again.next('cmd', 300)).rejects.toThrow('timed out');
    await again.close();
    await devkit.close();
  });

  it("won't pin a device to another board's image", async () => {
    expect((await admin('PUT', `/api/devices/${DEVKIT}/firmware-target`, { version: '9.9.9' })).status).toBe(404);
    expect((await admin('PUT', `/api/devices/${DEVKIT}/firmware-target`, { version: '0.2.0' })).status).toBe(200);
  });

  it('serves flasher parts for merged uploads only', async () => {
    const { boards, publicUrl } = (await admin('GET', '/api/flash')).body;
    expect(publicUrl).toBe(srv.url);
    expect(boards).toHaveLength(1);
    expect(boards[0]).toMatchObject({ board: 'devkit-v1', chip: 'esp32', default: null });
    expect(boards[0].images[0]).toMatchObject({ version: '0.2.0', layout: { bootloaderOffset: 0x1000 } });

    const part = await fetch(`${srv.url}/api/flash/devkit-v1/0.2.0/bootloader`);
    expect(part.status).toBe(401); // needs a login
    const app = await admin('GET', '/api/flash/devkit-v1/0.2.0/app');
    expect(app.status).toBe(200);
    expect((await admin('GET', '/api/flash/xiao-c3/0.2.0/bootloader')).status).toBe(404);
  });
});
