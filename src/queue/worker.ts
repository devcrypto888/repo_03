import { pick, complete, fail, heartbeat, type Job } from './queue';
import { pool } from '../db';

export type Handler<T> = (job: Job<T>, ctx: { signal: AbortSignal }) => Promise<void>;

interface WorkerOptions {
  concurrency?: number;
  leaseMs?: number;
  idlePollMs?: number;
  /** Per-job hard limit; the handler gets an aborted signal at this point. */
  timeoutMs?: number;
}

/**
 * Worker loop for one queue.
 *
 * - Wakes immediately on NOTIFY (enqueue triggers it via a DB trigger), so
 *   latency is milliseconds and not "next poll". It still polls as a fallback
 *   because LISTEN connections drop silently.
 * - Concurrency is a slot count. It only picks as many jobs as it has free
 *   slots, so it never holds leases it can't work on.
 * - Graceful shutdown: stop picking, let running jobs finish (or abort them at
 *   the deadline), then resolve.
 */
export function startWorker<T>(queue: string, handler: Handler<T>, opts: WorkerOptions = {}) {
  const { concurrency = 4, leaseMs = 60_000, idlePollMs = 5_000, timeoutMs = 10 * 60_000 } = opts;

  let running = 0;
  let stopping = false;
  let wake: (() => void) | null = null;
  const inflight = new Set<Promise<void>>();
  const controllers = new Set<AbortController>();

  const sleep = (ms: number) =>
    new Promise<void>((r) => {
      const t = setTimeout(() => {
        wake = null;
        r();
      }, ms);
      wake = () => {
        clearTimeout(t);
        wake = null;
        r();
      };
    });

  async function runOne(job: Job<T>) {
    const ctrl = new AbortController();
    controllers.add(ctrl);
    const hardStop = setTimeout(() => ctrl.abort(new Error(`Job timed out after ${timeoutMs}ms`)), timeoutMs);
    const beat = setInterval(() => void heartbeat(job.id, leaseMs).catch(() => undefined), leaseMs / 3);

    try {
      await handler(job, { signal: ctrl.signal });
      await complete(job.id);
    } catch (err) {
      await fail(job, err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err)).catch(() => undefined);
    } finally {
      clearTimeout(hardStop);
      clearInterval(beat);
      controllers.delete(ctrl);
      running--;
      wake?.();
    }
  }

  async function loop() {
    while (!stopping) {
      const free = concurrency - running;
      if (free <= 0) {
        await sleep(idlePollMs);
        continue;
      }

      let jobs: Job<T>[] = [];
      try {
        jobs = await pick<T>(queue, free, leaseMs);
      } catch (err) {
        console.error(`[worker:${queue}] pick failed`, (err as Error).message);
        await sleep(idlePollMs * 2);
        continue;
      }

      for (const job of jobs) {
        running++;
        const p = runOne(job);
        inflight.add(p);
        void p.finally(() => inflight.delete(p));
      }

      if (jobs.length < free) await sleep(idlePollMs);
    }
  }

  // LISTEN for instant wake-ups.
  let listenClient: Awaited<ReturnType<typeof pool.connect>> | null = null;
  void (async () => {
    try {
      listenClient = await pool.connect();
      await listenClient.query(`LISTEN "jobs:${queue}"`);
      listenClient.on('notification', () => wake?.());
      listenClient.on('error', () => (listenClient = null));
    } catch {
      /* polling still works */
    }
  })();

  const loopDone = loop();

  return {
    async stop(graceMs = 30_000) {
      stopping = true;
      wake?.();
      await loopDone;
      const grace = setTimeout(() => controllers.forEach((c) => c.abort(new Error('Worker shutting down'))), graceMs);
      await Promise.allSettled([...inflight]);
      clearTimeout(grace);
      listenClient?.release(true);
    },
    stats: () => ({ queue, running, concurrency }),
  };
}
