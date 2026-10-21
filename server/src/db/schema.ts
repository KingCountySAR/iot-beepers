import {
  boolean,
  customType,
  index,
  integer,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true });

const bytea = customType<{ data: Buffer; driverData: Buffer | Uint8Array }>({
  dataType: () => 'bytea',
  fromDriver: (v) => Buffer.from(v),
});

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  username: text('username').notNull().unique(),
  displayName: text('display_name').notNull(),
  passwordHash: text('password_hash').notNull(),
  isAdmin: boolean('is_admin').notNull().default(false),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const sessions = pgTable('sessions', {
  /** sha256 of the session token; the raw token only lives in the cookie. */
  tokenHash: text('token_hash').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: ts('expires_at').notNull(),
});

export const channels = pgTable('channels', {
  id: serial('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const devices = pgTable('devices', {
  /** Factory-unique id derived from the ESP32 MAC, e.g. "a1b2c3d4e5f6". */
  id: text('id').primaryKey(),
  /** sha256 of the device's random secret. Null means "accept the next secret" (admin reset). */
  secretHash: text('secret_hash'),
  ownerId: integer('owner_id').references(() => users.id, { onDelete: 'set null' }),
  name: text('name').notNull().default(''),
  claimCode: text('claim_code').unique(),
  claimExpiresAt: ts('claim_expires_at'),
  claimedAt: ts('claimed_at'),
  createdAt: ts('created_at').notNull().defaultNow(),

  // Latest telemetry
  online: boolean('online').notNull().default(false),
  lastSeenAt: ts('last_seen_at'),
  lastConnectAt: ts('last_connect_at'),
  fwVersion: text('fw_version'),
  hwRev: text('hw_rev'),
  ip: text('ip'),
  rssi: integer('rssi'),
  uptimeS: integer('uptime_s'),
  freeHeap: integer('free_heap'),
  armed: boolean('armed'),
  resetReason: text('reset_reason'),

  // OTA
  fwTarget: text('fw_target'),
  otaRequestedAt: ts('ota_requested_at'),
});

export const deviceChannels = pgTable(
  'device_channels',
  {
    deviceId: text('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
    channelId: integer('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.deviceId, t.channelId] })],
);

export const deviceEvents = pgTable(
  'device_events',
  {
    id: serial('id').primaryKey(),
    deviceId: text('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
    at: ts('at').notNull().defaultNow(),
    type: text('type').notNull(),
    detail: text('detail').notNull().default(''),
  },
  (t) => [index('device_events_device_at').on(t.deviceId, t.at)],
);

export const pages = pgTable(
  'pages',
  {
    id: serial('id').primaryKey(),
    channelId: integer('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default(''),
    body: text('body').notNull(),
    /** Where the page came from: "web", "api", later "email"/"sms". */
    source: text('source').notNull(),
    createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [index('pages_created_at').on(t.createdAt)],
);

export const deliveries = pgTable(
  'deliveries',
  {
    pageId: integer('page_id').notNull().references(() => pages.id, { onDelete: 'cascade' }),
    deviceId: text('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
    sentAt: ts('sent_at'),
    receivedAt: ts('received_at'),
    ackedAt: ts('acked_at'),
  },
  (t) => [primaryKey({ columns: [t.pageId, t.deviceId] })],
);

export const firmware = pgTable('firmware', {
  version: text('version').primaryKey(),
  sha256: text('sha256').notNull(),
  size: integer('size').notNull(),
  idfVersion: text('idf_version').notNull().default(''),
  notes: text('notes').notNull().default(''),
  /** The app image itself. Kept in the DB so the app container stays stateless. */
  image: bytea('image').notNull(),
  uploadedAt: ts('uploaded_at').notNull().defaultNow(),
});

/** Small key/value store for server-wide settings (e.g. the default firmware version). */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});
