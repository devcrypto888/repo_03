import { sql } from 'drizzle-orm';
import { db } from '../db';

export interface StockSummaryRow {
  category: string;
  size: string;
  variant: string;
  packaging: string;
  packageCount: number;
  receivingQty: number;
  inProcessQty: number;
  inProcessByStation: { station: string; qty: number }[];
  readyQty: number;
  readyCost: number;
  /** Weighted average unit cost over rows that HAVE a cost (see query). */
  readyAvgUnitCost: number | null;
  reservedQty: number;
}

/**
 * Stock grouped by SKU for the inventory dashboard and for quoting.
 *
 * A package normally holds one variant. Mixed packages carry a JSONB
 * `composition` array ([{ variant, qty, unitCost? }, ...]), and they must be
 * counted under each variant they contain, not under the package's headline
 * variant. So the query:
 *
 *   1. `active`     picks in-stock packages and normalises free-text columns
 *   2. `flagged`    marks packages with a usable composition
 *   3. `exploded`   uses CROSS JOIN LATERAL jsonb_array_elements to emit one row
 *                   per variant in a mixed package, and UNION ALLs the plain
 *                   packages as they are; cost is split proportionally by
 *                   quantity unless the line has its own unit cost
 *   4. final SELECT one GROUP BY with conditional aggregates (FILTER) per status
 *
 * All of this runs in a single round trip. The JS side only reshapes numbers.
 */
export async function getStockSummary(): Promise<StockSummaryRow[]> {
  const { rows } = await db.execute<Record<string, unknown>>(sql`
    WITH active AS (
      SELECT
        p.id,
        p.status,
        COALESCE(TRIM(p.station), '')                                AS station,
        p.category,
        p.size,
        p.variant,
        CASE
          WHEN TRIM(COALESCE(p.packaging, '')) = '' THEN 'Default'
          ELSE TRIM(p.packaging)
        END                                                          AS packaging,
        p.qty::numeric                                               AS qty,
        COALESCE(p.total_cost::numeric, 0)                           AS total_cost,
        COALESCE(p.unit_cost::numeric, 0)                            AS unit_cost,
        COALESCE(p.composition, '[]'::jsonb)                         AS composition
      FROM packages p
      WHERE p.status NOT IN ('Shipped', 'Consumed')
        AND NOT p.is_virtual
        AND p.qty > 0
    ),
    flagged AS (
      SELECT a.*, EXISTS (
        SELECT 1
        FROM jsonb_array_elements(a.composition) el
        WHERE NULLIF(TRIM(el->>'variant'), '') IS NOT NULL
          AND COALESCE((el->>'qty')::numeric, 0) > 0
      ) AS is_mixed
      FROM active a
    ),
    exploded AS (
      SELECT
        f.id, f.status, f.station, f.category, f.size, f.packaging,
        TRIM(el->>'variant')                                           AS variant,
        (el->>'qty')::numeric                                        AS qty,
        COALESCE(
          (el->>'totalCost')::numeric,
          CASE WHEN f.qty > 0 THEN f.total_cost * (el->>'qty')::numeric / f.qty ELSE 0 END
        )                                                            AS cost
      FROM flagged f
      CROSS JOIN LATERAL jsonb_array_elements(f.composition) el
      WHERE f.is_mixed
        AND NULLIF(TRIM(el->>'variant'), '') IS NOT NULL
        AND COALESCE((el->>'qty')::numeric, 0) > 0

      UNION ALL

      SELECT f.id, f.status, f.station, f.category, f.size, f.packaging, f.variant, f.qty, f.total_cost
      FROM flagged f
      WHERE NOT f.is_mixed
    )
    SELECT
      category, size, variant, packaging,
      COUNT(DISTINCT id)::int                                                  AS package_count,
      COALESCE(SUM(qty)  FILTER (WHERE status = 'Receiving'), 0)               AS receiving_qty,
      COALESCE(SUM(qty)  FILTER (WHERE status = 'In-Process'), 0)              AS in_process_qty,
      COALESCE(
        jsonb_agg(jsonb_build_object('station', station, 'qty', qty))
          FILTER (WHERE status = 'In-Process'),
        '[]'::jsonb
      )                                                                        AS in_process_by_station,
      COALESCE(SUM(qty)  FILTER (WHERE status = 'Ready'), 0)                   AS ready_qty,
      COALESCE(SUM(cost) FILTER (WHERE status = 'Ready'), 0)                   AS ready_cost,
      -- Uncosted rows are excluded from BOTH numerator and denominator.
      -- Otherwise they would drag the average toward zero.
      SUM(cost) FILTER (WHERE status = 'Ready' AND cost > 0)
        / NULLIF(SUM(qty) FILTER (WHERE status = 'Ready' AND cost > 0), 0)     AS ready_avg_unit_cost,
      COALESCE(SUM(qty)  FILTER (WHERE status = 'Reserved'), 0)                AS reserved_qty
    FROM exploded
    GROUP BY 1, 2, 3, 4
    ORDER BY 1, 2, 3, 4
  `);

  return rows.map((r) => ({
    category: String(r.category),
    size: String(r.size),
    variant: String(r.variant),
    packaging: String(r.packaging),
    packageCount: Number(r.package_count),
    receivingQty: Number(r.receiving_qty),
    inProcessQty: Number(r.in_process_qty),
    inProcessByStation: mergeByStation(r.in_process_by_station as { station: string; qty: string }[]),
    readyQty: Number(r.ready_qty),
    readyCost: Number(r.ready_cost),
    readyAvgUnitCost: r.ready_avg_unit_cost == null ? null : Number(r.ready_avg_unit_cost),
    reservedQty: Number(r.reserved_qty),
  }));
}

/** jsonb_agg emits one entry per package; collapse to one per station. */
function mergeByStation(entries: { station: string; qty: string }[]) {
  const acc = new Map<string, number>();
  for (const e of entries) acc.set(e.station, (acc.get(e.station) ?? 0) + Number(e.qty));
  return [...acc].map(([station, qty]) => ({ station, qty }));
}
