import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema';

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX ?? 10),
  idleTimeoutMillis: 30_000,
  // Fail fast instead of queueing forever when the pool is exhausted.
  connectionTimeoutMillis: 5_000,
  // Server-side guard: a runaway report query can't hold a connection for minutes.
  statement_timeout: Number(process.env.DB_STATEMENT_TIMEOUT_MS ?? 60_000),
  application_name: process.env.APP_NAME ?? 'api',
});

pool.on('error', (err) => {
  // An idle client errored (e.g. DB restarted). The pool discards it; just log.
  console.error('[db] idle client error', err.message);
});

export const db = drizzle(pool, { schema });
export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
