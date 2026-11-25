-- v0.18.160 (owner 2026-11-23, Rules decisions/session-2026-11-06.md "2026-11-23 OWNER DECISION": the rider can adjust
-- the pickup up to 300 m for free): every published rider and driver document still on the old 200 m pickup move limit
-- goes to 300, as the next version with a history row; drafts too. A zone the admin set to another value keeps it.
-- A trip already booked keeps the value of its booking time (trips.booking_rules), so no trip row changes. Same pattern as
-- migration 0041 (500 -> 200).
WITH changed AS (
  UPDATE config_live
     SET document = jsonb_set(jsonb_set(document, '{booking,maxPickupMoveMeters}', '300'::jsonb), '{version}', to_jsonb(version + 1))
                    || jsonb_build_object('publishedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
         version = version + 1,
         published_at = now(),
         published_by = NULL
   WHERE doc IN ('rider_app_config', 'driver_app_config')
     AND (document #>> '{booking,maxPickupMoveMeters}')::numeric = 200
  RETURNING doc, zone_id, version, document, published_at
)
INSERT INTO config_history (doc, zone_id, version, document, published_at, published_by, approved_by, note)
  SELECT doc, zone_id, version, document, published_at, NULL, NULL, 'Free pickup move: limit 200 -> 300 m (owner 2026-11-23, contract v0.18.160, migration 0133)'
  FROM changed
  ON CONFLICT (doc, zone_id, version) DO NOTHING;
UPDATE config_drafts
   SET document = jsonb_set(document, '{booking,maxPickupMoveMeters}', '300'::jsonb), version = version + 1, updated_at = now()
 WHERE doc IN ('rider_app_config', 'driver_app_config')
   AND (document #>> '{booking,maxPickupMoveMeters}')::numeric = 200;
-- undo: (data only; the admin can also set any zone back in Dispatch › Booking) every document this file moved, i.e. still on
-- 300 with the 0133 history row as its live version, goes back to 200 as the next version:
-- UPDATE config_live l SET document = jsonb_set(jsonb_set(l.document, '{booking,maxPickupMoveMeters}', '200'::jsonb), '{version}', to_jsonb(l.version + 1)), version = l.version + 1, published_at = now(), published_by = NULL
--   FROM config_history h WHERE h.doc = l.doc AND h.zone_id = l.zone_id AND h.version = l.version AND h.note LIKE '%migration 0133%'
--   AND l.doc IN ('rider_app_config', 'driver_app_config') AND (l.document #>> '{booking,maxPickupMoveMeters}')::numeric = 300;
