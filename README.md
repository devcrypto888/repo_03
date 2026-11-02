# pg-jobs-and-reports

Code samples from a Node.js (Express + Drizzle) backend that uses PostgreSQL
as its job queue, event log and reporting engine, with no Redis and no
message broker.

> These are excerpts that show the architecture. They are **not** a runnable
> app: auth, most routes and earlier migrations are left out.

## Background work

| File | Topic |
|---|---|
| `src/queue/queue.ts` | Durable job queue. `FOR UPDATE SKIP LOCKED` picking, lease/visibility timeout, exponential backoff with jitter, dead-letter state and replay, dedupe through a partial unique index, enqueue inside the caller's transaction. |
| `src/queue/worker.ts` | Worker loop. Concurrency slots, instant wake-up via `LISTEN/NOTIFY` with a polling fallback, lease heartbeats, per-job timeout through `AbortSignal`, graceful drain on SIGTERM. |
| `src/queue/outbox-relay.ts` | Transactional outbox. Events are written in the same transaction as the change and relayed at least once, preserving per-aggregate order. |
| `src/queue/webhooks.ts` | Webhook fan-out and delivery. HMAC signatures with a timestamp, independent retries per endpoint, 410 deactivates the endpoint. |
| `src/jobs/import-runner.ts` | File import across autoscaled instances. A session advisory lock gives one run cluster-wide, cron is deduped by slot, cron runs have a time budget, progress is checkpointed. |
| `src/jobs/import-rows.ts` | CSV → zod → upsert. Header aliases, per-line errors, and a content hash that skips unchanged rows. |
| `src/jobs/backup.ts` | `pg_dump` → gzip → multipart upload, fully streamed, with GFS retention. |
| `src/jobs/refresh-views.ts` | `REFRESH MATERIALIZED VIEW CONCURRENTLY` behind a try-lock, debounced through the queue. |
| `src/jobs/document-numbers.ts` | Gap-free yearly document numbers under `pg_advisory_xact_lock`. |

## Reporting

| File | Topic |
|---|---|
| `src/reports/stock-summary.ts` | Multi-stage CTE. Mixed packages are exploded from JSONB with `CROSS JOIN LATERAL`, there are `FILTER` aggregates per status, and the weighted average leaves out uncosted rows. |
| `src/reports/as-of-snapshot.ts` | Stock at any past date rebuilt from the event log (`ROW_NUMBER` + pivot), with bitemporal "known at" support and a snapshot diff. |
| `src/reports/rollforward.ts` | Monthly roll-forward: opening + receipts − shipments − consumption = closing. Movements are valued with `LATERAL` lookups and cross-checked against the as-of snapshot. The month can only be closed once unexplained movement is zero. |
| `src/reports/cost-allocation.ts` | Largest-remainder cost allocation (sums exactly, never more than 1 cent off) and cascading costs through chained batches in topological order with cycle detection. |
| `src/reports/reservation-aging.ts` | Dense aging buckets (`VALUES` + `CROSS JOIN` + `LEFT JOIN`), then pivoted. |
| `src/reports/latest-readings.ts` | Latest row per group with deterministic tie-breaks, plus `LAG` and rolling windows. |
| `src/reports/export-xlsx.ts` | Workbooks with real numbers, number formats, frozen panes, autofilter and `SUM` totals. |
| `src/sql/natural-sort.ts` | Natural sort key in SQL (`A-2 < A-10`). |

## Database

| File | Topic |
|---|---|
| `migrations/0007_jobs_notify.sql` | Transactional `pg_notify` trigger for instant worker wake-up. |
| `migrations/0008_package_events_trigger.sql` | Change capture in a trigger, with the source and back-dating set via `SET LOCAL`. |
| `migrations/0009_stock_summary_mv.sql` | Daily materialized view built from the event log (`DISTINCT ON` per day). |
| `src/db/schema.ts` | Drizzle schema with partial indexes. |

Tests (Vitest) cover cost allocation, backup retention and CSV parsing.

Stack: TypeScript, Node.js, Express, Drizzle ORM, PostgreSQL 15+, AWS SDK v3, zod, SheetJS, Vitest.
