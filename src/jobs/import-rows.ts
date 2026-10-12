import { createHash } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import type { Tx } from '../db';

/**
 * Row-level import: CSV from an external system → validated → upserted.
 *
 * - Headers are matched case/space-insensitively with aliases, because the
 *   source system's export has renamed columns twice already.
 * - Each row is hashed after normalisation. If the hash equals what's
 *   stored, the row is skipped. This means no write, no trigger and no event
 *   noise, and a 20k-row file where 30 rows changed costs 30 writes.
 * - The change is tagged via SET LOCAL so the event trigger records it as
 *   coming from 'import' with the source's own timestamp.
 */
const ALIASES: Record<string, string[]> = {
  externalId: ['id', 'package id', 'pkg', 'tag'],
  category: ['category', 'group'],
  size: ['size', 'dimension'],
  variant: ['variant', 'class', 'type'],
  qty: ['qty', 'quantity', 'units'],
  unitCost: ['unit cost', 'cost/unit', 'price'],
  status: ['status', 'state'],
  station: ['station', 'line', 'location'],
  updatedAt: ['updated', 'modified', 'last change'],
};

const num = z.preprocess((v) => (typeof v === 'string' ? v.replace(/[\s,]/g, '') : v), z.coerce.number().finite());

const Row = z.object({
  externalId: z.string().trim().min(1).max(64),
  category: z.string().trim().min(1),
  size: z.string().trim().min(1),
  variant: z.string().trim().min(1),
  qty: num.refine((n) => n >= 0, 'qty must be >= 0'),
  unitCost: num.optional().nullable(),
  status: z.enum(['Receiving', 'In-Process', 'Ready', 'Reserved', 'Shipped', 'Consumed']).catch('Receiving'),
  station: z.string().trim().optional().nullable(),
  updatedAt: z.coerce.date().optional(),
});
export type ImportRow = z.infer<typeof Row>;

export interface ParseResult {
  rows: ImportRow[];
  errors: { line: number; message: string }[];
}

export function parseRows(buf: Buffer): ImportRow[] {
  const { rows, errors } = parseRowsDetailed(buf);
  if (errors.length && !rows.length) throw new Error(`No valid rows: ${errors[0].message}`);
  return rows;
}

export function parseRowsDetailed(buf: Buffer): ParseResult {
  const records: Record<string, string>[] = parse(buf, {
    columns: (header: string[]) => header.map(canonicalHeader),
    skip_empty_lines: true,
    trim: true,
    bom: true,
    relax_column_count: true,
  });

  const rows: ImportRow[] = [];
  const errors: ParseResult['errors'] = [];
  records.forEach((rec, i) => {
    const r = Row.safeParse(rec);
    if (r.success) rows.push(r.data);
    else errors.push({ line: i + 2, message: r.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ') });
  });
  return { rows, errors };
}

function canonicalHeader(h: string) {
  const k = h.toLowerCase().replace(/[_\s]+/g, ' ').trim();
  for (const [canon, alts] of Object.entries(ALIASES)) if (alts.includes(k) || canon.toLowerCase() === k) return canon;
  return k;
}

export function rowHash(r: ImportRow) {
  const norm = [r.externalId, r.category, r.size, r.variant, r.qty.toFixed(3), r.unitCost?.toFixed(4) ?? '', r.status, r.station ?? ''].join('|');
  return createHash('sha256').update(norm).digest('hex');
}

/** Returns true if the row was inserted or changed. */
export async function upsertRow(tx: Tx, r: ImportRow): Promise<boolean> {
  const hash = rowHash(r);
  await tx.execute(sql`SELECT set_config('app.event_source', 'import', true)`);
  if (r.updatedAt) await tx.execute(sql`SELECT set_config('app.occurred_at', ${r.updatedAt.toISOString()}, true)`);

  const res = await tx.execute(sql`
    INSERT INTO packages (external_id, category, size, variant, qty, unit_cost, total_cost, status, station, source_hash)
    VALUES (
      ${r.externalId}, ${r.category}, ${r.size}, ${r.variant}, ${r.qty},
      ${r.unitCost ?? null}, ${r.unitCost != null ? r.unitCost * r.qty : null},
      ${r.status}::package_status, ${r.station ?? null}, ${hash}
    )
    ON CONFLICT (external_id) DO UPDATE SET
      category = EXCLUDED.category,
      size = EXCLUDED.size,
      variant = EXCLUDED.variant,
      qty = EXCLUDED.qty,
      unit_cost = EXCLUDED.unit_cost,
      total_cost = EXCLUDED.total_cost,
      status = EXCLUDED.status,
      station = EXCLUDED.station,
      source_hash = EXCLUDED.source_hash
    WHERE packages.source_hash IS DISTINCT FROM EXCLUDED.source_hash
  `);
  return (res.rowCount ?? 0) > 0;
}
