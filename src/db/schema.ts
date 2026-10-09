import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const packageStatus = pgEnum('package_status', ['Receiving', 'In-Process', 'Ready', 'Reserved', 'Shipped', 'Consumed']);

export const packages = pgTable(
  'packages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    externalId: text('external_id').notNull(),
    status: packageStatus('status').notNull().default('Receiving'),
    category: text('category').notNull(),
    size: text('size').notNull(),
    variant: text('variant').notNull(),
    packaging: text('packaging'),
    station: text('station'),
    qty: numeric('qty', { precision: 14, scale: 3 }).notNull(),
    unitCost: numeric('unit_cost', { precision: 14, scale: 4 }),
    totalCost: numeric('total_cost', { precision: 14, scale: 2 }),
    composition: jsonb('composition').$type<{ variant: string; qty: number; totalCost?: number }[]>(),
    isVirtual: boolean('is_virtual').notNull().default(false),
    /** sha256 of the normalised source row; lets the importer skip unchanged rows */
    sourceHash: text('source_hash'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    externalIdx: uniqueIndex('packages_external_id_uq').on(t.externalId),
    // Partial index: dashboards only ever look at in-stock rows.
    activeIdx: index('packages_active_sku_idx')
      .on(t.category, t.size, t.variant)
      .where(sql`status NOT IN ('Shipped', 'Consumed') AND NOT is_virtual`),
  }),
);

/**
 * Append-only event log. Every status, qty or cost change of a package writes
 * one row. The as-of report reconstructs any past date from this table alone.
 */
export const packageEvents = pgTable(
  'package_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    packageId: uuid('package_id').notNull(),
    field: text('field').notNull(), // 'status' | 'qty' | 'total_cost' | ...
    oldValue: text('old_value'),
    newValue: text('new_value'),
    source: text('source').notNull(), // 'import' | 'ui' | 'repair'
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byPkgTime: index('package_events_pkg_time_idx').on(t.packageId, t.field, t.occurredAt),
  }),
);

export const reservations = pgTable('reservations', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: uuid('order_id').notNull(),
  sku: text('sku').notNull(),
  qty: numeric('qty', { precision: 14, scale: 3 }).notNull(),
  reservedAt: timestamp('reserved_at', { withTimezone: true }).notNull(),
  releasedAt: timestamp('released_at', { withTimezone: true }),
});

export const orders = pgTable('orders', {
  id: uuid('id').primaryKey().defaultRandom(),
  number: text('number').notNull().unique(),
  customerId: uuid('customer_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sensorReadings = pgTable(
  'sensor_readings',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    zoneId: integer('zone_id').notNull(),
    sensorId: integer('sensor_id').notNull(),
    dayIndex: integer('day_index').notNull(),
    value: numeric('value', { precision: 8, scale: 2 }),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ latest: index('sensor_latest_idx').on(t.sensorId, t.dayIndex, t.recordedAt, t.id) }),
);

export const jobs = pgTable(
  'jobs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    queue: text('queue').notNull(),
    payload: jsonb('payload').notNull(),
    status: text('status').notNull().default('queued'), // queued | running | done | failed | dead
    priority: integer('priority').notNull().default(0),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    lockedBy: text('locked_by'),
    lastError: text('last_error'),
    dedupeKey: text('dedupe_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => ({
    pick: index('jobs_pick_idx').on(t.queue, t.priority, t.runAt).where(sql`status = 'queued'`),
    dedupe: uniqueIndex('jobs_dedupe_uq').on(t.queue, t.dedupeKey).where(sql`dedupe_key IS NOT NULL AND status IN ('queued','running')`),
  }),
);

export const outbox = pgTable(
  'outbox',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    topic: text('topic').notNull(),
    aggregateId: text('aggregate_id').notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
  },
  (t) => ({ unpublished: index('outbox_unpublished_idx').on(t.id).where(sql`published_at IS NULL`) }),
);

export const importRuns = pgTable('import_runs', {
  id: uuid('id').primaryKey(),
  trigger: text('trigger').notNull(),
  status: text('status').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  payload: jsonb('payload').notNull(),
});

export const monthlyCloses = pgTable(
  'monthly_closes',
  {
    month: date('month').notNull(),
    category: text('category').notNull(),
    openingQty: numeric('opening_qty', { precision: 16, scale: 3 }).notNull(),
    openingValue: numeric('opening_value', { precision: 16, scale: 2 }).notNull(),
    closingQty: numeric('closing_qty', { precision: 16, scale: 3 }).notNull(),
    closingValue: numeric('closing_value', { precision: 16, scale: 2 }).notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: uniqueIndex('monthly_closes_pk').on(t.month, t.category) }),
);

export const settingsTable = pgTable('system_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
