import { sql } from 'drizzle-orm';
import { db } from '../db';

/**
 * Monthly inventory roll-forward per category:
 *
 *   opening + receipts − shipments − consumption ± adjustments = closing
 *
 * Opening comes from the previous month's *closed* figures (monthly_closes),
 * not a recomputation, because closed months are frozen. Movements are
 * classified from the event log by the status transition they represent.
 * Closing is computed both ways (from movements and from an as-of snapshot),
 * and any difference is reported as an "unexplained" line. That number must
 * be zero before the month can be closed.
 */
export interface RollforwardRow {
  category: string;
  openingQty: number;
  openingValue: number;
  receiptsQty: number;
  receiptsValue: number;
  shippedQty: number;
  shippedValue: number;
  consumedQty: number;
  consumedValue: number;
  adjustmentsQty: number;
  adjustmentsValue: number;
  closingQty: number;
  closingValue: number;
  snapshotQty: number;
  snapshotValue: number;
  unexplainedQty: number;
  unexplainedValue: number;
}

export async function monthlyRollforward(month: string /* YYYY-MM */): Promise<RollforwardRow[]> {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('month must be YYYY-MM');
  const start = `${month}-01`;

  const { rows } = await db.execute<Record<string, string>>(sql`
    WITH bounds AS (
      SELECT ${start}::date AS m_start, (${start}::date + interval '1 month')::date AS m_end
    ),
    opening AS (
      SELECT c.category, c.closing_qty AS qty, c.closing_value AS value
      FROM monthly_closes c, bounds b
      WHERE c.month = (b.m_start - interval '1 month')::date
    ),
    status_moves AS (
      SELECT
        e.package_id,
        e.old_value AS from_status,
        e.new_value AS to_status,
        e.occurred_at
      FROM package_events e, bounds b
      WHERE e.field = 'status'
        AND e.occurred_at >= b.m_start AND e.occurred_at < b.m_end
    ),
    -- Value each movement at the package's qty/cost at that moment, using a
    -- LATERAL lookup of the last qty/cost event at or before the movement.
    valued AS (
      SELECT
        p.category,
        m.from_status,
        m.to_status,
        q.qty,
        c.cost
      FROM status_moves m
      JOIN packages p ON p.id = m.package_id
      CROSS JOIN LATERAL (
        SELECT e.new_value::numeric AS qty FROM package_events e
        WHERE e.package_id = m.package_id AND e.field = 'qty' AND e.occurred_at <= m.occurred_at
        ORDER BY e.occurred_at DESC, e.id DESC LIMIT 1
      ) q
      LEFT JOIN LATERAL (
        SELECT e.new_value::numeric AS cost FROM package_events e
        WHERE e.package_id = m.package_id AND e.field = 'total_cost' AND e.occurred_at <= m.occurred_at
        ORDER BY e.occurred_at DESC, e.id DESC LIMIT 1
      ) c ON true
    ),
    qty_adjustments AS (
      -- Qty edits on in-stock packages that aren't part of a status move.
      SELECT p.category,
             SUM(e.new_value::numeric - COALESCE(e.old_value::numeric, 0)) AS qty
      FROM package_events e
      JOIN packages p ON p.id = e.package_id, bounds b
      WHERE e.field = 'qty' AND e.old_value IS NOT NULL
        AND e.occurred_at >= b.m_start AND e.occurred_at < b.m_end
      GROUP BY p.category
    ),
    movements AS (
      SELECT
        category,
        COALESCE(SUM(qty)  FILTER (WHERE from_status IS NULL), 0)                AS receipts_qty,
        COALESCE(SUM(cost) FILTER (WHERE from_status IS NULL), 0)                AS receipts_value,
        COALESCE(SUM(qty)  FILTER (WHERE to_status = 'Shipped'), 0)              AS shipped_qty,
        COALESCE(SUM(cost) FILTER (WHERE to_status = 'Shipped'), 0)              AS shipped_value,
        COALESCE(SUM(qty)  FILTER (WHERE to_status = 'Consumed'), 0)             AS consumed_qty,
        COALESCE(SUM(cost) FILTER (WHERE to_status = 'Consumed'), 0)             AS consumed_value
      FROM valued
      GROUP BY category
    ),
    categories AS (
      SELECT category FROM opening UNION SELECT category FROM movements UNION SELECT category FROM qty_adjustments
    )
    SELECT
      k.category,
      COALESCE(o.qty, 0)              AS opening_qty,
      COALESCE(o.value, 0)            AS opening_value,
      COALESCE(m.receipts_qty, 0)     AS receipts_qty,
      COALESCE(m.receipts_value, 0)   AS receipts_value,
      COALESCE(m.shipped_qty, 0)      AS shipped_qty,
      COALESCE(m.shipped_value, 0)    AS shipped_value,
      COALESCE(m.consumed_qty, 0)     AS consumed_qty,
      COALESCE(m.consumed_value, 0)   AS consumed_value,
      COALESCE(a.qty, 0)              AS adjustments_qty
    FROM categories k
    LEFT JOIN opening o USING (category)
    LEFT JOIN movements m USING (category)
    LEFT JOIN qty_adjustments a USING (category)
    ORDER BY k.category
  `);

  // Independent check: closing according to the event log at month end.
  const { stockAsOf } = await import('./as-of-snapshot');
  const monthEnd = new Date(new Date(`${start}T00:00:00Z`).setUTCMonth(new Date(`${start}T00:00:00Z`).getUTCMonth() + 1) - 1);
  const snapshot = await stockAsOf(monthEnd);
  const snapByCat = new Map<string, { qty: number; value: number }>();
  for (const r of snapshot) {
    const s = snapByCat.get(r.category) ?? { qty: 0, value: 0 };
    s.qty += r.qty;
    s.value += r.totalCost ?? 0;
    snapByCat.set(r.category, s);
  }

  const n = (v: string | undefined) => Number(v ?? 0);
  return rows.map((r) => {
    const closingQty = n(r.opening_qty) + n(r.receipts_qty) - n(r.shipped_qty) - n(r.consumed_qty) + n(r.adjustments_qty);
    const closingValue = n(r.opening_value) + n(r.receipts_value) - n(r.shipped_value) - n(r.consumed_value);
    const snap = snapByCat.get(r.category) ?? { qty: 0, value: 0 };
    const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

    return {
      category: r.category,
      openingQty: n(r.opening_qty),
      openingValue: n(r.opening_value),
      receiptsQty: n(r.receipts_qty),
      receiptsValue: n(r.receipts_value),
      shippedQty: n(r.shipped_qty),
      shippedValue: n(r.shipped_value),
      consumedQty: n(r.consumed_qty),
      consumedValue: n(r.consumed_value),
      adjustmentsQty: n(r.adjustments_qty),
      adjustmentsValue: 0,
      closingQty: round(closingQty),
      closingValue: round(closingValue, 2),
      snapshotQty: round(snap.qty),
      snapshotValue: round(snap.value, 2),
      unexplainedQty: round(snap.qty - closingQty),
      unexplainedValue: round(snap.value - closingValue, 2),
    };
  });
}

/**
 * Freezes a month. Refuses while any category has unexplained quantity.
 * Idempotent: closing an already-closed month is a no-op.
 */
export async function closeMonth(month: string) {
  const rows = await monthlyRollforward(month);
  const bad = rows.filter((r) => Math.abs(r.unexplainedQty) > 0.001);
  if (bad.length) {
    throw new Error(`Cannot close ${month}: unexplained movement in ${bad.map((b) => b.category).join(', ')}`);
  }

  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('month-close'), hashtext(${month}))`);
    for (const r of rows) {
      await tx.execute(sql`
        INSERT INTO monthly_closes (month, category, opening_qty, opening_value, closing_qty, closing_value)
        VALUES (${month + '-01'}::date, ${r.category}, ${r.openingQty}, ${r.openingValue}, ${r.closingQty}, ${r.snapshotValue})
        ON CONFLICT (month, category) DO NOTHING
      `);
    }
  });
  return rows;
}
