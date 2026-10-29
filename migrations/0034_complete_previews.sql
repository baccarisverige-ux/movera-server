-- movera-server migration 0034: the frozen final price before Collect cash (contract v0.17.3 §26, owner 2026-10-29,
-- live bug A). GET /driver/trips/{tripId}/complete-preview keeps one row per trip (a new preview replaces it) for
-- 2 minutes; POST /trips/{tripId}/complete { previewId } then uses exactly this price. Deleted with the trip.
CREATE TABLE IF NOT EXISTS complete_previews (
  trip_id     text PRIMARY KEY REFERENCES trips (trip_id) ON DELETE CASCADE,
  preview_id  text NOT NULL UNIQUE,
  driver_id   text NOT NULL,
  expires_at  timestamptz NOT NULL,
  early_end   boolean NOT NULL,
  fare_minor  bigint NOT NULL CHECK (fare_minor >= 0),
  wallet_minor bigint NOT NULL CHECK (wallet_minor >= 0),
  -- The trip columns complete sets (fare_minor, fare_lines, driver_earnings_minor, commission_minor); {} = booked fare.
  money       jsonb NOT NULL,
  created_at  timestamptz NOT NULL
);
