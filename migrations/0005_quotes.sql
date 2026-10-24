-- movera-server migration 0005: zone areas and quotes (contract §3.5, §7 POST /quotes).

-- Each zone's area as the admin panel draws it today (a box: webapp/src/zones/releases.ts stockholmZones).
ALTER TABLE zones ADD COLUMN south double precision, ADD COLUMN west double precision,
                  ADD COLUMN north double precision, ADD COLUMN east double precision;
UPDATE zones SET south = 59.325, west = 18.06,  north = 59.35,  east = 18.11  WHERE zone_id = 'Z001';
UPDATE zones SET south = 59.255, west = 18.008, north = 59.318, east = 18.145 WHERE zone_id = 'Z002';
UPDATE zones SET south = 59.325, west = 18.118, north = 59.39,  east = 18.185 WHERE zone_id = 'Z003';
UPDATE zones SET south = 59.322, west = 18.008, north = 59.355, east = 18.055 WHERE zone_id = 'Z004';
UPDATE zones SET south = 59.358, west = 18.015, north = 59.395, east = 18.1   WHERE zone_id = 'Z005';
UPDATE zones SET south = 59.3,   west = 17.9,   north = 59.345, east = 18.0   WHERE zone_id = 'Z006';
UPDATE zones SET south = 59.4,   west = 17.99,  north = 59.445, east = 18.055 WHERE zone_id = 'Z007';
UPDATE zones SET south = 59.4,   west = 17.85,  north = 59.455, east = 17.97  WHERE zone_id = 'Z008';
UPDATE zones SET south = 59.17,  west = 17.52,  north = 59.23,  east = 17.7   WHERE zone_id = 'Z009';
UPDATE zones SET south = 59.62,  west = 17.85,  north = 59.68,  east = 17.97  WHERE zone_id = 'ARN';
UPDATE zones SET south = 59.348, west = 17.8,   north = 59.378, east = 17.88  WHERE zone_id = 'BMA';
ALTER TABLE zones ALTER COLUMN south SET NOT NULL, ALTER COLUMN west SET NOT NULL,
                  ALTER COLUMN north SET NOT NULL, ALTER COLUMN east SET NOT NULL,
                  ADD CONSTRAINT zones_box CHECK (south < north AND west < east);

-- A priced offer to one rider for one category, valid until expires_at. A trip is requested from a quote.
CREATE TABLE quotes (
  quote_id          text PRIMARY KEY,
  rider_id          text NOT NULL REFERENCES riders (rider_id),
  zone_id           text NOT NULL REFERENCES zones (zone_id),
  category_id       text NOT NULL,
  kind              text NOT NULL CHECK (kind IN ('live', 'scheduled')),
  scheduled_at      timestamptz,
  pickup            jsonb NOT NULL,
  dropoff           jsonb NOT NULL,
  stops             jsonb NOT NULL DEFAULT '[]',
  distance_meters   integer NOT NULL CHECK (distance_meters >= 0),
  duration_seconds  integer NOT NULL CHECK (duration_seconds >= 0),
  route_source      text NOT NULL CHECK (route_source IN ('osrm', 'estimate')),
  surge_multiplier  numeric(4, 2) NOT NULL DEFAULT 1 CHECK (surge_multiplier >= 1),
  currency          char(3) NOT NULL,
  total_minor       bigint NOT NULL,
  fare_lines        jsonb NOT NULL,
  driver_earnings_minor bigint NOT NULL,
  pricing_version   integer NOT NULL,
  payment_method    text,
  expires_at        timestamptz NOT NULL,
  used_at           timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX quotes_rider ON quotes (rider_id, created_at DESC);
CREATE INDEX quotes_expires ON quotes (expires_at);
