-- movera-server migration 0014: one zone for all of Stockholm county, and Paris (owner, 2026-10-26: "add more
-- zones to test, like all Stockholm and all Paris").
--
-- Dispatch offers a trip only to drivers whose last fix is in the trip's zone, so the district zones of the first
-- test days (Norrmalm, Södermalm, …) kept a driver one street across a border from seeing a ride. Z001 now covers
-- the county, as the apps already assume (the rider app places any Swedish pickup in Z001, the driver onboarding
-- lists "Stockholm län" as Z001); the districts stay as rows for old data but are closed. Paris is FR-PC, the id the
-- contract gives it (contract.json#driverOnboarding.countries.FR), in euro.
UPDATE zones SET name = 'Stockholm län', center_lat = 59.334, center_lng = 18.063,
                 south = 58.95, west = 17.25, north = 60.25, east = 19.35
  WHERE zone_id = 'Z001';
UPDATE zones SET open = false WHERE zone_id IN ('Z002', 'Z003', 'Z004', 'Z005', 'Z006', 'Z007', 'Z008', 'Z009');
INSERT INTO zones (zone_id, name, country, currency, time_zone, kind, center_lat, center_lng, open, south, west, north, east)
  VALUES ('FR-PC', 'Paris', 'FR', 'EUR', 'Europe/Paris', 'operating', 48.8566, 2.3522, true, 48.70, 2.05, 49.05, 2.65)
  ON CONFLICT (zone_id) DO NOTHING;
