/**
 * Device <-> server MQTT protocol. Keep in sync with docs/protocol.md and
 * firmware/main/protocol.h.
 *
 * Server -> device (device subscribes to dev/{id}/#):
 *   dev/{id}/config  DeviceConfig
 *   dev/{id}/page    PageMessage
 *   dev/{id}/cmd     Command
 * Device -> server:
 *   dev/{id}/status  StatusMessage   (hello on every connect, then heartbeat every 60s)
 *   dev/{id}/ack     AckMessage
 *   dev/{id}/event   EventMessage    (OTA progress, rollbacks, errors)
 */
import { z } from 'zod';

export const topic = {
  config: (id: string) => `dev/${id}/config`,
  page: (id: string) => `dev/${id}/page`,
  cmd: (id: string) => `dev/${id}/cmd`,
};

/** Device ids are the lowercase hex MAC address. */
export const DEVICE_ID_RE = /^[0-9a-f]{12}$/;

/** Max characters of page text sent to devices; keeps payloads under the firmware's MQTT buffer. */
export const MAX_PAGE_TEXT = 400;

export const StatusMessage = z.object({
  type: z.enum(['hello', 'heartbeat']),
  fw: z.string().max(32),
  hw: z.string().max(32).optional(),
  reset: z.string().max(32).optional(),
  armed: z.boolean(),
  rssi: z.number().int().optional(),
  ip: z.string().max(45).optional(),
  uptime: z.number().int().nonnegative().optional(),
  heap: z.number().int().nonnegative().optional(),
});
export type StatusMessage = z.infer<typeof StatusMessage>;

export const AckMessage = z.object({
  page: z.number().int(),
  /** "received" is sent automatically on arrival; "acked" when the member presses the button. */
  state: z.enum(['received', 'acked']),
});
export type AckMessage = z.infer<typeof AckMessage>;

export const EventMessage = z.object({
  type: z.string().max(32),
  detail: z.string().max(200).default(''),
});

export interface DeviceConfig {
  claimed: boolean;
  name: string;
  channels: string[];
}

/**
 * A tune in RTTTL, the old phone-ringtone notation: "name:d=<len>,o=<octave>,b=<bpm>:notes".
 * Each note is [length]letter[#][.][octave], "p" is a rest. Pagers play up to 64 notes, in
 * place of their built-in beeps.
 */
export const Rtttl = z
  .string()
  .max(400)
  .regex(/^[^:]{0,32}:(\s*[dob]=\d+\s*,?)*\s*:(\s*\d*[a-gp]#?\.?\d?\.?\s*,?)+\s*$/i, 'not an RTTTL tune');

/**
 * A traditional pager alert: a fast high warble twice, then a rising arpeggio. Written for
 * the 2-3 kHz range where small buzzers are loudest. Repeats for the length of the alarm.
 */
export const PAGER_TUNE = 'pager:d=32,o=7,b=125:e,g,e,g,e,g,e,g,8p,e,g,e,g,e,g,e,g,8p,16c,16e,16g,8c8,2p';

export interface PageMessage {
  id: number;
  ch: string;
  title: string;
  body: string;
  /** False for stale pages replayed after a reconnect: flash the LED but don't sound the alarm. */
  alarm: boolean;
  /** Unix seconds when the page was created. */
  ts: number;
  /** RTTTL tune for the alarm; the pager uses its built-in beeps without one. */
  tune?: string;
}

export type Command =
  | { cmd: 'test'; tune?: string }
  | { cmd: 'identify' }
  | { cmd: 'reboot' }
  | { cmd: 'ota'; version: string; url: string; sha256: string; size: number };
