import { sql } from 'drizzle-orm';
import type { Tx } from '../db';

/**
 * Allocates the next order number (ORD-24-00157) for the current year.
 *
 * The numbers must be gap-free and sequential within a year, and they must
 * also accept numbers typed in by hand ("ORD-24-00160" entered from paper).
 * A Postgres SEQUENCE can't guarantee either of these, so we compute
 * max + 1 under a transaction-scoped advisory lock. Concurrent creators wait
 * here briefly, readers are never blocked, and the lock is released
 * automatically at commit or rollback.
 */
export async function allocateOrderNumber(tx: Tx, now = new Date()): Promise<string> {
  const yy = String(now.getUTCFullYear()).slice(-2);
  const prefix = `ORD-${yy}-`;

  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('order-number'), ${Number(yy)})`);

  const { rows } = await tx.execute<{ max: number | null }>(sql`
    SELECT MAX(substring(number FROM ${'^' + prefix + '([0-9]+)$'})::int) AS max
    FROM orders
    WHERE number LIKE ${prefix + '%'}
  `);

  const next = (rows[0]?.max ?? 0) + 1;
  return `${prefix}${String(next).padStart(5, '0')}`;
}
