-- Wake workers instantly instead of waiting for the next poll.
-- pg_notify is transactional: the notification is delivered only on COMMIT,
-- so a worker can never wake up for a job that was rolled back.

CREATE OR REPLACE FUNCTION jobs_notify() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('jobs:' || NEW.queue, NEW.id::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS jobs_notify_trg ON jobs;
CREATE TRIGGER jobs_notify_trg
  AFTER INSERT ON jobs
  FOR EACH ROW
  WHEN (NEW.status = 'queued' AND NEW.run_at <= now())
  EXECUTE FUNCTION jobs_notify();

-- Workers scan only claimable rows; keep that index tiny.
CREATE INDEX IF NOT EXISTS jobs_expired_lease_idx
  ON jobs (queue, locked_until)
  WHERE status = 'running';
