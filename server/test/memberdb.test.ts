import { afterEach, describe, expect, it, vi } from 'vitest';
import { AmbiguousEmail, createMemberDirectory } from '../src/memberdb.js';

const cfg = {
  MEMBER_API_URL: 'https://cedar.test/api/v1/',
  MEMBER_API_TOKEN_URL: 'https://hydra.test/oauth2/token',
  MEMBER_API_CLIENT_ID: 'notifier',
  MEMBER_API_CLIENT_SECRET: 's&h:h', // characters that must be encoded
  MEMBER_API_SCOPE: 'members.read',
};

// Shaped like cedar's API.md.
const BOB = {
  d4hId: 1234,
  name: { full: 'Bob Adams', first: 'Bob', legalFirst: 'Robert', last: 'Adams' },
  emails: ['bob@example.org', 'bob@work.example'],
  groups: [{ groupId: 21, title: 'ESAR Field', bundle: 'ESAR Specific', unit: 'ESAR' }],
  units: [{ groupId: 20, title: 'ESAR', bundle: 'Units' }],
  qualifications: [],
};

/** A fake cedar and Hydra. Returns the requests made, as "METHOD path". */
function fakeCedar({ expireFirstToken = false } = {}) {
  const calls: string[] = [];
  let tokens = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
    if (url.href === cfg.MEMBER_API_TOKEN_URL) {
      // Hydra's default client authentication: HTTP Basic, not the secret in the body.
      expect(Object.fromEntries(new URLSearchParams(String(init!.body)))).toEqual({ grant_type: 'client_credentials', scope: 'members.read' });
      const basic = new Headers(init!.headers).get('authorization');
      expect(basic).toBe(`Basic ${Buffer.from('notifier:s%26h%3Ah').toString('base64')}`);
      return Response.json({ access_token: `token-${++tokens}`, expires_in: 3600, token_type: 'bearer' });
    }
    const auth = new Headers(init?.headers).get('authorization');
    if (expireFirstToken && auth === 'Bearer token-1') return Response.json({ error: 'invalid_token' }, { status: 401 });
    const path = decodeURIComponent(url.pathname.replace('/api/v1', ''));
    if (path === '/members/bob@example.org' || path === '/members/1234') return Response.json(BOB);
    if (path === '/members/family@example.org') return Response.json({ error: 'ambiguous', matches: [] }, { status: 409 });
    if (path === '/groups/ESAR Field/members' || path === '/groups/21/members') {
      return Response.json({ group: BOB.groups[0], results: [{ d4hId: 1234, name: { full: 'Bob Adams' } }, { d4hId: 77, name: { full: 'Al Zed' } }] });
    }
    if (path === '/groups/Untitled/members') return Response.json({ error: 'ambiguous' }, { status: 409 });
    return Response.json({ error: 'not_found' }, { status: 404 });
  });
  return calls;
}

describe('cedar member directory', () => {
  afterEach(() => vi.restoreAllMocks());

  it('finds members by email or D4H id, with groups by id and title', async () => {
    const calls = fakeCedar();
    const dir = createMemberDirectory(cfg)!;
    const bob = { id: '1234', name: 'Bob Adams', groups: ['21', 'ESAR Field'] };
    expect(await dir.findByEmail('bob@example.org')).toEqual(bob);
    expect(await dir.get('1234')).toEqual(bob);
    expect(await dir.findByEmail('nobody@example.org')).toBeNull();
    expect(await dir.get('99')).toBeNull();
    expect(await dir.get('dev@example.org')).toBeNull(); // not a D4H id: no request
    // One token for all of it.
    expect(calls.filter((c) => c.startsWith('POST'))).toHaveLength(1);
    expect(calls).toContain('GET /api/v1/members/bob%40example.org');
  });

  it('says so when several members share an email', async () => {
    fakeCedar();
    await expect(createMemberDirectory(cfg)!.findByEmail('family@example.org')).rejects.toBeInstanceOf(AmbiguousEmail);
  });

  it('lists group members, leaving out groups cedar can’t answer for', async () => {
    fakeCedar();
    const members = await createMemberDirectory(cfg)!.membersOf(['ESAR Field', '21', 'Typo Group', 'Untitled']);
    expect(members).toEqual(
      new Map([
        ['ESAR Field', ['1234', '77']],
        ['21', ['1234', '77']],
      ]),
    );
  });

  it('gets a new token when cedar turns one down', async () => {
    const calls = fakeCedar({ expireFirstToken: true });
    expect((await createMemberDirectory(cfg)!.get('1234'))?.name).toBe('Bob Adams');
    expect(calls.filter((c) => c.startsWith('POST'))).toHaveLength(2);
  });
});
