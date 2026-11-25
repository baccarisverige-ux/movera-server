-- v0.18.155 (contract.json#driverProfile; owner 2026-11-20 "Now build all", Rules
-- plan/inspiration-ride-change-2026-11-20/driver-profile-v3.html): the driver's public profile settings, the compliment
-- counts kept on write (never counted on read; LOAD RULE) and the short reviews that show only after an admin approves
-- them. Privacy: a review row holds no rider id, phone or address: only the text, the first name the rider allowed (or
-- NULL = anonymous) and the month. trip_id is kept only to make one review per trip (UNIQUE); it is never sent.
-- 0134 (0127 in the draft PR #305). New tables only: no lock on an existing table, no row rewritten. Safe to run again.
CREATE TABLE IF NOT EXISTS driver_public_profiles (
  driver_id text PRIMARY KEY REFERENCES drivers (driver_id) ON DELETE CASCADE,
  languages text[] NOT NULL DEFAULT '{}',
  show_city boolean NOT NULL DEFAULT true,
  show_years boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS driver_compliment_counts (
  driver_id text NOT NULL REFERENCES drivers (driver_id) ON DELETE CASCADE,
  code text NOT NULL,
  count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (driver_id, code)
);
CREATE TABLE IF NOT EXISTS driver_reviews (
  review_id text PRIMARY KEY,
  driver_id text NOT NULL REFERENCES drivers (driver_id) ON DELETE CASCADE,
  trip_id text NOT NULL UNIQUE,
  zone_id text NOT NULL,
  stars integer NOT NULL CHECK (stars BETWEEN 1 AND 5),
  text text NOT NULL,
  name text,
  month text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'hidden')),
  created_at timestamptz NOT NULL,
  moderated_at timestamptz,
  moderated_by text
);
CREATE INDEX IF NOT EXISTS driver_reviews_driver_status ON driver_reviews (driver_id, status, month DESC);
CREATE INDEX IF NOT EXISTS driver_reviews_status_created ON driver_reviews (status, created_at);
-- undo:
-- DROP TABLE IF EXISTS driver_reviews; DROP TABLE IF EXISTS driver_compliment_counts; DROP TABLE IF EXISTS driver_public_profiles;
