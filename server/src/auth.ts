import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { and, eq, gt, lt } from 'drizzle-orm';
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import type { Db } from './db/index.js';
import { sessions, users } from './db/schema.js';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export const SESSION_COOKIE = 'sid';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

export interface SessionUser {
  id: number;
  username: string;
  displayName: string;
  isAdmin: boolean;
}

export type AppEnv = { Variables: { user: SessionUser | null } };

export const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length);
  return timingSafeEqual(actual, expected);
}

export async function createSession(db: Db, c: Context, userId: number) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(sessions).values({ tokenHash: sha256(token), userId, expiresAt });
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: new URL(c.req.url).protocol === 'https:',
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
export function sessionMiddleware(db: Db): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    c.set('user', null);
    const token = getCookie(c, SESSION_COOKIE);
    if (token) {
      const [row] = await db
        .select({
          id: users.id,
          username: users.username,
          displayName: users.displayName,
          isAdmin: users.isAdmin,
        })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(and(eq(sessions.tokenHash, sha256(token)), gt(sessions.expiresAt, new Date())));
      if (row) c.set('user', row);
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

export async function ensureBootstrapAdmin(db: Db, username: string, password: string | undefined) {
  const existing = await db.select({ id: users.id }).from(users).limit(1);
  if (existing.length > 0) return;
  if (!password) {
    console.warn('No users exist and ADMIN_PASSWORD is not set; nobody can log in.');
    return;
  }
  await db.insert(users).values({
    username,
    displayName: 'Administrator',
    passwordHash: await hashPassword(password),
    isAdmin: true,
  });
  console.log(`Created bootstrap admin user "${username}".`);
}
