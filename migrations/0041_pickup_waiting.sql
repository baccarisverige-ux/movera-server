-- movera-server migration 0041: driver group 5, going to pickup and the waiting items shared with group 6 (contract
-- v0.18.7 §33, contract.json#pickupWaiting; Rules decisions/driver-g5.md, driver-g6.md). Safe to run twice.

-- Q3 (debt only in the same currency): the rider's outstanding sum is now the owed fees in ONE currency (the oldest
-- owed one); the currency is kept next to it. rider_fees already carries each fee's currency.
ALTER TABLE riders ADD COLUMN IF NOT EXISTS outstanding_currency char(3);
UPDATE riders r
   SET outstanding_minor = COALESCE(s.total, 0), outstanding_currency = s.currency, outstanding_source_trip_id = s.trip_id
  FROM (
    SELECT DISTINCT ON (rider_id) rider_id, currency, trip_id,
           SUM(amount_minor) OVER (PARTITION BY rider_id, currency) AS total
      FROM rider_fees WHERE status = 'owed'
     ORDER BY rider_id, created_at, trip_id
  ) s
 WHERE s.rider_id = r.rider_id;
UPDATE riders SET outstanding_minor = 0, outstanding_currency = NULL, outstanding_source_trip_id = NULL
 WHERE NOT EXISTS (SELECT 1 FROM rider_fees f WHERE f.rider_id = riders.rider_id AND f.status = 'owed');

-- Q1: the rider as the driver sees him (first name, rating when the zone shows it), kept from accept.
ALTER TABLE trips ADD COLUMN IF NOT EXISTS rider_summary jsonb;
-- Status item 4: the pickup as booked; the move limit is measured from it, not from the last move.
ALTER TABLE trips ADD COLUMN IF NOT EXISTS booked_pickup jsonb;
-- Q4 / status item 2: the server's road-route ETA (TripEta), refreshed every 30 s while a driver is on the way or driving.
ALTER TABLE trips ADD COLUMN IF NOT EXISTS eta jsonb;
-- The ETA tick's location event carries the TripEta next to eta_seconds.
ALTER TABLE trip_events ADD COLUMN IF NOT EXISTS eta jsonb;
-- Status item 4: the new realtime kind pickup_moved (contract.json#realtime.kinds).
ALTER TABLE trip_events DROP CONSTRAINT IF EXISTS trip_events_kind_check;
ALTER TABLE trip_events ADD CONSTRAINT trip_events_kind_check
  CHECK (kind IN ('trip_projection', 'rider_cancelled', 'driver_cancelled', 'location', 'driver_arrived', 'rider_on_the_way', 'payment_updated', 'rating_updated', 'message', 'pickup_moved'));

-- Status item 4 (owner "200 m default, admin can change"): every published rider and driver document still on the old
-- 500 m pickup move limit goes to 200, as the next version with a history row; drafts too. A zone the admin already set
-- to another value keeps it.
WITH changed AS (
  UPDATE config_live
     SET document = jsonb_set(jsonb_set(document, '{booking,maxPickupMoveMeters}', '200'::jsonb), '{version}', to_jsonb(version + 1))
                    || jsonb_build_object('publishedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
         version = version + 1,
         published_at = now(),
         published_by = NULL
   WHERE doc IN ('rider_app_config', 'driver_app_config')
     AND (document #>> '{booking,maxPickupMoveMeters}')::numeric = 500
  RETURNING doc, zone_id, version, document, published_at
)
INSERT INTO config_history (doc, zone_id, version, document, published_at, published_by, approved_by, note)
  SELECT doc, zone_id, version, document, published_at, NULL, NULL, 'G5 item 4: pickup move limit 500 -> 200 m (owner "200 m default, admin can change", migration 0041)'
  FROM changed
  ON CONFLICT (doc, zone_id, version) DO NOTHING;
UPDATE config_drafts
   SET document = jsonb_set(document, '{booking,maxPickupMoveMeters}', '200'::jsonb), version = version + 1, updated_at = now()
 WHERE doc IN ('rider_app_config', 'driver_app_config')
   AND (document #>> '{booking,maxPickupMoveMeters}')::numeric = 500;
