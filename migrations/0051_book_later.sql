-- v0.18.17 Book later (CONTRACT.md §41, contract.json#bookLater; owner 2026-11-03 Q1–Q7).
-- The booked ride's plan (mode, dispatchAt, freeChangeUntil, noDriver, who was told) kept on the trip.
ALTER TABLE trips ADD COLUMN IF NOT EXISTS reservation jsonb;
-- A booked ride a driver holds for later (kind scheduled, accepted, reservation.held) is not his current trip: he keeps taking
-- live rides and may hold several booked rides. Every other assigned status stays one per driver.
DROP INDEX IF EXISTS trips_one_active_per_driver;
CREATE UNIQUE INDEX trips_one_active_per_driver ON trips (driver_id)
  WHERE status IN ('accepted', 'driver_to_pickup', 'arrived', 'rider_onboard', 'in_trip', 'approaching_dropoff')
    AND NOT (kind = 'scheduled' AND status = 'accepted' AND coalesce(reservation->>'held', 'false') = 'true');
CREATE INDEX IF NOT EXISTS trips_scheduled_open ON trips (zone_id, scheduled_at) WHERE kind = 'scheduled' AND status IN ('requested', 'accepted');
-- Owner BL-Q4: the driver's home area (set in the driver app) and the rider's favourite drivers.
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS home_area jsonb;
CREATE TABLE IF NOT EXISTS rider_favourite_drivers (
  rider_id   text NOT NULL REFERENCES riders (rider_id),
  driver_id  text NOT NULL REFERENCES drivers (driver_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rider_id, driver_id)
);
