-- movera-server migration 0009: the ride from pickup to rating (contract §3, §3.5, §3.7).

-- When each step happened, what the driver collected, and the driver's own rating status (ratingStatus on the
-- projection is the viewer's own: rating_status is the rider's, driver_rating_status the driver's).
ALTER TABLE trips ADD COLUMN arrived_at timestamptz;
ALTER TABLE trips ADD COLUMN boarded_at timestamptz;
ALTER TABLE trips ADD COLUMN started_at timestamptz;
ALTER TABLE trips ADD COLUMN ended_at timestamptz;
ALTER TABLE trips ADD COLUMN cash_collected_minor bigint;
ALTER TABLE trips ADD COLUMN driver_rating_status text NOT NULL DEFAULT 'not_requested'
  CHECK (driver_rating_status IN ('not_requested', 'pending', 'submitted', 'skipped'));
-- How far the driver was from the pickup when they accepted (the rider cancel "came closer" check).
ALTER TABLE trips ADD COLUMN accept_pickup_meters integer;
-- Drivers who cancelled this trip: they get no new offer for it.
ALTER TABLE trips ADD COLUMN cancelled_driver_ids text[] NOT NULL DEFAULT '{}';

-- Every driver cancel, for the driver's cancel rate.
CREATE TABLE driver_cancels (
  trip_id      text NOT NULL REFERENCES trips (trip_id),
  driver_id    text NOT NULL REFERENCES drivers (driver_id),
  at           timestamptz NOT NULL,
  from_status  text NOT NULL,
  reason_code  text NOT NULL,
  note         text,
  PRIMARY KEY (trip_id, driver_id, at)
);
CREATE INDEX driver_cancels_driver ON driver_cancels (driver_id, at DESC);

-- A rider fee (cancel or no-show) and whether it is paid (§3.7). riders.outstanding_minor is the sum of the
-- owed ones; carried_by is the trip whose fare carries it as the outstanding_fee line.
CREATE TABLE rider_fees (
  trip_id      text PRIMARY KEY REFERENCES trips (trip_id),
  rider_id     text NOT NULL REFERENCES riders (rider_id),
  kind         text NOT NULL CHECK (kind IN ('cancel', 'no_show')),
  currency     char(3) NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  status       text NOT NULL CHECK (status IN ('owed', 'paid', 'waived')),
  carried_by   text REFERENCES trips (trip_id),
  created_at   timestamptz NOT NULL,
  settled_at   timestamptz
);
CREATE INDEX rider_fees_owed ON rider_fees (rider_id) WHERE status = 'owed';

-- The driver's money, one row per credit (EarningsPeriod): a trip's earnings, pickup pay, a fee share.
CREATE TABLE earnings_entries (
  entry_id     text PRIMARY KEY,
  driver_id    text NOT NULL REFERENCES drivers (driver_id),
  trip_id      text REFERENCES trips (trip_id),
  kind         text NOT NULL CHECK (kind IN ('trip', 'pickup_pay', 'fee_share', 'adjustment', 'tip')),
  currency     char(3) NOT NULL,
  amount_minor bigint NOT NULL,
  -- for a trip entry: the fare, Movera's share and the cash the driver took
  gross_minor      bigint,
  commission_minor bigint,
  cash_minor       bigint,
  at           timestamptz NOT NULL,
  UNIQUE (driver_id, trip_id, kind)
);
CREATE INDEX earnings_driver ON earnings_entries (driver_id, at);

CREATE TABLE ratings (
  trip_id    text NOT NULL REFERENCES trips (trip_id),
  rater      text NOT NULL CHECK (rater IN ('rider', 'driver')),
  stars      smallint NOT NULL CHECK (stars BETWEEN 1 AND 5),
  tags       text[] NOT NULL DEFAULT '{}',
  comment    text,
  at         timestamptz NOT NULL,
  PRIMARY KEY (trip_id, rater)
);
