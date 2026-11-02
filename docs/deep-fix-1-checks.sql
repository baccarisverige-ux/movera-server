-- Deep fix 1 (contract 0.18.14), run READ-ONLY against live before merge (no writes).
-- Checker MED 9: approved cars with no ride categories stored. Dispatch now needs the trip's category on the driver's
-- active car; a car listed here keeps the old behaviour (empty = the driver's own chosen types, no narrowing) — see
-- src/dispatch/runtime.ts candidatesFor. The admin should re-approve these cars with their categories.
SELECT v.vehicle_id, v.plate, v.make, v.model, v.updated_at,
       (SELECT count(*) FROM drivers d WHERE d.vehicle_id = v.vehicle_id) AS drivers_using
  FROM vehicles v
 WHERE v.status = 'approved' AND coalesce(cardinality(v.category_ids), 0) = 0
 ORDER BY v.updated_at;

-- Drivers whose active car does not have a category they chose (they stop getting those trips after this deploy).
SELECT d.driver_id, d.vehicle_id, d.category_ids AS chosen, v.category_ids AS car
  FROM drivers d JOIN vehicles v ON v.vehicle_id = d.vehicle_id
 WHERE cardinality(v.category_ids) > 0 AND NOT (d.category_ids <@ v.category_ids);
