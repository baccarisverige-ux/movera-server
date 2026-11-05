-- v0.18.33 fix job 5 (owner answer 2026-11-05, contract.json#afterTestRules.bookedNext.accept): a live trip a driver on a
-- trip accepted as an Exclusive is queued behind his current trip until it ends. It is not his current trip yet, so it is
-- left out of the one-active-trip-per-driver index (as a held booked ride is).
ALTER TABLE trips ADD COLUMN IF NOT EXISTS next_after_trip_id text;
-- Owner Q5 (2026-11-05): a trip that was queued keeps that fact after it starts, for the late free cancel.
ALTER TABLE trips ADD COLUMN IF NOT EXISTS chained boolean NOT NULL DEFAULT false;
-- Owner Q5: from this moment the rider of the chained trip may cancel free (accept + lateFreeCancelMin).
ALTER TABLE trips ADD COLUMN IF NOT EXISTS chain_free_cancel_at timestamptz;
DROP INDEX IF EXISTS trips_one_active_per_driver;
CREATE UNIQUE INDEX trips_one_active_per_driver ON trips (driver_id)
  WHERE status IN ('accepted', 'driver_to_pickup', 'arrived', 'rider_onboard', 'in_trip', 'approaching_dropoff')
    AND NOT (kind = 'scheduled' AND status = 'accepted' AND coalesce(reservation->>'held', 'false') = 'true')
    AND next_after_trip_id IS NULL;
