-- movera-server migration 0027: zones from the server (contract v0.11.0 §20, owner 2026-10-28 and decision #9 "the
-- server's list is the truth; the admin reads it and creates zones on the server").
--
-- A zone gets its names in sv, fr and en, the outline the admin draws on the map (polygon, [[lat, lng], ...]) and a
-- version for expectedVersion. The rectangle (south, west, north, east) stays: it is the polygon's bounding box, the
-- quick prefilter of the zone lookup and what the driver surge map shows. Zones are never deleted, only closed.
ALTER TABLE zones
  ADD COLUMN names      jsonb,
  ADD COLUMN polygon    jsonb,
  ADD COLUMN version    integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  ADD COLUMN updated_at timestamptz,
  ADD COLUMN updated_by text;

-- Every existing zone: its name in all three languages, its rectangle as the outline.
UPDATE zones SET names = jsonb_build_object('sv', name, 'fr', name, 'en', name),
                 polygon = jsonb_build_array(jsonb_build_array(south, west), jsonb_build_array(north, west),
                                             jsonb_build_array(north, east), jsonb_build_array(south, east));
UPDATE zones SET names = '{"sv": "Stockholm län", "fr": "Comté de Stockholm", "en": "Stockholm County"}' WHERE zone_id = 'Z001';
UPDATE zones SET names = '{"sv": "Arlanda flygplats", "fr": "Aéroport d''Arlanda", "en": "Arlanda Airport"}' WHERE zone_id = 'ARN';
UPDATE zones SET names = '{"sv": "Bromma flygplats", "fr": "Aéroport de Bromma", "en": "Bromma Airport"}' WHERE zone_id = 'BMA';

-- Paris & Île-de-France: the whole region (Paris, 77, 78, 91, 92, 93, 94, 95), drawn along the region's border
-- (owner 2026-10-28). Closed until an admin opens it (it was open since 0014).
UPDATE zones SET name = 'Paris & Île-de-France', open = false,
  names = '{"sv": "Paris & Île-de-France", "fr": "Paris & Île-de-France", "en": "Paris & Île-de-France"}',
  polygon = '[[49.24,1.79],[49.23,2.17],[49.17,2.53],[49.12,2.70],[49.08,3.07],[49.04,3.18],[48.93,3.34],[48.82,3.49],[48.53,3.56],[48.37,3.41],[48.27,3.05],[48.13,2.94],[48.12,2.52],[48.29,2.18],[48.36,1.97],[48.44,1.92],[48.65,1.58],[48.76,1.45],[48.94,1.47],[49.08,1.61]]',
  south = 48.12, west = 1.45, north = 49.24, east = 3.56
  WHERE zone_id = 'FR-PC';

INSERT INTO zones (zone_id, name, names, country, currency, time_zone, kind, center_lat, center_lng, open, south, west, north, east, polygon) VALUES
  ('CDG', 'Paris-Charles de Gaulle Airport',
   '{"sv": "Paris-Charles de Gaulle flygplats", "fr": "Aéroport Paris-Charles de Gaulle", "en": "Paris-Charles de Gaulle Airport"}',
   'FR', 'EUR', 'Europe/Paris', 'airport', 49.01, 2.55, false, 48.985, 2.49, 49.035, 2.61,
   '[[49.035,2.49],[49.035,2.61],[48.985,2.61],[48.985,2.49]]'),
  ('ORY', 'Paris-Orly Airport',
   '{"sv": "Paris-Orly flygplats", "fr": "Aéroport Paris-Orly", "en": "Paris-Orly Airport"}',
   'FR', 'EUR', 'Europe/Paris', 'airport', 48.7275, 2.365, false, 48.71, 2.32, 48.745, 2.41,
   '[[48.745,2.32],[48.745,2.41],[48.71,2.41],[48.71,2.32]]'),
  -- Grand Tunis: the governorates of Tunis, Ariana, Ben Arous and Manouba.
  ('TN-TC', 'Greater Tunis',
   '{"sv": "Stor-Tunis", "fr": "Grand Tunis", "en": "Greater Tunis"}',
   'TN', 'TND', 'Africa/Tunis', 'operating', 36.785, 10.085, false, 36.55, 9.75, 37.02, 10.42,
   '[[37.02,10.05],[37.01,10.25],[36.92,10.33],[36.85,10.37],[36.73,10.42],[36.62,10.38],[36.55,10.22],[36.60,10.05],[36.66,9.88],[36.75,9.75],[36.88,9.78],[36.97,9.90]]')
ON CONFLICT (zone_id) DO NOTHING;

ALTER TABLE zones ALTER COLUMN names SET NOT NULL, ALTER COLUMN polygon SET NOT NULL;
