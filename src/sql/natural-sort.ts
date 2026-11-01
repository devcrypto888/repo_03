import { sql, type SQL, type AnyColumn } from 'drizzle-orm';

/**
 * Natural ("human") sort key for mixed alphanumeric ids, so that
 * A-2 < A-10 < B-1 instead of the lexical A-10 < A-2 < B-1.
 *
 * The id is split into digit and non-digit runs, then every digit run is
 * left-padded to 20 characters and the pieces are concatenated back in their
 * original order (WITH ORDINALITY keeps that order). The result sorts
 * correctly as plain text, so it can be used in ORDER BY with pagination.
 *
 *   ORDER BY ${naturalKey(orders.number)}, ${orders.id}
 */
export function naturalKey(column: AnyColumn): SQL {
  return sql`(
    SELECT string_agg(
      CASE WHEN m[1] ~ '^[0-9]+$' THEN lpad(m[1], 20, '0') ELSE m[1] END,
      '' ORDER BY ord
    )
    FROM regexp_matches(${column}, '[0-9]+|[^0-9]+', 'g') WITH ORDINALITY AS t(m, ord)
  )`;
}
