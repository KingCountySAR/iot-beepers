import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, inArray, lt } from 'drizzle-orm';
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import type { Config } from './config.js';
import type { Db } from './db/index.js';
import { sessions, userLogins, users } from './db/schema.js';

export const SESSION_COOKIE = 'sid';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

export interface SessionUser {
  /** Member database id. */
  id: string;
  /** The Google account this session signed in with. */
  email: string;
  displayName: string;
  isAdmin: boolean;
}

export type AppEnv = { Variables: { user: SessionUser | null } };

export const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

/**
 * Admin rights come from SITE_ADMINS on every request, so editing it takes effect on restart.
 * A member is an admin if any of their Google accounts is listed.
 */
export const isSiteAdmin = (cfg: Pick<Config, 'SITE_ADMINS'>, email: string) =>
  cfg.SITE_ADMINS.includes(email.toLowerCase());

/**
 * The origin the browser used, e.g. "https://notifier.example.org". Behind a TLS proxy (Caddy)
 * the request itself is plain HTTP, so the proxy's X-Forwarded-Proto says which.
 */
export function originOf(c: Context) {
  const proto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim() || new URL(c.req.url).protocol.replace(':', '');
  const host = c.req.header('x-forwarded-host')?.split(',')[0]?.trim() || c.req.header('host') || new URL(c.req.url).host;
  return `${proto}://${host}`;
}

export const secureCookies = (c: Context) => originOf(c).startsWith('https:');

export async function createSession(
  db: Db,
  c: Context,
  login: { id: string; email: string },
) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(sessions).values({ tokenHash: sha256(token), userId: login.id, email: login.email, expiresAt });
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: secureCookies(c),
    path: '/',
    expires: expiresAt,
  });
}

export async function destroySession(db: Db, c: Context) {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await db.delete(sessions).where(eq(sessions.tokenHash, sha256(token)));
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

/** Resolves the session cookie (if any) into c.var.user. */
export function sessionMiddleware(db: Db, cfg: Pick<Config, 'SITE_ADMINS'>): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    c.set('user', null);
    const token = getCookie(c, SESSION_COOKIE);
    if (token) {
      const [row] = await db
        .select({ id: users.id, email: sessions.email, displayName: users.displayName })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(and(eq(sessions.tokenHash, sha256(token)), gt(sessions.expiresAt, new Date())));
      if (row) {
        const admin =
          cfg.SITE_ADMINS.length > 0 &&
          (await db
            .select({ email: userLogins.email })
            .from(userLogins)
            .where(and(eq(userLogins.userId, row.id), inArray(userLogins.email, cfg.SITE_ADMINS)))
            .limit(1)).length > 0;
        c.set('user', { ...row, isAdmin: admin });
      }
    }
    await next();
  };
}

export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.var.user) throw new HTTPException(401, { message: 'Not logged in' });
  await next();
};

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.var.user) throw new HTTPException(401, { message: 'Not logged in' });
  if (!c.var.user.isAdmin) throw new HTTPException(403, { message: 'Admins only' });
  await next();
};

export async function pruneSessions(db: Db) {
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
}
