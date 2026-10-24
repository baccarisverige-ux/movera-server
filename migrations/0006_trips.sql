-- movera-server migration 0006: what a trip keeps from its quote, the rider's owed fees and consents,
-- and account deletion requests (contract §2, §3, §3.7; v0.5.1).

ALTER TABLE riders
  ADD COLUMN outstanding_minor bigint NOT NULL DEFAULT 0 CHECK (outstanding_minor >= 0),
  ADD COLUMN outstanding_source_trip_id text,
  ADD COLUMN consents jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN deletion_requested_at timestamptz;

ALTER TABLE trips
  ADD COLUMN distance_meters integer CHECK (distance_meters >= 0),
  ADD COLUMN duration_seconds integer CHECK (duration_seconds >= 0),
  ADD COLUMN surge_multiplier numeric(4, 2) NOT NULL DEFAULT 1 CHECK (surge_multiplier >= 1),
  ADD COLUMN pricing_version integer,
  ADD COLUMN quote_expires_at timestamptz,
  ADD COLUMN notes text,
  ADD COLUMN search_step jsonb;

CREATE INDEX trips_status_updated ON trips (status, updated_at DESC);
