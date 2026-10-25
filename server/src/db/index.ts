import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type { Config } from '../config.js';
import * as schema from './schema.js';

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface Database {
  db: Db;
  close(): Promise<void>;
}

/**
 * Production uses Postgres via DATABASE_URL. Without one we fall back to PGlite
 * (Postgres compiled to WASM) so dev and tests need no external database but
 * still run the exact same SQL and migrations.
 */
export async function openDatabase(cfg: Pick<Config, 'DATABASE_URL' | 'PGLITE_DIR' | 'MIGRATIONS_DIR'>): Promise<Database> {
  // The production bundle has no source tree around it to find them from, so it's given MIGRATIONS_DIR.
  const migrationsFolder = cfg.MIGRATIONS_DIR ?? fileURLToPath(new URL('../../drizzle', import.meta.url));
  if (cfg.DATABASE_URL) {
    const { default: pg } = await import('pg');
    const { drizzle } = await import('drizzle-orm/node-postgres');
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    const pool = new pg.Pool({ connectionString: cfg.DATABASE_URL });
    const db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder });
    return { db: db as unknown as Db, close: () => pool.end() };
  }

  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const { migrate } = await import('drizzle-orm/pglite/migrator');
  if (!cfg.PGLITE_DIR.startsWith('memory://')) mkdirSync(cfg.PGLITE_DIR, { recursive: true });
  const client = new PGlite(cfg.PGLITE_DIR);
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder });
  return { db: db as unknown as Db, close: () => client.close() };
}

export { schema };
