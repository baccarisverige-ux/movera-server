-- movera: no-transaction
-- v0.18.110 BQ-V44 (contract.json#bonusCampaigns; owner G10-5 "Make bonuses real (Recommended)", Rules
-- decisions/driver-g10.md:9; Q12 bonus zones, decisions/admin-fake-by-group.md:40; plan Rules
-- audits/impact/v44-driver-bonuses.md): driver bonus campaigns. An admin makes a campaign for one operating zone with
-- its own area, a measure (trips / online_hours), a target, an amount and dates; a driver who reaches the target earns
-- the amount once, as one earnings entry kind bonus with bonus_id (trip_id NULL), paid by the next payout.
-- Supervisor MF9 (Rules audits/impact/v44-driver-bonuses-supervisor.md §5) / Rule 46: no transaction, each statement on
-- its own, lock_timeout 3 s (the runner sets the limit back after the CONCURRENTLY build at the end): (1) the new
-- tables; (2) earnings_entries.bonus_id nullable, no default, no inline REFERENCES (no row is rewritten); (3) the FK
-- NOT VALID (no row is read under the lock); (4) VALIDATE (a light lock, app writes go on); (5) the unique index
-- CONCURRENTLY (a campaign pays a driver at most once; MF1's earned_at gate is the first guard, this the second).
-- Every statement can run again (IF NOT EXISTS / a guard), because a no-transaction file that fails runs again whole.
SET lock_timeout = '3s';

-- One campaign. starts_at / ends_at: the window in the zone's time zone (start of start_date to the start of the day
-- after end_date), worked out by the server when it writes the dates, so every counting UPDATE re-checks the window in
-- SQL (MF2) without a time-zone join. pauses: [[from, to], ...] (to null while paused), so a fix is counted only when
-- the campaign was active at the fix's own time too (counting.onlineHours).
CREATE TABLE IF NOT EXISTS bonus_campaigns (
  bonus_id      text PRIMARY KEY CHECK (bonus_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  zone_id       text NOT NULL REFERENCES zones (zone_id),
  names         jsonb NOT NULL,
  measure       text NOT NULL CHECK (measure IN ('trips', 'online_hours')),
  target        integer NOT NULL CHECK (target >= 1),
  amount_minor  bigint NOT NULL CHECK (amount_minor > 0),
  currency      char(3) NOT NULL,
  start_date    date NOT NULL,
  end_date      date NOT NULL,
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz NOT NULL,
  polygon       jsonb NOT NULL,
  south         double precision NOT NULL,
  west          double precision NOT NULL,
  north         double precision NOT NULL,
  east          double precision NOT NULL,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'ended')),
  pauses        jsonb NOT NULL DEFAULT '[]',
  ended_at      timestamptz,
  version       integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL,
  CHECK (start_date <= end_date),
  CHECK (starts_at < ends_at)
);
CREATE INDEX IF NOT EXISTS bonus_campaigns_zone_end ON bonus_campaigns (zone_id, end_date);
CREATE INDEX IF NOT EXISTS bonus_campaigns_open ON bonus_campaigns (zone_id, measure) WHERE status <> 'ended';

-- One row per campaign and driver: the progress, the last counted fix (online_hours), the award and the NEW badge.
CREATE TABLE IF NOT EXISTS bonus_progress (
  bonus_id          text NOT NULL REFERENCES bonus_campaigns (bonus_id),
  driver_id         text NOT NULL REFERENCES drivers (driver_id),
  trips             integer NOT NULL DEFAULT 0 CHECK (trips >= 0),
  online_seconds    integer NOT NULL DEFAULT 0 CHECK (online_seconds >= 0),
  last_inside_at    timestamptz,
  last_received_at  timestamptz,
  last_lat          double precision,
  last_lng          double precision,
  earned_at         timestamptz,
  entry_id          text,
  opened_at         timestamptz,
  updated_at        timestamptz NOT NULL,
  PRIMARY KEY (bonus_id, driver_id)
);
CREATE INDEX IF NOT EXISTS bonus_progress_driver ON bonus_progress (driver_id);

-- A trip counts once per campaign (re-run, retries, two server copies).
CREATE TABLE IF NOT EXISTS bonus_trips_counted (
  bonus_id    text NOT NULL REFERENCES bonus_campaigns (bonus_id),
  trip_id     text NOT NULL REFERENCES trips (trip_id),
  counted_at  timestamptz NOT NULL,
  PRIMARY KEY (bonus_id, trip_id)
);

-- MF7 counting.riderLimit: one rider counts at most once per driver, campaign and zone-local day.
CREATE TABLE IF NOT EXISTS bonus_rider_days (
  bonus_id   text NOT NULL REFERENCES bonus_campaigns (bonus_id),
  driver_id  text NOT NULL REFERENCES drivers (driver_id),
  rider_id   text NOT NULL REFERENCES riders (rider_id),
  local_day  date NOT NULL,
  PRIMARY KEY (bonus_id, driver_id, rider_id, local_day)
);

ALTER TABLE earnings_entries ADD COLUMN IF NOT EXISTS bonus_id text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'earnings_bonus_fk' AND conrelid = 'earnings_entries'::regclass) THEN
    ALTER TABLE earnings_entries ADD CONSTRAINT earnings_bonus_fk FOREIGN KEY (bonus_id) REFERENCES bonus_campaigns (bonus_id) NOT VALID;
  END IF;
END $$;

ALTER TABLE earnings_entries VALIDATE CONSTRAINT earnings_bonus_fk;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS earnings_bonus_once ON earnings_entries (driver_id, bonus_id) WHERE bonus_id IS NOT NULL;
-- undo:
-- DROP INDEX CONCURRENTLY IF EXISTS earnings_bonus_once;
-- ALTER TABLE earnings_entries DROP CONSTRAINT IF EXISTS earnings_bonus_fk;
-- ALTER TABLE earnings_entries DROP COLUMN IF EXISTS bonus_id;
-- DROP TABLE IF EXISTS bonus_rider_days;
-- DROP TABLE IF EXISTS bonus_trips_counted;
-- DROP TABLE IF EXISTS bonus_progress;
-- DROP TABLE IF EXISTS bonus_campaigns;
