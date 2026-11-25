-- v0.18.162 (contract.json#driverCountryFirst.oneTimeFix; owner 2026-11-25 "Yes"): a one-time fix for drivers with no
-- country. A driver in a fleet gets his fleet's country (and, with no zone yet, the fleet's zone): a fleet works in one
-- country (BQ-FLEETCUR). Every other driver with no country stays null: the driver app shows him the country step and
-- the admin sees the alert driver_no_country. Safe to run again (only rows still null are touched).
UPDATE drivers d
   SET country = f.country,
       zone_ids = CASE WHEN cardinality(d.zone_ids) = 0 THEN ARRAY[f.zone_id] ELSE d.zone_ids END,
       updated_at = now()
  FROM fleets f
 WHERE d.fleet_id = f.fleet_id AND d.country IS NULL;
-- undo: nothing to revert safely (no column or constraint changed; the members it set match their fleet and cannot be
-- told apart afterwards). To list them: SELECT d.driver_id FROM drivers d JOIN fleets f ON f.fleet_id = d.fleet_id
-- SELECT 1;
