import { sql } from 'drizzle-orm';
import { db } from '../db';

/**
 * For each zone, the worst current sensor value: the MAX over each sensor's
 * *latest* reading.
 *
 * Sensors report at irregular times, and an operator can re-enter a reading
 * for the same day. "Latest" means: highest day index, then latest recorded_at,
 * then highest id as a final deterministic tie-breaker. ROW_NUMBER() over a
 * per-sensor partition chooses exactly one row per sensor, which DISTINCT ON
 * or a correlated subquery would make harder to read and to index.
 *
 * Suggested index: (sensor_id, day_index DESC, recorded_at DESC, id DESC)
 */
export async function getWorstCurrentReadingPerZone(): Promise<Map<number, number>> {
  const { rows } = await db.execute<{ zone_id: number; worst: string }>(sql`
    SELECT zone_id, MAX(value::numeric) AS worst
    FROM (
      SELECT
        zone_id,
        value,
        ROW_NUMBER() OVER (
          PARTITION BY sensor_id
          ORDER BY day_index DESC, recorded_at DESC, id DESC
        ) AS rn
      FROM sensor_readings
    ) latest
    WHERE rn = 1
    GROUP BY zone_id
  `);

  return new Map(rows.map((r) => [r.zone_id, Number(r.worst)]));
}

/**
 * Day-over-day delta per sensor with LAG(). The UI uses it to flag sensors
 * that stopped changing (stuck) or jumped by more than a threshold.
 */
export async function getReadingDeltas(zoneId: number) {
  const { rows } = await db.execute(sql`
    SELECT
      sensor_id,
      day_index,
      value::numeric                                                   AS value,
      value::numeric - LAG(value::numeric) OVER w                      AS delta,
      COUNT(*) FILTER (WHERE value IS NOT NULL) OVER (w ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) AS samples_3d
    FROM sensor_readings
    WHERE zone_id = ${zoneId}
    WINDOW w AS (PARTITION BY sensor_id ORDER BY day_index)
    ORDER BY sensor_id, day_index
  `);
  return rows;
}
