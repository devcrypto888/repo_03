import { sql } from 'drizzle-orm';
import { hostname } from 'node:os';
import { db, type Tx } from '../db';

/**
 * A durable job queue on plain Postgres, with no Redis or broker to run.
 *
 *   pick:   UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED LIMIT n)
 *           N workers on M instances pull disjoint jobs and never block each other.
 *   lease:  `locked_until` is a visibility timeout. A worker that dies mid-job
 *           (OOM, deploy) doesn't strand it: the lease expires and the job is
 *           picked again.
 *   retry:  exponential backoff with jitter. After maxAttempts the job is
 *           'dead' and stays in the table for inspection and manual replay.
 *   dedupe: a partial unique index on (queue, dedupe_key) for active jobs, so
 *           "recalculate report X" enqueued 20 times stays one job.
 *
 * Enqueue takes an optional transaction, so a job is only visible if the
 * business write that caused it commits.
 */
export interface EnqueueOptions {
  runAt?: Date;
  priority?: number; // lower runs first
  maxAttempts?: number;
  dedupeKey?: string;
  tx?: Tx;
}

export async function enqueue<T>(queue: string, payload: T, opts: EnqueueOptions = {}): Promise<number | null> {
  const runner = opts.tx ?? db;
  const { rows } = await runner.execute<{ id: number }>(sql`
    INSERT INTO jobs (queue, payload, run_at, priority, max_attempts, dedupe_key)
    VALUES (${queue}, ${JSON.stringify(payload)}::jsonb, ${opts.runAt ?? new Date()}, ${opts.priority ?? 0}, ${opts.maxAttempts ?? 5}, ${opts.dedupeKey ?? null})
    ON CONFLICT (queue, dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued','running')
    DO NOTHING
    RETURNING id
  `);
  return rows[0]?.id ?? null;
}

export interface Job<T = unknown> {
  id: number;
  queue: string;
  payload: T;
  attempts: number;
  maxAttempts: number;
}

const WORKER_ID = `${hostname()}:${process.pid}`;

export async function pick<T>(queue: string, limit: number, leaseMs: number): Promise<Job<T>[]> {
  const { rows } = await db.execute<{ id: number; queue: string; payload: T; attempts: number; max_attempts: number }>(sql`
    UPDATE jobs SET
      status = 'running',
      attempts = attempts + 1,
      locked_until = now() + ${leaseMs} * interval '1 millisecond',
      locked_by = ${WORKER_ID}
    WHERE id IN (
      SELECT id FROM jobs
      WHERE queue = ${queue}
        AND (
          (status = 'queued' AND run_at <= now())
          -- lease expired: previous worker died without finishing
          OR (status = 'running' AND locked_until < now())
        )
      ORDER BY priority, run_at, id
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, queue, payload, attempts, max_attempts
  `);
  return rows.map((r) => ({ id: r.id, queue: r.queue, payload: r.payload, attempts: r.attempts, maxAttempts: r.max_attempts }));
}

export async function complete(id: number) {
  // Guard on locked_by: if our lease expired and someone else took the job,
  // our late "done" must not overwrite their state.
  await db.execute(sql`
    UPDATE jobs SET status = 'done', finished_at = now(), locked_until = NULL
    WHERE id = ${id} AND locked_by = ${WORKER_ID} AND status = 'running'
  `);
}

export async function fail(job: Job, error: string) {
  const dead = job.attempts >= job.maxAttempts;
  const backoffSec = Math.min(3600, 5 * 2 ** job.attempts) * (0.75 + Math.random() * 0.5);
  await db.execute(sql`
    UPDATE jobs SET
      status = ${dead ? 'dead' : 'queued'},
      run_at = now() + ${Math.round(backoffSec)} * interval '1 second',
      last_error = ${error.slice(0, 4000)},
      locked_until = NULL,
      finished_at = ${dead ? sql`now()` : sql`NULL`}
    WHERE id = ${job.id} AND locked_by = ${WORKER_ID}
  `);
}

/** Long jobs extend their lease periodically so they aren't picked twice. */
export async function heartbeat(id: number, leaseMs: number) {
  const res = await db.execute(sql`
    UPDATE jobs SET locked_until = now() + ${leaseMs} * interval '1 millisecond'
    WHERE id = ${id} AND locked_by = ${WORKER_ID} AND status = 'running'
  `);
  return (res.rowCount ?? 0) > 0;
}

/** Ops endpoint: put dead jobs back in the queue after fixing the bug. */
export async function replayDead(queue: string, ids?: number[]) {
  const res = await db.execute(sql`
    UPDATE jobs SET status = 'queued', attempts = 0, run_at = now(), last_error = NULL, finished_at = NULL
    WHERE queue = ${queue} AND status = 'dead' ${ids?.length ? sql`AND id = ANY(${ids})` : sql``}
  `);
  return res.rowCount ?? 0;
}

/** Housekeeping: keep finished jobs for a while for debugging, then drop them in batches. */
export async function pruneFinished(olderThanDays = 14, batch = 5_000) {
  let total = 0;
  for (;;) {
    const res = await db.execute(sql`
      DELETE FROM jobs WHERE id IN (
        SELECT id FROM jobs WHERE status = 'done' AND finished_at < now() - ${olderThanDays} * interval '1 day'
        LIMIT ${batch}
      )
    `);
    total += res.rowCount ?? 0;
    if ((res.rowCount ?? 0) < batch) return total;
  }
}
