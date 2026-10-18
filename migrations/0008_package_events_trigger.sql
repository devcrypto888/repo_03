-- Change capture for packages: every tracked column change becomes a row in
-- package_events. Done in the DB, not the app, so that writes from ad-hoc
-- scripts and repairs are captured too.
--
-- The app can set `app.event_source` and `app.occurred_at` per transaction
-- (SET LOCAL) to label the change and back-date it (e.g. an import of a
-- paper record from last week). Otherwise it defaults to now() / 'ui'.

CREATE OR REPLACE FUNCTION packages_capture_events() RETURNS trigger AS $$
DECLARE
  src text := COALESCE(NULLIF(current_setting('app.event_source', true), ''), 'ui');
  at  timestamptz := COALESCE(NULLIF(current_setting('app.occurred_at', true), '')::timestamptz, now());
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO package_events (package_id, field, old_value, new_value, source, occurred_at)
    VALUES
      (NEW.id, 'status',     NULL, NEW.status::text,     src, at),
      (NEW.id, 'qty',        NULL, NEW.qty::text,        src, at),
      (NEW.id, 'total_cost', NULL, NEW.total_cost::text, src, at);
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO package_events (package_id, field, old_value, new_value, source, occurred_at)
    VALUES (NEW.id, 'status', OLD.status::text, NEW.status::text, src, at);
  END IF;
  IF NEW.qty IS DISTINCT FROM OLD.qty THEN
    INSERT INTO package_events (package_id, field, old_value, new_value, source, occurred_at)
    VALUES (NEW.id, 'qty', OLD.qty::text, NEW.qty::text, src, at);
  END IF;
  IF NEW.total_cost IS DISTINCT FROM OLD.total_cost THEN
    INSERT INTO package_events (package_id, field, old_value, new_value, source, occurred_at)
    VALUES (NEW.id, 'total_cost', OLD.total_cost::text, NEW.total_cost::text, src, at);
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS packages_capture_events_trg ON packages;
CREATE TRIGGER packages_capture_events_trg
  BEFORE INSERT OR UPDATE ON packages
  FOR EACH ROW EXECUTE FUNCTION packages_capture_events();
