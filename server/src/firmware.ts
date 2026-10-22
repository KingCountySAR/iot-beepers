import { createHash } from 'node:crypto';

/** Must match PROJECT_NAME in firmware/CMakeLists.txt. */
export const FIRMWARE_PROJECT = 'sar-notifier';

/** Marker the firmware embeds (app_main.c), followed by CONFIG_NOTIFIER_BOARD. */
const BOARD_TAG = Buffer.from('SAR_BOARD=');

/** esp_image_header_t chip_id values. */
const CHIPS: Record<number, string> = { 0: 'esp32', 2: 'esp32s2', 5: 'esp32c3', 9: 'esp32s3', 13: 'esp32c6' };

export interface AppDescription {
  version: string;
  project: string;
  idfVersion: string;
  board: string;
  chip: string;
  sha256: string;
  size: number;
}

/** Where the browser flasher writes each part. NVS is left alone so pagers keep their identity. */
export interface FlashLayout {
  bootloaderOffset: number;
  partitionTableOffset: number;
  otadataOffset: number;
  otadataSize: number;
  appOffset: number;
}

export interface FirmwareUpload {
  desc: AppDescription;
  app: Buffer;
  /** Present when a merged (full flash) image was uploaded. */
  flash: { layout: FlashLayout; bootloader: Buffer; partitionTable: Buffer } | null;
}

const cstr = (buf: Buffer, start: number, len: number) => {
  const slice = buf.subarray(start, start + len);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? len : end).toString('utf8');
};

const APP_DESC_MAGIC = 0xabcd5432;
const isApp = (buf: Buffer, at = 0) =>
  buf.length >= at + 256 && buf[at] === 0xe9 && buf.readUInt32LE(at + 32) === APP_DESC_MAGIC;

/**
 * Length of the ESP image starting at `at`: 24-byte header, then segments (8-byte header
 * plus data), a checksum byte padded to a 16-byte boundary, and an optional SHA-256.
 */
export function imageLength(buf: Buffer, at = 0): number {
  if (buf[at] !== 0xe9) throw new Error(`No ESP image at 0x${at.toString(16)}`);
  const segments = buf[at + 1]!;
  let pos = at + 24;
  for (let i = 0; i < segments; i++) {
    if (pos + 8 > buf.length) throw new Error('Truncated image');
    pos += 8 + buf.readUInt32LE(pos + 4);
  }
  pos += 16 - ((pos - at) % 16); // padding, with the checksum in the last byte
  if (buf[at + 23] === 1) pos += 32;
  if (pos > buf.length) throw new Error('Truncated image');
  return pos - at;
}

/**
 * Read the esp_app_desc_t embedded in an ESP-IDF app image so uploads can't be
 * mislabelled. Layout: 24-byte image header (chip_id at +12), 8-byte segment header, then
 * the app description (magic 0xABCD5432, version[32] at +16, project_name[32] at +48,
 * idf_ver[32] at +112).
 */
export function parseAppImage(image: Buffer): AppDescription {
  if (!isApp(image)) throw new Error('Not an ESP32 app image');
  const desc = 32;
  const tag = image.indexOf(BOARD_TAG);
  if (tag === -1) throw new Error('Image has no board ID (built before boards were added?)');
  const chip = CHIPS[image.readUInt16LE(12)];
  if (!chip) throw new Error(`Unknown chip id ${image.readUInt16LE(12)}`);
  return {
    version: cstr(image, desc + 16, 32),
    project: cstr(image, desc + 48, 32),
    idfVersion: cstr(image, desc + 112, 32),
    board: cstr(image, tag + BOARD_TAG.length, 32),
    chip,
    sha256: createHash('sha256').update(image).digest('hex'),
    size: image.length,
  };
}

const PARTITION_TABLE_OFFSET = 0x8000;
const PARTITION_TABLE_SIZE = 0xc00;

/**
 * Accept either a bare app image (OTA only) or a merged full-flash image from
 * `esptool merge_bin` (firmware/build.sh), which the browser flasher can also use.
 */
export function parseFirmwareUpload(buf: Buffer): FirmwareUpload {
  if (isApp(buf)) return { desc: parseAppImage(buf), app: buf, flash: null };

  // Merged image: bootloader at 0x1000 (ESP32, S2) or 0x0, partition table at 0x8000.
  const bootloaderOffset = buf[0] === 0xe9 ? 0 : 0x1000;
  if (buf[bootloaderOffset] !== 0xe9 || buf.length < PARTITION_TABLE_OFFSET + PARTITION_TABLE_SIZE) {
    throw new Error('Not an ESP32 app image or merged flash image');
  }
  const bootloader = buf.subarray(bootloaderOffset, bootloaderOffset + imageLength(buf, bootloaderOffset));
  const partitionTable = buf.subarray(PARTITION_TABLE_OFFSET, PARTITION_TABLE_OFFSET + PARTITION_TABLE_SIZE);

  let appOffset: number | undefined;
  let otadata: { offset: number; size: number } | undefined;
  for (let p = 0; p + 32 <= partitionTable.length; p += 32) {
    if (partitionTable.readUInt16LE(p) !== 0x50aa) break; // end of entries (or the MD5 row)
    const [type, subtype] = [partitionTable[p + 2], partitionTable[p + 3]];
    const offset = partitionTable.readUInt32LE(p + 4);
    const size = partitionTable.readUInt32LE(p + 8);
    if (type === 0 && (subtype === 0x10 || subtype === 0x00) && appOffset === undefined) appOffset = offset;
    if (type === 1 && subtype === 0) otadata = { offset, size };
  }
  if (appOffset === undefined || !otadata) throw new Error('Partition table has no app or otadata partition');
  if (!isApp(buf, appOffset)) throw new Error(`No app image at 0x${appOffset.toString(16)}`);
  const app = Buffer.from(buf.subarray(appOffset, appOffset + imageLength(buf, appOffset)));

  return {
    desc: parseAppImage(app),
    app,
    flash: {
      layout: {
        bootloaderOffset,
        partitionTableOffset: PARTITION_TABLE_OFFSET,
        otadataOffset: otadata.offset,
        otadataSize: otadata.size,
        appOffset,
      },
      bootloader: Buffer.from(bootloader),
      partitionTable: Buffer.from(partitionTable),
    },
  };
}
