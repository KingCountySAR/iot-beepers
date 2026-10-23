import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GoogleIdentity } from '../src/google.js';
import { httpClient, startServer } from './harness.js';

describe('Google sign-in', () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  /** Stands in for Google: the "ID tokens" it accepts, and whose they are. */
  const tokens = new Map<string, GoogleIdentity>([
    ['admin-token', { email: 'admin@example.com', name: 'Ada Admin', hostedDomain: 'example.com' }],
    ['kim-token', { email: 'kim@example.com', name: 'Kim', hostedDomain: 'example.com' }],
    // A consumer account registered with a team-looking address: Google sets no hd for it.
    ['imposter-token', { email: 'boss@example.com', name: 'Not The Boss' }],
    ['outsider-token', { email: 'lee@elsewhere.org', name: 'Lee', hostedDomain: 'elsewhere.org' }],
  ]);

  beforeAll(async () => {
    srv = await startServer(
      { GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com' },
      {
        verifyGoogle: async (credential) => {
          const who = tokens.get(credential);
          if (!who) throw new Error('bad signature');
          return who;
        },
      },
    );
  });

  afterAll(() => srv.stop());

  const signIn = async (credential: string) => {
    const client = httpClient(srv.url);
    const res = await client('POST', '/api/auth/google', { credential });
    return { res, me: (await client('GET', '/api/auth/me')).body };
  };

  it('tells the login page the client id', async () => {
    expect((await httpClient(srv.url)('GET', '/api/auth/options')).body).toEqual({
      googleClientId: 'test-client.apps.googleusercontent.com',
      dev: true,
    });
  });

  it('signs in accounts managed by one of ALLOWED_DOMAINS', async () => {
    const admin = await signIn('admin-token');
    expect(admin.res.status).toBe(200);
    expect(admin.me).toMatchObject({ email: 'admin@example.com', displayName: 'Ada Admin', isAdmin: true });
    expect((await signIn('kim-token')).me).toMatchObject({ email: 'kim@example.com', displayName: 'Kim', isAdmin: false });
  });

  it('goes by the Workspace domain, not the email address', async () => {
    const imposter = await signIn('imposter-token');
    expect(imposter.res).toMatchObject({ status: 403, body: { code: 'not-allowed' } });
    expect(imposter.me).toBeNull();
    expect((await signIn('outsider-token')).res).toMatchObject({ status: 403, body: { code: 'not-allowed' } });
  });

  it("refuses tokens that don't verify", async () => {
    const forged = await signIn('forged-token');
    expect(forged.res.status).toBe(401);
    expect(forged.me).toBeNull();
    expect((await httpClient(srv.url)('POST', '/api/auth/google', {})).status).toBe(400);
  });

  it('dev login follows the same rules', async () => {
    expect((await httpClient(srv.url)('POST', '/api/auth/dev-login', { email: 'nobody@elsewhere.org' })).status).toBe(403);
  });

  it('marks session cookies Secure behind a TLS proxy', async () => {
    const res = await fetch(`${srv.url}/api/auth/google`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: srv.url, 'x-forwarded-proto': 'https' },
      body: JSON.stringify({ credential: 'kim-token' }),
    });
    expect(res.headers.get('set-cookie')).toMatch(/; Secure/);
  });
});

describe('without Google configured', () => {
  it('says so', async () => {
    const srv = await startServer();
    const anon = httpClient(srv.url);
    expect((await anon('GET', '/api/auth/options')).body).toEqual({ googleClientId: null, dev: true });
    expect((await anon('POST', '/api/auth/google', { credential: 'x' })).status).toBe(404);
    await srv.stop();
  });
});
