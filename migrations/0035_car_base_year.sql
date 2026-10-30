-- movera-server migration 0035: driver group 2 re-check R2 (contract v0.18.3 §28, owner 2026-10-30 "Year rule for every
-- car (Recommended)": "the 2012 test car becomes not approved"). Every approved car built before its country's base year
-- goes back to pending, so an admin reviews it again and cannot approve it (409 vehicle_rules_not_met). The base year is
-- the smallest minYear of the published onboarding document's ride categories that are on (child_seat is an extra),
-- else the contract default (SE 2015, FR 2016, TN 2012). A car's country is its fleet's, else its driver's.
WITH cars AS (
  SELECT v.vehicle_id, v.year, COALESCE(f.country, d.country) AS country
  FROM vehicles v
  LEFT JOIN fleets f ON f.fleet_id = v.fleet_id
  LEFT JOIN drivers d ON d.driver_id = v.driver_id
  WHERE v.status = 'approved'
), base AS (
  SELECT c.vehicle_id, c.year,
    COALESCE(
      (SELECT min((r ->> 'minYear')::integer)
         FROM config_live l, jsonb_array_elements(l.document -> 'vehicles' -> 'categories') r
        WHERE l.doc = 'onboarding' AND l.zone_id = 'standard-' || c.country
          AND (r ->> 'on')::boolean AND r ->> 'category' <> 'child_seat'),
      CASE c.country WHEN 'SE' THEN 2015 WHEN 'FR' THEN 2016 WHEN 'TN' THEN 2012 END
    ) AS base_year
  FROM cars c
)
UPDATE vehicles v SET status = 'pending', version = v.version + 1, updated_at = now()
FROM base b
WHERE v.vehicle_id = b.vehicle_id AND b.base_year IS NOT NULL AND b.year < b.base_year;
