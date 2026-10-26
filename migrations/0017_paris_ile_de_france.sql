-- movera-server migration 0017: the Paris zone covers all of Île-de-France (owner, 2026-10-26: "Add Île-de-France
-- all"). 0014 drew FR-PC around Paris and the inner suburbs only (48.70–49.05 N, 2.05–2.65 E); a pickup further out
-- in the region (Fontainebleau, Provins, Mantes-la-Jolie, Rambouillet, Disneyland) got "not available here yet", and
-- the rider app listed the categories with no price. Like Z001 for Stockholm county, the zone is the region's
-- bounding box (it also takes in a little of the neighbouring regions at its corners).
UPDATE zones SET name = 'Paris – Île-de-France', south = 48.12, west = 1.44, north = 49.24, east = 3.56
  WHERE zone_id = 'FR-PC';
