-- movera-server migration 0022: real data for the admin (contract v0.9.0 §16, owner real-data decisions part 3).

-- Ratings: an admin hides or restores one. A hidden rating does not count in the person's average nor in the
-- low-rating risk signal (owner, 2026-10-27).
ALTER TABLE ratings ADD COLUMN hidden boolean NOT NULL DEFAULT false;
ALTER TABLE ratings ADD COLUMN hidden_by text;
ALTER TABLE ratings ADD COLUMN hidden_at timestamptz;
ALTER TABLE ratings ADD COLUMN hide_reason text;
CREATE INDEX ratings_at ON ratings (at DESC, trip_id);

-- Payouts: one per driver and week (the nightly job) or made by hand for a date range. An earnings entry belongs
-- to at most one payout, so a trip is never paid twice.
CREATE TABLE payouts (
  payout_id     text PRIMARY KEY,
  driver_id     text NOT NULL REFERENCES drivers (driver_id),
  zone_id       text,
  currency      char(3) NOT NULL,
  amount_minor  bigint NOT NULL,
  lines         jsonb NOT NULL,
  trip_count    integer NOT NULL CHECK (trip_count >= 0),
  source        text NOT NULL CHECK (source IN ('weekly', 'manual')),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid')),
  period_start  timestamptz NOT NULL,
  period_end    timestamptz NOT NULL CHECK (period_end > period_start),
  note          text,
  created_by    text,
  created_at    timestamptz NOT NULL,
  paid_at       timestamptz,
  paid_by       text
);
CREATE UNIQUE INDEX payouts_weekly_once ON payouts (driver_id, period_start) WHERE source = 'weekly';
CREATE INDEX payouts_list ON payouts (created_at DESC, payout_id);
ALTER TABLE earnings_entries ADD COLUMN payout_id text REFERENCES payouts (payout_id);
CREATE INDEX earnings_unpaid ON earnings_entries (driver_id, at) WHERE payout_id IS NULL;

-- Support tickets from the rider and driver apps, and the messages on them (the person's and the admins' answers).
CREATE TABLE support_tickets (
  ticket_id        text PRIMARY KEY,
  opened_by        text NOT NULL CHECK (opened_by IN ('rider', 'driver')),
  rider_id         text REFERENCES riders (rider_id),
  driver_id        text REFERENCES drivers (driver_id),
  trip_id          text REFERENCES trips (trip_id),
  zone_id          text,
  category         text NOT NULL,
  subject          text NOT NULL,
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'pending', 'resolved', 'closed')),
  priority         text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL,
  last_message_at  timestamptz NOT NULL,
  CHECK ((opened_by = 'rider' AND rider_id IS NOT NULL) OR (opened_by = 'driver' AND driver_id IS NOT NULL))
);
CREATE INDEX support_tickets_list ON support_tickets (updated_at DESC, ticket_id);
CREATE INDEX support_tickets_rider ON support_tickets (rider_id, updated_at DESC);
CREATE INDEX support_tickets_driver ON support_tickets (driver_id, updated_at DESC);
CREATE TABLE ticket_messages (
  n           bigserial UNIQUE,
  message_id  text PRIMARY KEY,
  ticket_id   text NOT NULL REFERENCES support_tickets (ticket_id),
  sender      text NOT NULL CHECK (sender IN ('rider', 'driver', 'support')),
  admin_id    text,
  text        text NOT NULL,
  at          timestamptz NOT NULL
);
CREATE INDEX ticket_messages_ticket ON ticket_messages (ticket_id, n);

-- The admin dispatch feed (AdminDispatchEvent): written by triggers on offers and trips, so every path that sends,
-- answers or ends an offer, or adds a driver bonus, is in it without each one remembering to write.
CREATE TABLE dispatch_events (
  sequence     bigserial PRIMARY KEY,
  event_id     text NOT NULL UNIQUE DEFAULT ('dev_' || md5(random()::text || clock_timestamp()::text)),
  kind         text NOT NULL CHECK (kind IN ('offer_sent', 'offer_declined', 'offer_expired', 'offer_withdrawn', 'offer_accepted', 'assignment_locked', 'driver_bonus_added')),
  trip_id      text NOT NULL,
  zone_id      text,
  offer_id     text,
  group_id     text,
  occurred_at  timestamptz NOT NULL
);

CREATE FUNCTION dispatch_event_from_offer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  zone text;
  at timestamptz;
BEGIN
  SELECT zone_id INTO zone FROM trips WHERE trip_id = NEW.trip_id;
  IF TG_OP = 'INSERT' THEN
    INSERT INTO dispatch_events (kind, trip_id, zone_id, offer_id, group_id, occurred_at) VALUES ('offer_sent', NEW.trip_id, zone, NEW.offer_id, NEW.group_id, NEW.sent_at);
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    at := coalesce(NEW.answered_at, NEW.sent_at);
    IF NEW.status = 'declined' THEN
      INSERT INTO dispatch_events (kind, trip_id, zone_id, offer_id, group_id, occurred_at) VALUES ('offer_declined', NEW.trip_id, zone, NEW.offer_id, NEW.group_id, at);
    ELSIF NEW.status = 'expired' THEN
      INSERT INTO dispatch_events (kind, trip_id, zone_id, offer_id, group_id, occurred_at) VALUES ('offer_expired', NEW.trip_id, zone, NEW.offer_id, NEW.group_id, at);
    ELSIF NEW.status IN ('withdrawn', 'claimed_elsewhere') THEN
      INSERT INTO dispatch_events (kind, trip_id, zone_id, offer_id, group_id, occurred_at) VALUES ('offer_withdrawn', NEW.trip_id, zone, NEW.offer_id, NEW.group_id, at);
    ELSIF NEW.status = 'claimed' THEN
      INSERT INTO dispatch_events (kind, trip_id, zone_id, offer_id, group_id, occurred_at) VALUES ('offer_accepted', NEW.trip_id, zone, NEW.offer_id, NEW.group_id, at);
      INSERT INTO dispatch_events (kind, trip_id, zone_id, offer_id, group_id, occurred_at) VALUES ('assignment_locked', NEW.trip_id, zone, NEW.offer_id, NEW.group_id, at);
    END IF;
  ELSE
    RETURN NEW;
  END IF;
  PERFORM pg_notify('movera_dispatch_events', '');
  RETURN NEW;
END $$;
CREATE TRIGGER offers_dispatch_events AFTER INSERT OR UPDATE OF status ON offers FOR EACH ROW EXECUTE FUNCTION dispatch_event_from_offer();

CREATE FUNCTION dispatch_event_from_bonus() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(NEW.driver_bonus_minor, 0) > coalesce(OLD.driver_bonus_minor, 0) THEN
    INSERT INTO dispatch_events (kind, trip_id, zone_id, occurred_at) VALUES ('driver_bonus_added', NEW.trip_id, NEW.zone_id, coalesce(NEW.updated_at, now()));
    PERFORM pg_notify('movera_dispatch_events', '');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trips_dispatch_bonus AFTER UPDATE OF driver_bonus_minor ON trips FOR EACH ROW EXECUTE FUNCTION dispatch_event_from_bonus();

-- KPIs: one row per zone and zone-local day, written by the nightly summary (idempotent: replaced on a re-run).
CREATE TABLE kpi_days (
  zone_id          text NOT NULL,
  day              date NOT NULL,
  currency         char(3) NOT NULL,
  completed_trips  integer NOT NULL,
  cancelled_trips  integer NOT NULL,
  no_shows         integer NOT NULL,
  gross_minor      bigint NOT NULL,
  commission_minor bigint NOT NULL,
  driver_earnings_minor bigint NOT NULL,
  pickup_pay_minor bigint NOT NULL,
  driver_bonus_minor bigint NOT NULL,
  cash_collected_minor bigint NOT NULL,
  wallet_applied_minor bigint NOT NULL,
  new_riders       integer NOT NULL,
  new_drivers      integer NOT NULL,
  computed_at      timestamptz NOT NULL,
  PRIMARY KEY (zone_id, day)
);
