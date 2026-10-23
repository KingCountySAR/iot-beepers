import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { isSiteAdmin } from './auth.js';
import type { Config } from './config.js';
import type { Db } from './db/index.js';
import {
  channelGrants,
  channels,
  deviceChannels,
  devices,
  groupChannels,
  settings,
  userLogins,
  users,
} from './db/schema.js';
import type { Hub } from './hub.js';
import { AmbiguousEmail, type Member, type MemberDirectory } from './memberdb.js';

/**
 * Who may sign in, and who may subscribe their pagers to which channels.
 *
 * Users are members, keyed by their member database id; each Google account they sign in
 * with is a login linked to that id. A member may join a channel if one of their groups maps
 * to it (group_channels) or an admin granted it to them (channel_grants). Admins may join
 * anything.
 *
 * Groups are checked live when a member signs in, and when they look at or change their
 * channels, and for everyone by sync() every MEMBER_SYNC_HOURS, which also unsubscribes
 * pagers whose owners no longer qualify.
 */
export const SYNC_STATUS_KEY = 'member_sync.last';

export interface SyncStatus {
  at: string;
  ok: boolean;
  error?: string;
  /** Mapped groups the member database answered for. */
  groups: number;
  usersChanged: number;
  removed: Removal[];
}

export interface Removal {
  deviceId: string;
  userId: string;
  name: string;
  channel: string;
}

/** Why sign-in was refused; also the ?login= code the UI explains. */
export type SignInRefusal = 'not-allowed' | 'not-a-member' | 'ambiguous' | 'unavailable';

const lower = (names: string[]) => names.map((n) => n.toLowerCase());

export class Access {
  constructor(
    private db: Db,
    private cfg: Config,
    private hub: Hub,
    readonly directory: MemberDirectory | null,
  ) {}

  /**
   * Signs in a Google account: it must be managed by one of ALLOWED_DOMAINS (its Workspace
   * `hostedDomain`, or be in SITE_ADMINS) and belong to a member. With no ALLOWED_DOMAINS, any
   * account the member database knows will do, personal ones included. Without a member
   * database (dev), each email is its own member.
   */
  async signIn(
    email: string,
    googleName: string,
    hostedDomain?: string,
  ): Promise<{ id: string; email: string } | SignInRefusal> {
    email = email.toLowerCase();
    const domainOk = this.cfg.ALLOWED_DOMAINS.length
      ? !!hostedDomain && this.cfg.ALLOWED_DOMAINS.includes(hostedDomain.toLowerCase())
      : !!this.directory;
    if (!domainOk && !isSiteAdmin(this.cfg, email)) return 'not-allowed';

    let member: Member | null;
    if (this.directory) {
      try {
        member = await this.directory.findByEmail(email);
      } catch (err) {
        if (err instanceof AmbiguousEmail) return 'ambiguous';
        // A known login can still get in while the member database is down; a new one can't.
        console.warn(`Member database lookup for ${email} failed:`, (err as Error).message);
        const [known] = await this.db.select().from(userLogins).where(eq(userLogins.email, email));
        if (!known) return 'unavailable';
        await this.db.update(userLogins).set({ lastLoginAt: new Date() }).where(eq(userLogins.email, email));
        return { id: known.userId, email };
      }
      if (!member) {
        // The account may have been unlinked from its member since it last signed in.
        await this.db.delete(userLogins).where(eq(userLogins.email, email));
        return 'not-a-member';
      }
    } else {
      member = { id: email, name: '', groups: [] };
    }

    const name = member.name || googleName;
    const fromDirectory = this.directory ? { groups: lower(member.groups), groupsCheckedAt: new Date() } : {};
    await this.db
      .insert(users)
      .values({ id: member.id, displayName: name || email, ...fromDirectory })
      .onConflictDoUpdate({
        target: users.id,
        // Without a name to go on, keep the one we have.
        set: { ...(name ? { displayName: name } : {}), ...fromDirectory, id: member.id },
      });
    await this.db
      .insert(userLogins)
      .values({ email, userId: member.id })
      .onConflictDoUpdate({ target: userLogins.email, set: { userId: member.id, lastLoginAt: new Date() } });
    return { id: member.id, email };
  }

  /** A user's groups (lowercase), refreshed from the member database when older than maxAgeMs. */
  async groupsOf(userId: string, maxAgeMs = this.cfg.MEMBER_GROUPS_MAX_AGE_MIN * 60_000): Promise<string[]> {
    const [row] = await this.db
      .select({ groups: users.groups, checkedAt: users.groupsCheckedAt })
      .from(users)
      .where(eq(users.id, userId));
    const cached = row?.groups ?? [];
    if (!this.directory || (row?.checkedAt && Date.now() - row.checkedAt.getTime() < maxAgeMs)) return cached;
    try {
      const member = await this.directory.get(userId);
      const groups = lower(member?.groups ?? []);
      await this.db.update(users).set({ groups, groupsCheckedAt: new Date() }).where(eq(users.id, userId));
      return groups;
    } catch (err) {
      // Better to go on what we last knew than to lock members out while the API is down.
      console.warn(`Member database lookup for ${userId} failed, using cached groups:`, (err as Error).message);
      return cached;
    }
  }

  /** Whether any of the member's Google accounts is in SITE_ADMINS. */
  async isAdmin(userId: string) {
    if (this.cfg.SITE_ADMINS.length === 0) return false;
    const [admin] = await this.db
      .select({ email: userLogins.email })
      .from(userLogins)
      .where(and(eq(userLogins.userId, userId), inArray(userLogins.email, this.cfg.SITE_ADMINS)))
      .limit(1);
    return !!admin;
  }

  /** Channel ids the user may subscribe to, or 'all' for admins. */
  async allowedChannels(userId: string, groups?: string[]): Promise<Set<number> | 'all'> {
    if (await this.isAdmin(userId)) return 'all';
    groups ??= await this.groupsOf(userId);
    const allowed = new Set<number>();
    for (const m of await this.db.select().from(groupChannels)) {
      if (groups.includes(m.groupName.toLowerCase())) allowed.add(m.channelId);
    }
    const grants = await this.db
      .select({ channelId: channelGrants.channelId })
      .from(channelGrants)
      .where(eq(channelGrants.userId, userId));
    for (const g of grants) allowed.add(g.channelId);
    return allowed;
  }

  /**
   * Unsubscribes pagers from channels their owners may no longer join, going by the groups
   * we last saw (no member database calls). Runs after sync() and after admins change access.
   */
  async enforce(): Promise<Removal[]> {
    const subs = await this.db
      .select({
        deviceId: deviceChannels.deviceId,
        channelId: deviceChannels.channelId,
        slug: channels.slug,
        userId: users.id,
        name: users.displayName,
        groups: users.groups,
      })
      .from(deviceChannels)
      .innerJoin(devices, eq(devices.id, deviceChannels.deviceId))
      .innerJoin(users, eq(users.id, devices.ownerId))
      .innerJoin(channels, eq(channels.id, deviceChannels.channelId))
      .where(isNotNull(devices.ownerId));

    const allowedByOwner = new Map<string, Set<number> | 'all'>();
    const removed: (Removal & { channelId: number })[] = [];
    for (const s of subs) {
      let allowed = allowedByOwner.get(s.userId);
      if (!allowed) {
        allowed = await this.allowedChannels(s.userId, s.groups);
        allowedByOwner.set(s.userId, allowed);
      }
      if (allowed !== 'all' && !allowed.has(s.channelId)) {
        removed.push({ deviceId: s.deviceId, userId: s.userId, name: s.name, channel: s.slug, channelId: s.channelId });
      }
    }

    for (const r of removed) {
      await this.db
        .delete(deviceChannels)
        .where(and(eq(deviceChannels.deviceId, r.deviceId), eq(deviceChannels.channelId, r.channelId)));
      await this.hub.logEvent(r.deviceId, 'channel_removed', `${r.channel}: ${r.name} no longer has access`);
    }
    for (const deviceId of new Set(removed.map((r) => r.deviceId))) await this.hub.sendConfig(deviceId);
    return removed.map(({ channelId: _, ...r }) => r);
  }

  /** Re-reads the members of every mapped group, then enforce()s. Records the outcome for the UI. */
  async sync(): Promise<SyncStatus> {
    const status: SyncStatus = { at: new Date().toISOString(), ok: true, groups: 0, usersChanged: 0, removed: [] };
    try {
      if (this.directory) {
        const mapped = [...new Set((await this.db.select().from(groupChannels)).map((g) => g.groupName))];
        const members = mapped.length ? await this.directory.membersOf(mapped) : new Map<string, string[]>();
        const answered = new Map([...members].map(([name, ids]) => [name.toLowerCase(), new Set(ids)]));
        status.groups = answered.size;
        for (const u of await this.db.select({ id: users.id, groups: users.groups }).from(users)) {
          // Only groups the database answered for change; anything else stays as we last saw it.
          const groups = [
            ...u.groups.filter((g) => !answered.has(g)),
            ...[...answered].filter(([, ids]) => ids.has(u.id)).map(([name]) => name),
          ].sort();
          const changed = groups.join('\n') !== [...u.groups].sort().join('\n');
          if (changed) status.usersChanged++;
          await this.db
            .update(users)
            .set({ ...(changed ? { groups } : {}), groupsCheckedAt: new Date() })
            .where(eq(users.id, u.id));
        }
      }
      status.removed = await this.enforce();
    } catch (err) {
      status.ok = false;
      status.error = (err as Error).message;
      console.error('Member sync failed:', status.error);
    }
    const value = JSON.stringify(status);
    await this.db
      .insert(settings)
      .values({ key: SYNC_STATUS_KEY, value })
      .onConflictDoUpdate({ target: settings.key, set: { value } });
    if (status.removed.length) console.log(`Member sync removed ${status.removed.length} subscription(s)`);
    return status;
  }

  async lastSync(): Promise<SyncStatus | null> {
    const [row] = await this.db.select().from(settings).where(eq(settings.key, SYNC_STATUS_KEY));
    return row ? (JSON.parse(row.value) as SyncStatus) : null;
  }
}
