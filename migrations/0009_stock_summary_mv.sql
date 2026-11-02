-- Materialized daily snapshot used by the dashboard's trend charts.
-- Refreshed CONCURRENTLY by a job, so readers never block. That requires a
-- unique index on the view.

CREATE MATERIALIZED VIEW IF NOT EXISTS stock_daily AS
WITH days AS (
  SELECT d::date AS day
  FROM generate_series(date_trunc('day', now()) - interval '180 days', date_trunc('day', now()), interval '1 day') d
),
status_at AS (
  -- For each package and day, its status as of end of that day.
  SELECT DISTINCT ON (e.package_id, d.day)
    d.day, e.package_id, e.new_value AS status
  FROM days d
  JOIN package_events e
    ON e.field = 'status' AND e.occurred_at < d.day + interval '1 day'
  ORDER BY e.package_id, d.day, e.occurred_at DESC, e.id DESC
),
qty_at AS (
  SELECT DISTINCT ON (e.package_id, d.day)
    d.day, e.package_id, e.new_value::numeric AS qty
  FROM days d
  JOIN package_events e
    ON e.field = 'qty' AND e.occurred_at < d.day + interval '1 day'
  ORDER BY e.package_id, d.day, e.occurred_at DESC, e.id DESC
)
SELECT
  s.day,
  p.category,
  s.status,
  COUNT(*)::int        AS packages,
  SUM(q.qty)           AS qty
FROM status_at s
JOIN qty_at q USING (day, package_id)
JOIN packages p ON p.id = s.package_id
WHERE s.status NOT IN ('Shipped', 'Consumed')
GROUP BY s.day, p.category, s.status;

CREATE UNIQUE INDEX IF NOT EXISTS stock_daily_uq ON stock_daily (day, category, status);
