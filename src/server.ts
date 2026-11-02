import express, { type ErrorRequestHandler } from 'express';
import { reportsRouter } from './routes/reports.routes';
import { jobsRouter } from './routes/jobs.routes';
import { sessionMiddleware } from './lib/auth';
import { startWorker } from './queue/worker';
import { refreshView } from './jobs/refresh-views';
import { deliverWebhook } from './queue/webhooks';
import { pool } from './db';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(sessionMiddleware);

app.use('/api/reports', reportsRouter);
app.use('/api/jobs', jobsRouter);

const onError: ErrorRequestHandler = (err, _req, res, _next) => {
  // Postgres statement_timeout → 503 with a hint, not a generic 500.
  if (err?.code === '57014') return res.status(503).json({ error: 'The report took too long. Narrow the date range and try again.' });
  console.error(err);
  res.status(500).json({ error: 'Internal error' });
};
app.use(onError);

const server = app.listen(Number(process.env.PORT ?? 3000));

// Workers run in the same process here. In production they can be split
// out by setting RUN_WORKERS=0 on web instances.
const workers =
  process.env.RUN_WORKERS === '0'
    ? []
    : [
        startWorker<{ view: 'stock_daily' }>('refresh-views', async (job) => void (await refreshView(job.payload.view)), { concurrency: 1 }),
        startWorker('webhooks', deliverWebhook, { concurrency: 8, timeoutMs: 15_000 }),
      ];

async function shutdown(signal: string) {
  console.log(`[${signal}] draining…`);
  server.close();
  await Promise.allSettled(workers.map((w) => w.stop(20_000)));
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
