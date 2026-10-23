-- movera-server migration 0001: actors, trips and their event log, idempotency keys, timers.
-- Status and kind values are contract v0.5.0 (contract.json); a contract change that adds one adds a migration.

CREATE TABLE riders (
  rider_id      text PRIMARY KEY CHECK (rider_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  phone         text NOT NULL UNIQUE,
  first_name    text NOT NULL DEFAULT '',
  email         text,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  language      text,
  rating_sum    integer NOT NULL DEFAULT 0,
  rating_count  integer NOT NULL DEFAULT 0,
  version       integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE drivers (
  driver_id         text PRIMARY KEY CHECK (driver_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  phone             text NOT NULL UNIQUE,
  first_name        text NOT NULL DEFAULT '',
  account_status    text NOT NULL DEFAULT 'pending' CHECK (account_status IN ('pending', 'active', 'on_hold', 'suspended')),
  online_status     text NOT NULL DEFAULT 'offline' CHECK (online_status IN ('offline', 'going_online', 'online', 'on_trip', 'suspended')),
  online_since      timestamptz,
  zone_ids          text[] NOT NULL DEFAULT '{}',
  category_ids      text[] NOT NULL DEFAULT '{}',
  vehicle_id        text,
  scheduled_rides   jsonb,
  missed_exclusive  integer NOT NULL DEFAULT 0 CHECK (missed_exclusive >= 0),
  -- Per-driver offer feed cursor (contract OfferEvent.sequence), bumped under this row's lock.
  offer_seq         bigint NOT NULL DEFAULT 0,
  rating_sum        integer NOT NULL DEFAULT 0,
  rating_count      integer NOT NULL DEFAULT 0,
  version           integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- The latest GPS fix per driver, kept apart from drivers so location writes never take the driver row lock
-- (lock order elsewhere is trip, then offer, then driver).
CREATE TABLE driver_locations (
  driver_id    text PRIMARY KEY REFERENCES drivers (driver_id) ON DELETE CASCADE,
  lat          double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng          double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
  accuracy     double precision NOT NULL CHECK (accuracy >= 0),
  heading      double precision,
  speed_mps    double precision,
  moving       boolean NOT NULL DEFAULT false,
  measured_at  timestamptz NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE trips (
  trip_id                text PRIMARY KEY CHECK (trip_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  rider_id               text NOT NULL REFERENCES riders (rider_id),
  driver_id              text REFERENCES drivers (driver_id),
  vehicle_id             text,
  zone_id                text NOT NULL,
  kind                   text NOT NULL CHECK (kind IN ('live', 'scheduled')),
  category_id            text NOT NULL CHECK (category_id ~ '^[a-z][a-z0-9_]{1,31}$'),
  status                 text NOT NULL CHECK (status IN ('draft', 'quoted', 'requested', 'searching', 'offered', 'accepted', 'driver_to_pickup', 'arrived', 'rider_onboard', 'in_trip', 'approaching_dropoff', 'completed', 'cancelled_by_rider', 'cancelled_by_driver', 'cancelled_by_admin', 'cancelled_by_system', 'no_show', 'expired', 'failed')),
  -- version: the projection's optimistic-concurrency number (expectedVersion). sequence: the per-trip realtime
  -- cursor, contiguous from 1, bumped by every event including location fixes that leave version unchanged.
  version                integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  sequence               bigint NOT NULL DEFAULT 0 CHECK (sequence >= 0),
  ended_by_command       text,
  scheduled_at           timestamptz,
  accepted_at            timestamptz,
  search_started_at      timestamptz,
  pickup                 jsonb NOT NULL,
  dropoff                jsonb NOT NULL,
  stops                  jsonb NOT NULL DEFAULT '[]',
  quote_id               text,
  currency               char(3) NOT NULL CHECK (currency IN ('SEK', 'EUR', 'TND')),
  fare_minor             bigint NOT NULL,
  fare_lines             jsonb NOT NULL DEFAULT '[]',
  booked_fare_minor      bigint NOT NULL,
  offer_raised_minor     bigint NOT NULL DEFAULT 0,
  driver_earnings_minor  bigint,
  commission_minor       bigint,
  pickup_pay_minor       bigint,
  driver_bonus_minor     bigint,
  priority               boolean NOT NULL DEFAULT false,
  payment_method         text NOT NULL CHECK (payment_method IN ('card', 'apple_pay', 'google_pay', 'cash', 'wallet')),
  payment_method_id      text,
  payment_status         text CHECK (payment_status IN ('pending', 'authorized', 'captured', 'failed', 'refunded', 'partially_refunded')),
  rating_status          text NOT NULL DEFAULT 'not_requested' CHECK (rating_status IN ('not_requested', 'pending', 'submitted', 'skipped')),
  waiting                jsonb,
  cancellation           jsonb,
  pin_required           boolean NOT NULL DEFAULT false,
  config_versions        jsonb NOT NULL DEFAULT '{}',
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- One live trip per rider that is not over, and one active trip per driver.
CREATE UNIQUE INDEX trips_one_live_per_rider ON trips (rider_id)
  WHERE kind = 'live' AND status NOT IN ('completed', 'cancelled_by_rider', 'cancelled_by_driver', 'cancelled_by_admin', 'cancelled_by_system', 'no_show', 'expired', 'failed');
CREATE UNIQUE INDEX trips_one_active_per_driver ON trips (driver_id)
  WHERE status IN ('accepted', 'driver_to_pickup', 'arrived', 'rider_onboard', 'in_trip', 'approaching_dropoff');
CREATE INDEX trips_zone_status ON trips (zone_id, status, updated_at DESC);
CREATE INDEX trips_rider_created ON trips (rider_id, created_at DESC);

-- Append-only realtime log (contract §4): one row per event, sequence contiguous per trip. The projection is
-- stored unredacted; each subscriber gets the view its actor may see.
CREATE TABLE trip_events (
  trip_id      text NOT NULL REFERENCES trips (trip_id),
  sequence     bigint NOT NULL CHECK (sequence >= 1),
  event_id     text NOT NULL UNIQUE,
  kind         text NOT NULL CHECK (kind IN ('trip_projection', 'rider_cancelled', 'driver_cancelled', 'location', 'driver_arrived', 'rider_on_the_way', 'payment_updated', 'rating_updated', 'message')),
  version      integer NOT NULL CHECK (version >= 1),
  occurred_at  timestamptz NOT NULL,
  projection   jsonb,
  location     jsonb,
  eta_seconds  integer,
  cancel_fee   jsonb,
  message      jsonb,
  PRIMARY KEY (trip_id, sequence)
);

-- Idempotency-Key (contract §1 Headers): bound to actor + subject + method + route + body. Only successful
-- outcomes are kept, inside the command's own transaction, so a failed attempt can be retried.
CREATE TABLE idempotency_keys (
  actor         text NOT NULL CHECK (actor IN ('rider', 'driver', 'admin', 'system')),
  subject_id    text NOT NULL,
  key           text NOT NULL CHECK (length(key) BETWEEN 16 AND 128),
  method        text NOT NULL,
  route         text NOT NULL,
  body_sha256   char(64) NOT NULL,
  status_code   smallint NOT NULL,
  response      jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor, subject_id, key)
);
CREATE INDEX idempotency_keys_created ON idempotency_keys (created_at);

-- Durable timers (offer expiry, dispatch steps, search expiry, …), written in the same transaction as their
-- reason so a crash never loses one. At most one pending timer per (kind, ref_id).
CREATE TABLE timers (
  timer_id      bigserial PRIMARY KEY,
  kind          text NOT NULL,
  ref_id        text NOT NULL,
  due_at        timestamptz NOT NULL,
  payload       jsonb NOT NULL DEFAULT '{}',
  attempts      integer NOT NULL DEFAULT 0,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, ref_id)
);
CREATE INDEX timers_due ON timers (due_at);
