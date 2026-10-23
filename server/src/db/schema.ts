import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import type { FlashLayout } from '../firmware.js';

const ts = (name: string) => timestamp(name, { withTimezone: true });

const bytea = customType<{ data: Buffer; driverData: Buffer | Uint8Array }>({
  dataType: () => 'bytea',
  fromDriver: (v) => Buffer.from(v),
});

/** A team member, keyed by their member database id (see memberdb.ts). */
export const users = pgTable('users', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  /** Groups from the member database (see memberdb.ts), as of groupsCheckedAt. */
  groups: text('groups').array().notNull().default([]),
  groupsCheckedAt: ts('groups_checked_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

/** Google accounts a member signs in with; a member can have several. */
export const userLogins = pgTable('user_logins', {
  /** Lowercase Google account email. */
  email: text('email').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  lastLoginAt: ts('last_login_at').notNull().defaultNow(),
});

export const sessions = pgTable('sessions', {
  /** sha256 of the session token; the raw token only lives in the cookie. */
  tokenHash: text('token_hash').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** The Google account this session signed in with. */
  email: text('email').notNull(),
  expiresAt: ts('expires_at').notNull(),
});

export const channels = pgTable('channels', {
  id: serial('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  createdAt: ts('created_at').notNull().defaultNow(),
});

/** Members of a member-database group may subscribe their pagers to the channel. */
export const groupChannels = pgTable(
  'group_channels',
  {
    /** As the member database spells it; matched ignoring case. */
    groupName: text('group_name').notNull(),
    channelId: integer('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.groupName, t.channelId] })],
);

/** Admin-granted access to a channel for one person, regardless of their groups. */
export const channelGrants = pgTable(
  'channel_grants',
  {
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    channelId: integer('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.channelId] })],
);

export const devices = pgTable('devices', {
  /** Factory-unique id derived from the ESP32 MAC, e.g. "a1b2c3d4e5f6". */
  id: text('id').primaryKey(),
  /** sha256 of the device's random secret. Null means "accept the next secret" (admin reset). */
  secretHash: text('secret_hash'),
  ownerId: text('owner_id').references(() => users.id, { onDelete: 'set null' }),
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
  /** Board ID (CONFIG_NOTIFIER_BOARD) from the device; selects which firmware it gets. */
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
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
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

/** One row per board and version: the pins are compiled in, so images aren't interchangeable. */
export const firmware = pgTable(
  'firmware',
  {
    /** CONFIG_NOTIFIER_BOARD, read from the image. Devices report it as `hw`. */
    board: text('board').notNull(),
    version: text('version').notNull(),
    chip: text('chip').notNull(),
    sha256: text('sha256').notNull(),
    size: integer('size').notNull(),
    idfVersion: text('idf_version').notNull().default(''),
    notes: text('notes').notNull().default(''),
    /** The app image itself, for OTA. Kept in the DB so the app container stays stateless. */
    image: bytea('image').notNull(),
    /** Set when a merged image was uploaded; the browser flasher needs these too. */
    bootloader: bytea('bootloader'),
    partitionTable: bytea('partition_table'),
    flashLayout: jsonb('flash_layout').$type<FlashLayout>(),
    uploadedAt: ts('uploaded_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.board, t.version] })],
);

/** Small key/value store for server-wide settings (e.g. the default firmware version). */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});
