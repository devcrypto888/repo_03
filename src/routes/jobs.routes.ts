import { Router } from 'express';
import { z } from 'zod';
import { sql } from 'drizzle-orm';

import { db } from '../db';
import { route } from '../lib/validate';
import { requireCronSecret } from '../lib/cron-auth';
import { requireRole } from '../lib/auth';
import { startImport, ImportBusyError } from '../jobs/import-runner';
import { runBackup } from '../jobs/backup';
import { replayDead, pruneFinished } from '../queue/queue';
import { relayOnce } from '../queue/outbox-relay';
import { fanOut } from '../queue/webhooks';

export const jobsRouter = Router();

/** External scheduler entry points. Each finishes within the HTTP time budget. */
jobsRouter.post(
  '/cron/import',
  requireCronSecret,
  route({}, async (_i, _req, res) => {
    try {
      return await startImport('cron');
    } catch (err) {
      if (err instanceof ImportBusyError) return res.status(409).json({ error: err.message });
      throw err;
    }
  }),
);

jobsRouter.post('/cron/backup', requireCronSecret, route({}, () => runBackup()));

jobsRouter.post(
  '/cron/outbox',
  requireCronSecret,
  route({}, async () => {
    // Drain for up to ~20s, then hand back to the scheduler.
    const deadline = Date.now() + 20_000;
    let published = 0;
    let failed = 0;
    while (Date.now() < deadline) {
      const r = await relayOnce(fanOut);
      published += r.published;
      failed += r.failed;
      if (r.published + r.failed === 0) break;
    }
    return { published, failed };
  }),
);

jobsRouter.post('/cron/housekeeping', requireCronSecret, route({}, async () => ({ prunedJobs: await pruneFinished() })));

/** Admin: manual import and queue inspection. */
jobsRouter.post(
  '/import',
  requireRole('admin'),
  route({}, async (_i, _req, res) => {
    try {
      return await startImport('manual');
    } catch (err) {
      if (err instanceof ImportBusyError) return res.status(409).json({ error: err.message });
      throw err;
    }
  }),
);

jobsRouter.get(
  '/queue/stats',
  requireRole('admin'),
  route({}, async () => {
    const { rows } = await db.execute(sql`
      SELECT queue,
             COUNT(*) FILTER (WHERE status = 'queued')                          AS queued,
             COUNT(*) FILTER (WHERE status = 'running')                         AS running,
             COUNT(*) FILTER (WHERE status = 'dead')                            AS dead,
             COUNT(*) FILTER (WHERE status = 'running' AND locked_until < now()) AS stuck,
             EXTRACT(EPOCH FROM now() - MIN(run_at) FILTER (WHERE status = 'queued'))::int AS oldest_wait_s,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM finished_at - run_at))
               FILTER (WHERE status = 'done' AND finished_at > now() - interval '1 hour')  AS p95_latency_s
      FROM jobs
      GROUP BY queue
      ORDER BY queue
    `);
    return rows;
  }),
);

jobsRouter.post(
  '/queue/:queue/replay',
  requireRole('admin'),
  route(
    { params: z.object({ queue: z.string().min(1).max(64) }), body: z.object({ ids: z.array(z.number().int()).max(1000).optional() }) },
    async ({ params, body }) => ({ replayed: await replayDead(params.queue, body.ids) }),
  ),
);

jobsRouter.get(
  '/import/history',
  requireRole('admin'),
  route({ query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }) }, async ({ query }) => {
    const { rows } = await db.execute(sql`
      SELECT id, trigger, status, started_at, finished_at,
             (payload->>'filesDone')::int AS files_done,
             (payload->>'rowsUpserted')::int AS rows_upserted,
             jsonb_array_length(payload->'errors') AS error_count
      FROM import_runs ORDER BY started_at DESC LIMIT ${query.limit}
    `);
    return rows;
  }),
);
