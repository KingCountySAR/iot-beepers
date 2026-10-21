import { createHash } from 'node:crypto';

/** Must match PROJECT_NAME in firmware/CMakeLists.txt. */
export const FIRMWARE_PROJECT = 'sar-notifier';

export interface AppDescription {
  version: string;
  project: string;
  idfVersion: string;
  sha256: string;
  size: number;
}

const cstr = (buf: Buffer, start: number, len: number) => {
  const slice = buf.subarray(start, start + len);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? len : end).toString('utf8');
};

/**
 * Read the esp_app_desc_t embedded in an ESP-IDF app image so uploads can't be
 * mislabelled. Layout: 24-byte image header, 8-byte segment header, then the app
 * description (magic 0xABCD5432, version[32] at +16, project_name[32] at +48,
 * idf_ver[32] at +112).
 */
export function parseAppImage(image: Buffer): AppDescription {
  if (image.length < 256 || image[0] !== 0xe9) throw new Error('Not an ESP32 app image');
  const desc = 32;
  if (image.readUInt32LE(desc) !== 0xabcd5432) throw new Error('App description not found');
  return {
    version: cstr(image, desc + 16, 32),
    project: cstr(image, desc + 48, 32),
    idfVersion: cstr(image, desc + 112, 32),
    sha256: createHash('sha256').update(image).digest('hex'),
    size: image.length,
  };
}
