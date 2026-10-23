import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AmbiguousEmail, type Member, type MemberDirectory } from '../src/memberdb.js';
import { connectDevice, httpClient, startServer } from './harness.js';

/** A member database we control. */
class FakeDirectory implements MemberDirectory {
  members: (Member & { emails: string[] })[] = [];
  down = false;
  /** Groups to leave out of membersOf answers, as if the API didn't know them. */
  unanswered = new Set<string>();

  private check() {
    if (this.down) throw new Error('member API down');
  }
  async findByEmail(email: string) {
    this.check();
    const matches = this.members.filter((m) => m.emails.includes(email));
    if (matches.length > 1) throw new AmbiguousEmail(email);
    return matches[0] ?? null;
  }
  async get(id: string) {
    this.check();
    return this.members.find((m) => m.id === id) ?? null;
  }
  async membersOf(names: string[]) {
    this.check();
    return new Map(
      names
        .filter((n) => !this.unanswered.has(n))
        .map((n) => [n, this.members.filter((m) => m.groups.includes(n)).map((m) => m.id)]),
    );
  }
}

const DEV = 'c1c2c3d4e5f6';
const SECRET = 'c'.repeat(64);

describe('members and channel access', () => {
  const directory = new FakeDirectory();
  const pat = { id: '1001', name: 'Pat Doe', emails: ['pat@example.com', 'pat.doe@gmail.com'], groups: ['Field Team', 'Trainees'] };
  let srv: Awaited<ReturnType<typeof startServer>>;
  let admin: ReturnType<typeof httpClient>;
  let member: ReturnType<typeof httpClient>;
  let field: number, training: number, command: number;

  beforeAll(async () => {
    directory.members = [{ id: '1', name: 'Ada Admin', emails: ['admin@example.com'], groups: [] }, pat];
    // No ALLOWED_DOMAINS: any account the member database knows may sign in. And no caching of
    // groups between requests, so each change shows up right away.
    srv = await startServer({ ALLOWED_DOMAINS: '', MEMBER_GROUPS_MAX_AGE_MIN: '0.0001' }, { directory });
    admin = httpClient(srv.url);
    expect((await admin('POST', '/api/auth/dev-login', { email: 'admin@example.com' })).status).toBe(200);
    const mk = async (slug: string) => (await admin('POST', '/api/channels', { slug, name: slug })).body.id as number;
    [field, training, command] = [await mk('field'), await mk('training'), await mk('command')];

    // Groups are matched ignoring case.
    expect((await admin('POST', '/api/access/groups', { groupName: 'field team', channelId: field })).status).toBe(201);
    await admin('POST', '/api/access/groups', { groupName: 'Field Team', channelId: field }); // no duplicate
    await admin('POST', '/api/access/groups', { groupName: 'Trainees', channelId: training });

    member = httpClient(srv.url);
    await member('POST', '/api/auth/dev-login', { email: 'pat@example.com', name: 'Pat (Google)' });
    const reg = await member('POST', '/api/device/register', { id: DEV, secret: SECRET, fw: '0.1.0' });
    expect((await member('POST', '/api/pair', { code: reg.body.claimCode })).status).toBe(200);
  });

  afterAll(() => srv.stop());

  it("keys users by member id, whichever of their Google accounts they use", async () => {
    const me = (await member('GET', '/api/auth/me')).body;
    // The member database's name wins over Google's.
    expect(me).toEqual({ id: '1001', email: 'pat@example.com', displayName: 'Pat Doe', isAdmin: false });

    const personal = httpClient(srv.url);
    expect((await personal('POST', '/api/auth/dev-login', { email: 'Pat.Doe@gmail.com' })).status).toBe(200);
    expect((await personal('GET', '/api/auth/me')).body).toMatchObject({ id: '1001', email: 'pat.doe@gmail.com' });
    expect((await personal('GET', '/api/devices')).body.map((d: { id: string }) => d.id)).toEqual([DEV]);

    const users = (await admin('GET', '/api/users')).body;
    expect(users.find((u: { id: string }) => u.id === '1001').logins.map((l: { email: string }) => l.email)).toEqual([
      'pat.doe@gmail.com',
      'pat@example.com',
    ]);
  });

  it("refuses accounts the member database doesn't know", async () => {
    const stranger = httpClient(srv.url);
    const res = await stranger('POST', '/api/auth/dev-login', { email: 'kim@example.com' });
    expect(res).toMatchObject({ status: 403, body: { error: "The member database doesn't know that account" } });
  });

  it('refuses an email several members share', async () => {
    directory.members.push(
      { id: '2001', name: 'Bo Baker', emails: ['family@example.com'], groups: [] },
      { id: '2002', name: 'Cy Baker', emails: ['family@example.com'], groups: [] },
    );
    const res = await httpClient(srv.url)('POST', '/api/auth/dev-login', { email: 'family@example.com' });
    expect(res).toMatchObject({ status: 403, body: { error: 'Several members share that email in the member database' } });
  });

  it('lets known accounts in while the member database is down, but not new ones', async () => {
    directory.down = true;
    expect((await httpClient(srv.url)('POST', '/api/auth/dev-login', { email: 'pat@example.com' })).status).toBe(200);
    directory.members.push({ id: '1002', name: 'Lee', emails: ['lee@example.com'], groups: [] });
    expect((await httpClient(srv.url)('POST', '/api/auth/dev-login', { email: 'lee@example.com' })).status).toBe(503);
    directory.down = false;
  });

  it('lets members join only the channels their groups or grants allow', async () => {
    expect((await member('GET', '/api/me/channels')).body.sort()).toEqual([field, training].sort());
    expect((await member('PATCH', `/api/devices/${DEV}`, { channelIds: [field, training] })).status).toBe(200);

    const denied = await member('PATCH', `/api/devices/${DEV}`, { channelIds: [field, command] });
    expect(denied).toMatchObject({ status: 403, body: { error: "You can't join: command" } });

    // Grants are for existing users, by member id.
    expect((await admin('POST', '/api/access/grants', { userId: 'nobody', channelId: command })).status).toBe(404);
    expect((await admin('POST', '/api/access/grants', { userId: '1001', channelId: command })).status).toBe(201);
    expect((await member('PATCH', `/api/devices/${DEV}`, { channelIds: [field, training, command] })).status).toBe(200);
  });

  it('falls back to the last known groups while the member database is down', async () => {
    directory.down = true;
    expect((await member('GET', '/api/me/channels')).body).toContain(field);
    directory.down = false;
  });

  it('sync drops subscriptions people no longer qualify for and tells the pager', async () => {
    const dev = await connectDevice(srv.url, DEV, SECRET);
    await dev.hello();
    await dev.next('config');

    pat.groups = []; // Pat left both groups...
    directory.unanswered.add('Trainees'); // ...but the API didn't answer for Trainees this time
    const status = (await admin('POST', '/api/access/sync')).body;
    expect(status).toMatchObject({ ok: true, groups: 1, usersChanged: 1 });
    // Trainees wasn't answered, so Pat keeps it; the grant keeps command.
    expect(status.removed).toEqual([{ deviceId: DEV, userId: '1001', name: 'Pat Doe', channel: 'field' }]);
    expect((await dev.next('config')).channels.sort()).toEqual(['command', 'training']);

    const detail = await admin('GET', `/api/devices/${DEV}`);
    expect(detail.body.events[0]).toMatchObject({ type: 'channel_removed', detail: 'field: Pat Doe no longer has access' });
    expect((await admin('GET', '/api/access')).body.lastSync).toMatchObject({ ok: true, groups: 1 });

    // Removing a grant takes effect right away, without waiting for the sync.
    const ungrant = await admin('DELETE', '/api/access/grants', { userId: '1001', channelId: command });
    expect(ungrant.body.removed).toEqual([{ deviceId: DEV, userId: '1001', name: 'Pat Doe', channel: 'command' }]);
    expect((await dev.next('config')).channels).toEqual(['training']);
    await dev.close();
  });

  it('a failed sync changes nothing', async () => {
    directory.down = true;
    const status = (await admin('POST', '/api/access/sync')).body;
    expect(status).toMatchObject({ ok: false, error: 'member API down', removed: [] });
    expect((await admin('GET', `/api/devices/${DEV}`)).body.channelIds).toEqual([training]);
    directory.down = false;
  });

  it("only shows members pages for channels they may join", async () => {
    pat.groups = ['Trainees']; // so Pat may join training, and not command
    // Someone else's pager on training too.
    const reg = await admin('POST', '/api/device/register', { id: 'd1d2d3d4e5f6', secret: 'd'.repeat(64), fw: '0.1.0' });
    await admin('POST', '/api/pair', { code: reg.body.claimCode, name: "Ada's pager" });
    await admin('PATCH', '/api/devices/d1d2d3d4e5f6', { channelIds: [training] });

    const mine = (await admin('POST', '/api/pages', { channelId: training, body: 'Training tonight' })).body.id;

    // Pat sees only Pat's own pager's delivery and ack; an admin sees both pagers.
    const patView = (await member('GET', `/api/pages/${mine}`)).body.deliveries.map((d: { deviceId: string }) => d.deviceId);
    expect(patView).toEqual([DEV]);
    const adminView = (await admin('GET', `/api/pages/${mine}`)).body.deliveries.map((d: { deviceId: string }) => d.deviceId);
    expect(adminView.sort()).toEqual([DEV, 'd1d2d3d4e5f6'].sort());
    const counts = async (who: typeof admin) =>
      (await who('GET', '/api/pages')).body.find((p: { id: number }) => p.id === mine).targets;
    expect([await counts(member), await counts(admin)]).toEqual([1, 2]);
    const theirs = (await admin('POST', '/api/pages', { channelId: command, body: 'Command staff only' })).body.id;

    const seen = (await member('GET', '/api/pages')).body.map((p: { id: number }) => p.id);
    expect(seen).toContain(mine);
    expect(seen).not.toContain(theirs);
    expect((await member('GET', `/api/pages/${mine}`)).status).toBe(200);
    expect((await member('GET', `/api/pages/${theirs}`)).status).toBe(404);

    expect((await admin('GET', '/api/pages')).body.map((p: { id: number }) => p.id)).toEqual(expect.arrayContaining([mine, theirs]));
    expect((await admin('GET', `/api/pages/${theirs}`)).status).toBe(200);
  });

  it('only admins manage access', async () => {
    expect((await member('GET', '/api/access')).status).toBe(403);
    expect((await member('POST', '/api/access/grants', { userId: '1001', channelId: field })).status).toBe(403);
    expect((await member('POST', '/api/access/sync')).status).toBe(403);
  });
});
