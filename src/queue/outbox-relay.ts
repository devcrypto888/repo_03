import { sql } from 'drizzle-orm';
import { db, type Tx } from '../db';

/**
 * Transactional outbox.
 *
 * Problem: "update the DB, then publish an event / call a webhook". If the
 * process dies between the two, the DB says one thing and the outside world
 * never hears about it. If you publish first and the DB write then fails, the
 * outside world hears about something that didn't happen.
 *
 * Fix: write the event into `outbox` in the same transaction as the business
 * change. A relay publishes rows in order and marks them done. Delivery is
 * at-least-once, so consumers dedupe on the outbox id.
 */
export async function recordEvent(tx: Tx, topic: string, aggregateId: string, payload: unknown) {
  await tx.execute(sql`
    INSERT INTO outbox (topic, aggregate_id, payload) VALUES (${topic}, ${aggregateId}, ${JSON.stringify(payload)}::jsonb)
  `);
}

type Publisher = (evt: { id: number; topic: string; aggregateId: string; payload: unknown }) => Promise<void>;

/**
 * One relay pass. Per-aggregate ordering is preserved: if an earlier event for
 * the same aggregate failed, later ones for that aggregate wait. A webhook
 * consumer must never see "shipment.delivered" before "shipment.dispatched".
 */
export async function relayOnce(publish: Publisher, batch = 100): Promise<{ published: number; failed: number }> {
  return db.transaction(async (tx) => {
    const { rows } = await tx.execute<{ id: number; topic: string; aggregate_id: string; payload: unknown }>(sql`
      SELECT id, topic, aggregate_id, payload
      FROM outbox
      WHERE published_at IS NULL
      ORDER BY id
      LIMIT ${batch}
      FOR UPDATE SKIP LOCKED
    `);

    const blocked = new Set<string>();
    const done: number[] = [];
    const failedIds: number[] = [];

    for (const r of rows) {
      if (blocked.has(r.aggregate_id)) continue;
      try {
        await publish({ id: r.id, topic: r.topic, aggregateId: r.aggregate_id, payload: r.payload });
        done.push(r.id);
      } catch {
        blocked.add(r.aggregate_id);
        failedIds.push(r.id);
      }
    }

    if (done.length) await tx.execute(sql`UPDATE outbox SET published_at = now() WHERE id = ANY(${done})`);
    if (failedIds.length) await tx.execute(sql`UPDATE outbox SET attempts = attempts + 1 WHERE id = ANY(${failedIds})`);

    return { published: done.length, failed: failedIds.length };
  });
}
