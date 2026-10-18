import { createHmac } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../db';
import { enqueue } from './queue';
import type { Handler } from './worker';

/**
 * Outgoing webhooks: the outbox relay fans each event out into one job per
 * subscribed endpoint. Each delivery then retries independently, so one slow
 * customer endpoint doesn't hold up the others.
 */
interface Delivery {
  endpointId: string;
  url: string;
  secret: string;
  eventId: number;
  topic: string;
  payload: unknown;
}

export async function fanOut(evt: { id: number; topic: string; payload: unknown }) {
  const { rows } = await db.execute<{ id: string; url: string; secret: string }>(sql`
    SELECT id, url, secret FROM webhook_endpoints WHERE active AND ${evt.topic} = ANY(topics)
  `);
  for (const ep of rows) {
    await enqueue<Delivery>(
      'webhooks',
      { endpointId: ep.id, url: ep.url, secret: ep.secret, eventId: evt.id, topic: evt.topic, payload: evt.payload },
      { dedupeKey: `${ep.id}:${evt.id}`, maxAttempts: 12 },
    );
  }
}

export const deliverWebhook: Handler<Delivery> = async ({ payload: d }, { signal }) => {
  const body = JSON.stringify({ id: d.eventId, type: d.topic, data: d.payload });
  const ts = Math.floor(Date.now() / 1000);
  // Timestamp is part of the signed string, so receivers can reject replays.
  const sig = createHmac('sha256', d.secret).update(`${ts}.${body}`).digest('hex');

  const res = await fetch(d.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Webhook-Id': String(d.eventId),
      'Webhook-Timestamp': String(ts),
      'Webhook-Signature': `v1=${sig}`,
    },
    body,
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    redirect: 'manual', // never follow redirects to internal addresses
  });

  await db.execute(sql`
    INSERT INTO webhook_attempts (endpoint_id, event_id, status, at) VALUES (${d.endpointId}, ${d.eventId}, ${res.status}, now())
  `);

  // 2xx = delivered. 410 = endpoint asked to be removed. Anything else = retry.
  if (res.status === 410) {
    await db.execute(sql`UPDATE webhook_endpoints SET active = false WHERE id = ${d.endpointId}`);
    return;
  }
  if (res.status < 200 || res.status >= 300) throw new Error(`Endpoint responded ${res.status}`);
};
