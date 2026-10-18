import { sql } from 'drizzle-orm';
import { db } from '../db';

/**
 * "What did stock look like at the end of <date>?" rebuilt purely from the
 * event log, never from current state. That makes month-end figures
 * reproducible: re-running March's report in June gives March's answer, even
 * though half those packages have shipped since.
 *
 * Technique: for each (package, field), take the last event with
 * occurred_at <= cutoff (ROW_NUMBER over a partition ordered by time desc),
 * then pivot the fields back into columns with FILTER.
 *
 * `knownAt` adds a second time axis: it ignores events *recorded* after it.
 * This answers "what did we believe on April 2nd about March 31st?", which
 * auditors ask when a late correction moved a closed month.
 */
export interface AsOfRow {
  packageId: string;
  category: string;
  variant: string;
  status: string;
  qty: number;
  totalCost: number | null;
}

export async function stockAsOf(cutoff: Date, opts: { knownAt?: Date; category?: string } = {}): Promise<AsOfRow[]> {
  const knownAt = opts.knownAt ?? new Date();

  const { rows } = await db.execute<{
    package_id: string;
    category: string;
    variant: string;
    status: string;
    qty: string;
    total_cost: string | null;
  }>(sql`
    WITH ranked AS (
      SELECT
        e.package_id,
        e.field,
        e.new_value,
        ROW_NUMBER() OVER (
          PARTITION BY e.package_id, e.field
          ORDER BY e.occurred_at DESC, e.id DESC
        ) AS rn
      FROM package_events e
      WHERE e.occurred_at <= ${cutoff}
        AND e.recorded_at <= ${knownAt}
        AND e.field IN ('status', 'qty', 'total_cost')
    ),
    pivoted AS (
      SELECT
        package_id,
        MAX(new_value) FILTER (WHERE field = 'status')                  AS status,
        MAX(new_value) FILTER (WHERE field = 'qty')::numeric            AS qty,
        MAX(new_value) FILTER (WHERE field = 'total_cost')::numeric     AS total_cost
      FROM ranked
      WHERE rn = 1
      GROUP BY package_id
    )
    SELECT v.package_id, p.category, p.variant, v.status, v.qty, v.total_cost
    FROM pivoted v
    JOIN packages p ON p.id = v.package_id
    WHERE v.status NOT IN ('Shipped', 'Consumed')
      AND v.qty > 0
      AND NOT p.is_virtual
      ${opts.category ? sql`AND p.category = ${opts.category}` : sql``}
    ORDER BY p.category, p.variant, v.package_id
  `);

  return rows.map((r) => ({
    packageId: r.package_id,
    category: r.category,
    variant: r.variant,
    status: r.status,
    qty: Number(r.qty),
    totalCost: r.total_cost == null ? null : Number(r.total_cost),
  }));
}

/**
 * Diff two as-of snapshots: which packages appeared, disappeared, or changed.
 * Used to explain a month-over-month movement line by line.
 */
export async function diffSnapshots(a: Date, b: Date) {
  const [before, after] = await Promise.all([stockAsOf(a), stockAsOf(b)]);
  const A = new Map(before.map((r) => [r.packageId, r]));
  const B = new Map(after.map((r) => [r.packageId, r]));

  const added = after.filter((r) => !A.has(r.packageId));
  const removed = before.filter((r) => !B.has(r.packageId));
  const changed = after
    .filter((r) => A.has(r.packageId))
    .map((r) => ({ before: A.get(r.packageId)!, after: r }))
    .filter(({ before: x, after: y }) => x.qty !== y.qty || x.status !== y.status || x.totalCost !== y.totalCost);

  return { added, removed, changed };
}
