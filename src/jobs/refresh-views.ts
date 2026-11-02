import { sql } from 'drizzle-orm';
import { db, pool } from '../db';
import { enqueue } from '../queue/queue';

/**
 * Refreshes materialized views without blocking readers (CONCURRENTLY) and
 * without two refreshes of the same view piling up. REFRESH CONCURRENTLY on
 * a view that is already refreshing waits for a heavy lock, so the second
 * one becomes pointless work.
 *
 * The non-blocking advisory try-lock lets a duplicate refresh just skip.
 */
const VIEWS = ['stock_daily'] as const;
type View = (typeof VIEWS)[number];

export async function refreshView(view: View): Promise<'refreshed' | 'skipped'> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock(hashtext('mv:' || $1)) AS ok`, [view]);
    if (!rows[0]?.ok) return 'skipped';
    try {
      await client.query(`SET statement_timeout = '10min'`);
      await client.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${view}`);
      await client.query(`INSERT INTO system_settings (key, value) VALUES ($1, now()::text)
                          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [`mv.refreshed.${view}`]);
      return 'refreshed';
    } finally {
      await client.query(`SELECT pg_advisory_unlock(hashtext('mv:' || $1))`, [view]);
    }
  } finally {
    client.release();
  }
}

/** Debounced trigger from write paths: many writes in a minute cause one refresh. */
export function scheduleRefresh(view: View) {
  const slot = Math.floor(Date.now() / 60_000);
  return enqueue('refresh-views', { view }, { dedupeKey: `${view}:${slot}`, runAt: new Date((slot + 1) * 60_000) });
}

export async function viewFreshness() {
  const { rows } = await db.execute<{ key: string; value: string }>(sql`SELECT key, value FROM system_settings WHERE key LIKE 'mv.refreshed.%'`);
  return Object.fromEntries(rows.map((r) => [r.key.replace('mv.refreshed.', ''), r.value]));
}
