-- v0.18.43 §64 fix job 10 (owner G16 Q16-4; G15 2026-11-05 "Never told", "No, only Support"; contract.json#blockedPairs):
-- a rider and a driver who are never matched again. Rule 33: the pair lives only here; every dispatch path reads it.
CREATE TABLE IF NOT EXISTS blocked_pairs (
  pair_id    text PRIMARY KEY,
  rider_id   text NOT NULL REFERENCES riders (rider_id),
  driver_id  text NOT NULL REFERENCES drivers (driver_id),
  blocked_by text NOT NULL CHECK (blocked_by IN ('admin', 'rider', 'driver')),
  reason     text,
  trip_id    text,
  admin_id   text,
  at         timestamptz NOT NULL,
  removed_at timestamptz,
  removed_by text
);
-- One active pair per rider + driver: two copies blocking at once → one row (INSERT ... ON CONFLICT DO NOTHING).
CREATE UNIQUE INDEX IF NOT EXISTS blocked_pairs_one_active ON blocked_pairs (rider_id, driver_id) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS blocked_pairs_driver ON blocked_pairs (driver_id) WHERE removed_at IS NULL;
