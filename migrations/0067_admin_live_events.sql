-- contract v0.18.22 (CONTRACT.md §46, contract.json#adminLiveEvents): the admin live updates stream.
-- One row per change the admin panel must know about; the panel reads the record again with the normal routes.
-- Written by triggers so every service that changes these tables publishes, with no call to forget.
-- NOTIFY is delivered after commit only, so a rolled-back change is never streamed.
CREATE TABLE admin_live_events (
  sequence bigserial PRIMARY KEY,
  type text NOT NULL,
  entity_id text NOT NULL,
  zone_id text,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_live_events_occurred_at ON admin_live_events (occurred_at);
-- The highest sequence pruned so far: a cursor below it missed events and gets one resync (sequences have gaps
-- from rolled-back transactions, so the oldest kept row alone cannot tell).
CREATE TABLE admin_live_pruned (id smallint PRIMARY KEY CHECK (id = 1), up_to bigint NOT NULL);
INSERT INTO admin_live_pruned (id, up_to) VALUES (1, 0);

CREATE FUNCTION admin_live_publish(p_type text, p_entity text, p_zone text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE seq bigint;
BEGIN
  INSERT INTO admin_live_events (type, entity_id, zone_id) VALUES (p_type, p_entity, p_zone) RETURNING sequence INTO seq;
  PERFORM pg_notify('movera_admin_events', json_build_object('sequence', seq)::text);
END $$;

CREATE FUNCTION admin_live_trips() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status OR NEW.driver_id IS DISTINCT FROM OLD.driver_id
     OR NEW.zone_id IS DISTINCT FROM OLD.zone_id OR NEW.payment_status IS DISTINCT FROM OLD.payment_status THEN
    PERFORM admin_live_publish('trip.changed', NEW.trip_id, NEW.zone_id);
  END IF;
  IF NEW.payment_status = 'failed' AND (TG_OP = 'INSERT' OR OLD.payment_status IS DISTINCT FROM 'failed') THEN
    PERFORM admin_live_publish('payment.failed', NEW.trip_id, NEW.zone_id);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER admin_live_trips AFTER INSERT OR UPDATE ON trips FOR EACH ROW EXECUTE FUNCTION admin_live_trips();

CREATE FUNCTION admin_live_drivers() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE z text;
BEGIN
  IF TG_OP = 'INSERT' OR NEW.online_status IS DISTINCT FROM OLD.online_status OR NEW.account_status IS DISTINCT FROM OLD.account_status THEN
    IF coalesce(array_length(NEW.zone_ids, 1), 0) = 0 THEN
      PERFORM admin_live_publish('driver.status', NEW.driver_id, NULL);
    ELSE
      FOREACH z IN ARRAY NEW.zone_ids LOOP
        PERFORM admin_live_publish('driver.status', NEW.driver_id, z);
        IF TG_OP = 'INSERT' OR NEW.online_status IS DISTINCT FROM OLD.online_status THEN
          PERFORM admin_live_publish('zone.supply', z, z);
        END IF;
      END LOOP;
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER admin_live_drivers AFTER INSERT OR UPDATE ON drivers FOR EACH ROW EXECUTE FUNCTION admin_live_drivers();

CREATE FUNCTION admin_live_simple() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- TG_ARGV: event type, id column
  PERFORM admin_live_publish(TG_ARGV[0], to_jsonb(NEW) ->> TG_ARGV[1], to_jsonb(NEW) ->> 'zone_id');
  RETURN NULL;
END $$;
CREATE TRIGGER admin_live_alerts AFTER INSERT OR UPDATE ON admin_alert_records FOR EACH ROW EXECUTE FUNCTION admin_live_simple('alert.changed', 'alert_id');
CREATE TRIGGER admin_live_tickets AFTER INSERT OR UPDATE ON support_tickets FOR EACH ROW EXECUTE FUNCTION admin_live_simple('ticket.changed', 'ticket_id');
CREATE TRIGGER admin_live_incidents AFTER INSERT OR UPDATE ON incidents FOR EACH ROW EXECUTE FUNCTION admin_live_simple('incident.changed', 'incident_id');
CREATE TRIGGER admin_live_approvals AFTER INSERT OR UPDATE ON approvals FOR EACH ROW EXECUTE FUNCTION admin_live_simple('approval.changed', 'approval_id');
