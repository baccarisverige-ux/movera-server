-- v0.18.36 §60 fix job 9 (R27, owner G15 Q5 2026-11-02 + job 9 answers 2026-11-05, contract.json#airportQueue):
-- the airport queue. Rule 33: the queue and its order live here, never in one server copy's memory.
CREATE TABLE IF NOT EXISTS airport_queue_areas (
  area_id                  text PRIMARY KEY,
  airport_zone_id          text NOT NULL UNIQUE REFERENCES zones (zone_id),
  polygon                  jsonb NOT NULL,
  south                    double precision NOT NULL,
  west                     double precision NOT NULL,
  north                    double precision NOT NULL,
  east                     double precision NOT NULL,
  is_on                    boolean NOT NULL DEFAULT false,
  leave_grace_min          integer NOT NULL DEFAULT 3 CHECK (leave_grace_min BETWEEN 0 AND 30),
  offer_seconds            integer NOT NULL DEFAULT 30 CHECK (offer_seconds BETWEEN 5 AND 120),
  max_queue_offers         integer NOT NULL DEFAULT 3 CHECK (max_queue_offers BETWEEN 1 AND 10),
  keep_place_after_decline boolean NOT NULL DEFAULT true,
  updated_at               timestamptz NOT NULL,
  updated_by               text
);
-- One row per stay in a queue. The place is joined_at, then entry_id (a database sequence): the same for every copy.
CREATE TABLE IF NOT EXISTS airport_queue_entries (
  entry_id      bigserial PRIMARY KEY,
  area_id       text NOT NULL REFERENCES airport_queue_areas (area_id),
  driver_id     text NOT NULL REFERENCES drivers (driver_id),
  joined_at     timestamptz NOT NULL,
  outside_since timestamptz,
  left_at       timestamptz,
  left_reason   text
);
-- A driver is in at most one queue at a time: two copies joining him at once → one row (ON CONFLICT DO NOTHING).
CREATE UNIQUE INDEX IF NOT EXISTS airport_queue_entries_one_open ON airport_queue_entries (driver_id) WHERE left_at IS NULL;
CREATE INDEX IF NOT EXISTS airport_queue_entries_order ON airport_queue_entries (area_id, joined_at, entry_id) WHERE left_at IS NULL;
