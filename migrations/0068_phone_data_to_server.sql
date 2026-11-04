-- BASE B13 (contract v0.18.26 §47, contract.json#phoneDataToServer; owner 2026-11-03 "Phone-only data: Yes, all to
-- server"): the rider's saved places, the driver's ride preferences (switched-off categories, read by dispatch) and the
-- driver's emergency contacts move from the phone to the server. Each row is read only by its owner; an admin reads
-- emergency contacts only through a safety incident (audited). Numbered 0068 after the open 0066 (server alerts) and
-- 0067 (admin live updates) branches; renumber at merge if needed.
CREATE TABLE IF NOT EXISTS rider_places (
  place_id   text PRIMARY KEY,
  rider_id   text NOT NULL REFERENCES riders (rider_id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('home', 'work', 'other')),
  type       text CHECK (type IS NULL OR type ~ '^[a-z][a-z0-9_-]{0,31}$'),
  label      text NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  address    text NOT NULL CHECK (length(address) BETWEEN 1 AND 512),
  lat        double precision CHECK (lat IS NULL OR lat BETWEEN -90 AND 90),
  lng        double precision CHECK (lng IS NULL OR lng BETWEEN -180 AND 180),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS rider_places_rider ON rider_places (rider_id, created_at);
-- Home and Work: one each per rider.
CREATE UNIQUE INDEX IF NOT EXISTS rider_places_one_home_work ON rider_places (rider_id, kind) WHERE kind IN ('home', 'work');

-- The one-time upload of the phone's places (POST /rider/places/import) is applied once per rider.
CREATE TABLE IF NOT EXISTS rider_places_imported (
  rider_id    text PRIMARY KEY REFERENCES riders (rider_id) ON DELETE CASCADE,
  imported_at timestamptz NOT NULL
);

-- The driver's own choices; updated_at NULL never happens (no row = never saved, the app then uploads once).
CREATE TABLE IF NOT EXISTS driver_phone_data (
  driver_id          text PRIMARY KEY REFERENCES drivers (driver_id) ON DELETE CASCADE,
  categories_off     text[] NOT NULL DEFAULT '{}',
  preferences_at     timestamptz,
  emergency_contacts jsonb NOT NULL DEFAULT '[]',
  contacts_at        timestamptz
);
