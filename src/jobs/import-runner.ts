import type { PoolClient } from 'pg';
import { sql } from 'drizzle-orm';
import { db, pool } from '../db';
import { settings } from '../settings';
import { listPendingFiles, readFile, markProcessed, type RemoteFile } from './object-storage';
import { parseRows, upsertRow } from './import-rows';

/**
 * Pulls new files from object storage and upserts their rows.
 *
 * It is triggered two ways, by an external cron every 30 minutes or by an
 * admin pressing "Import now". The app runs on several autoscaled instances,
 * so those triggers can land on different machines at the same moment.
 */

export const CRON_SLOT_MS = 30 * 60_000;
const CRON_BUDGET_MS = 27_000; // stay under the platform's 30s HTTP limit
const CRON_SLOT_KEY = 'import.cron.lastSlotStart';

export class ImportBusyError extends Error {
  constructor() {
    super('An import is already running');
  }
}

export interface ImportRun {
  id: string;
  trigger: 'manual' | 'cron';
  status: 'running' | 'completed' | 'partial' | 'failed';
  startedAt: string;
  finishedAt?: string;
  filesDone: number;
  rowsUpserted: number;
  errors: { file: string; error: string }[];
}

const RUN_LOCK = "hashtext('import-run')";

export async function startImport(trigger: ImportRun['trigger']): Promise<ImportRun | { skipped: string }> {
  // A session-level advisory lock lives exactly as long as one connection.
  // So we check out a dedicated client and hold it for the whole run. The lock
  // is visible to every instance that talks to the same database.
  const lockClient: PoolClient = await pool.connect();

  try {
    const { rows } = await lockClient.query(`SELECT pg_try_advisory_lock(${RUN_LOCK}) AS locked`);
    if (!rows[0]?.locked) throw new ImportBusyError();

    if (trigger === 'cron') {
      // Dedupe on the scheduled slot, not on "elapsed since last run".
      // With an elapsed check, a few seconds of cron jitter (run at :00:03,
      // next tick at :30:01) would make every other tick get skipped.
      const last = await settings.get(CRON_SLOT_KEY);
      const slot = (t: number) => Math.floor(t / CRON_SLOT_MS);
      if (last && slot(Date.parse(last)) === slot(Date.now())) {
        return { skipped: 'Already ran in this 30-minute slot' };
      }
      await settings.set(CRON_SLOT_KEY, new Date().toISOString());
    }

    const run: ImportRun = {
      id: crypto.randomUUID(),
      trigger,
      status: 'running',
      startedAt: new Date().toISOString(),
      filesDone: 0,
      rowsUpserted: 0,
      errors: [],
    };
    await saveCheckpoint(run);

    // Cron runs get a deadline and leave the rest for the next slot.
    // Manual runs go to completion.
    const deadline = trigger === 'cron' ? Date.now() + CRON_BUDGET_MS : Infinity;
    await execute(run, deadline);

    run.finishedAt = new Date().toISOString();
    await saveCheckpoint(run);
    return run;
  } finally {
    // release(true) destroys the connection instead of returning it to the
    // pool, so the advisory lock is guaranteed to drop even if unlock was
    // never reached.
    lockClient.release(true);
  }
}

async function execute(run: ImportRun, deadline: number) {
  const files = await listPendingFiles();

  for (const file of files) {
    if (Date.now() > deadline) {
      run.status = 'partial';
      return;
    }

    try {
      run.rowsUpserted += await importFile(file);
      run.filesDone++;
      await markProcessed(file.key);
    } catch (err) {
      // One bad file must not block the rest; it stays pending and is retried.
      run.errors.push({ file: file.key, error: err instanceof Error ? err.message : String(err) });
    }

    // Checkpoint after every file: if the instance is killed, the history
    // still shows how far it got.
    await saveCheckpoint(run);
  }

  run.status = run.errors.length ? 'partial' : 'completed';
}

async function importFile(file: RemoteFile): Promise<number> {
  const rows = parseRows(await readFile(file.key));
  let n = 0;

  for (const row of rows) {
    await db.transaction(async (tx) => {
      // Transaction-scoped lock per business key. The same record can be
      // edited from the UI while the import runs; both paths take this lock,
      // so they serialise on that one record without blocking anything else.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('record'), hashtext(${row.externalId}))`);
      if (await upsertRow(tx, row)) n++;
    });
  }
  return n;
}

async function saveCheckpoint(run: ImportRun) {
  await db.execute(sql`
    INSERT INTO import_runs (id, trigger, status, started_at, finished_at, payload)
    VALUES (${run.id}, ${run.trigger}, ${run.status}, ${run.startedAt}, ${run.finishedAt ?? null}, ${JSON.stringify(run)}::jsonb)
    ON CONFLICT (id) DO UPDATE
      SET status = EXCLUDED.status,
          finished_at = EXCLUDED.finished_at,
          payload = EXCLUDED.payload
  `);
}

