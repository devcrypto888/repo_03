import { sql } from 'drizzle-orm';
import { db } from '../db';

/**
 * How long reserved stock has been waiting for pickup, bucketed per SKU.
 *
 * `generate_series` gives a dense bucket axis, so the chart shows empty
 * buckets as zero instead of skipping them. A LEFT JOIN keeps those zeros.
 */
export async function getReservationAging(asOf = new Date()) {
  const { rows } = await db.execute<{
    sku: string;
    bucket: string;
    qty: string;
    orders: number;
  }>(sql`
    WITH buckets(label, lo, hi, ord) AS (
      VALUES ('0-7', 0, 7, 1), ('8-30', 8, 30, 2), ('31-60', 31, 60, 3),
             ('61-90', 61, 90, 4), ('90+', 91, NULL, 5)
    ),
    reserved AS (
      SELECT
        r.sku,
        r.qty::numeric                                             AS qty,
        r.order_id,
        (${asOf}::date - r.reserved_at::date)                      AS age_days
      FROM reservations r
      WHERE r.released_at IS NULL
    ),
    skus AS (SELECT DISTINCT sku FROM reserved)
    SELECT
      s.sku,
      b.label                                                      AS bucket,
      COALESCE(SUM(r.qty), 0)                                      AS qty,
      COUNT(DISTINCT r.order_id)::int                              AS orders
    FROM skus s
    CROSS JOIN buckets b
    LEFT JOIN reserved r
      ON r.sku = s.sku
     AND r.age_days >= b.lo
     AND (b.hi IS NULL OR r.age_days <= b.hi)
    GROUP BY s.sku, b.label, b.ord
    ORDER BY s.sku, b.ord
  `);

  // Pivot rows to { sku, '0-7': n, '8-30': n, ... } for the table view.
  const bySku = new Map<string, Record<string, number | string>>();
  for (const r of rows) {
    const row = bySku.get(r.sku) ?? { sku: r.sku };
    row[r.bucket] = Number(r.qty);
    bySku.set(r.sku, row);
  }
  return [...bySku.values()];
}
