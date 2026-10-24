-- movera-server migration 0008: automatic dispatch (contract v0.5.1 §3.6, §4 offer feed).

-- One running search per trip: the dispatch document it started with, where it is in its steps, and its end.
CREATE TABLE searches (
  trip_id       text PRIMARY KEY REFERENCES trips (trip_id),
  started_at    timestamptz NOT NULL,
  start_mode    text CHECK (start_mode IN ('radar', 'exclusive')),
  busy          numeric(6, 1) NOT NULL,
  document      jsonb NOT NULL,
  doc_version   integer NOT NULL,
  state         jsonb,
  end_at        timestamptz NOT NULL,
  -- the rider-waiting steps with their (possibly moved) times, and which fired / were answered
  steps         jsonb NOT NULL DEFAULT '[]',
  fired         jsonb NOT NULL DEFAULT '[]',
  answered      jsonb NOT NULL DEFAULT '[]',
  rounds        integer NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE offers (
  offer_id            text PRIMARY KEY,
  trip_id             text NOT NULL REFERENCES trips (trip_id),
  driver_id           text NOT NULL REFERENCES drivers (driver_id),
  kind                text NOT NULL CHECK (kind IN ('radar', 'exclusive', 'assigned', 'reservation', 'next_trip')),
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'claimed', 'claimed_elsewhere', 'declined', 'expired', 'withdrawn')),
  version             integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  round               integer NOT NULL,
  source              text NOT NULL DEFAULT 'system' CHECK (source IN ('system', 'admin')),
  group_id            text,
  reason_code         text,
  currency            char(3) NOT NULL,
  fare_minor          bigint NOT NULL,
  driver_earnings_minor bigint NOT NULL,
  pickup_pay_minor    bigint NOT NULL DEFAULT 0,
  pickup_meters       integer NOT NULL,
  pickup_eta_seconds  integer NOT NULL,
  sent_at             timestamptz NOT NULL,
  expires_at          timestamptz NOT NULL,
  answered_at         timestamptz,
  decline_reason      text
);
CREATE INDEX offers_trip ON offers (trip_id, status);
CREATE INDEX offers_driver ON offers (driver_id, status, sent_at DESC);

-- The per-driver offer feed (OfferEvent, contract §4): sequence contiguous per driver (drivers.offer_seq).
CREATE TABLE offer_events (
  driver_id    text NOT NULL REFERENCES drivers (driver_id),
  sequence     bigint NOT NULL CHECK (sequence >= 1),
  event_id     text NOT NULL UNIQUE,
  kind         text NOT NULL CHECK (kind IN ('offer_created', 'offer_updated', 'offer_withdrawn')),
  offer        jsonb NOT NULL,
  occurred_at  timestamptz NOT NULL,
  PRIMARY KEY (driver_id, sequence)
);

-- The live switch per zone (DispatchControl): pause, or a forced mode for new searches.
CREATE TABLE dispatch_controls (
  zone_id   text PRIMARY KEY REFERENCES zones (zone_id),
  paused    boolean NOT NULL DEFAULT false,
  mode      text CHECK (mode IN ('radar', 'exclusive')),
  by        text,
  at        timestamptz NOT NULL,
  version   integer NOT NULL CHECK (version >= 1)
);

-- What the rider sees of their driver once one accepted (DriverSummary), kept with the trip.
ALTER TABLE trips ADD COLUMN driver_summary jsonb;
