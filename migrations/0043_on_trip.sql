-- movera-server migration 0043: driver group 7, on trip (contract v0.18.9 §35, contract.json#onTrip;
-- Rules decisions/driver-g7.md, plan/g7-job-list.md). Safe to run twice.

-- Ride check by the server: the trip's current server check (TripProjection.rideCheck), the road route it is measured
-- against (made once, again after a route change), and where a ride_checks row came from.
ALTER TABLE trips ADD COLUMN IF NOT EXISTS ride_check jsonb;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS ride_check_log jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS planned_route jsonb;
ALTER TABLE ride_checks ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'app';
ALTER TABLE ride_checks DROP CONSTRAINT IF EXISTS ride_checks_origin_check;
ALTER TABLE ride_checks ADD CONSTRAINT ride_checks_origin_check CHECK (origin IN ('app', 'server'));
CREATE INDEX IF NOT EXISTS ride_checks_created ON ride_checks (created_at DESC, trip_id);

-- Route change during the trip: the trip's latest change (TripProjection.routeChange) and the rider's route quotes.
ALTER TABLE trips ADD COLUMN IF NOT EXISTS route_change jsonb;
CREATE TABLE IF NOT EXISTS route_quotes (
  route_quote_id        text PRIMARY KEY,
  trip_id               text NOT NULL REFERENCES trips (trip_id),
  trip_version          integer NOT NULL,
  base_change_id        text,
  dropoff               jsonb NOT NULL,
  stops                 jsonb NOT NULL,
  distance_meters       integer NOT NULL,
  duration_seconds      integer NOT NULL,
  currency              text NOT NULL,
  total_minor           bigint NOT NULL,
  difference_minor      bigint NOT NULL,
  fare_lines            jsonb NOT NULL,
  driver_earnings_minor bigint NOT NULL,
  expires_at            timestamptz NOT NULL,
  used_at               timestamptz,
  created_at            timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS route_quotes_trip ON route_quotes (trip_id);

-- Admin trip tools: a flag (admin only) and notes.
ALTER TABLE trips ADD COLUMN IF NOT EXISTS admin_flag jsonb;
CREATE INDEX IF NOT EXISTS trips_admin_flagged ON trips ((admin_flag->>'flagged')) WHERE admin_flag IS NOT NULL;
CREATE TABLE IF NOT EXISTS admin_trip_notes (
  note_id    text PRIMARY KEY,
  trip_id    text NOT NULL REFERENCES trips (trip_id),
  admin_id   text NOT NULL,
  text       text NOT NULL,
  at         timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_trip_notes_trip ON admin_trip_notes (trip_id, at DESC);

-- An admin opens a support case for the trip's rider or driver (opened_by admin, internal).
ALTER TABLE support_tickets DROP CONSTRAINT IF EXISTS support_tickets_opened_by_check;
ALTER TABLE support_tickets ADD CONSTRAINT support_tickets_opened_by_check CHECK (opened_by IN ('rider', 'driver', 'admin'));
ALTER TABLE support_tickets DROP CONSTRAINT IF EXISTS support_tickets_check;
ALTER TABLE support_tickets ADD CONSTRAINT support_tickets_check
  CHECK ((opened_by = 'rider' AND rider_id IS NOT NULL) OR (opened_by = 'driver' AND driver_id IS NOT NULL) OR (opened_by = 'admin' AND (rider_id IS NOT NULL OR driver_id IS NOT NULL)));

-- Owner decision 2 (2026-10-29, "2 km"): published ride check offRouteKm still on the old 3 km go to 2; owner decision 4:
-- published driver documents still on the admin's old stop default (3 free minutes) go to 0. As the next version with a
-- history row; drafts too. A zone the admin set to another value keeps it.
WITH changed AS (
  UPDATE config_live
     SET document = jsonb_set(jsonb_set(document, '{rideCheck,offRouteKm}', '2'::jsonb), '{version}', to_jsonb(version + 1))
                    || jsonb_build_object('publishedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
         version = version + 1,
         published_at = now(),
         published_by = NULL
   WHERE doc IN ('rider_app_config', 'driver_app_config')
     AND (document #>> '{rideCheck,offRouteKm}')::numeric = 3
  RETURNING doc, zone_id, version, document, published_at
)
INSERT INTO config_history (doc, zone_id, version, document, published_at, published_by, approved_by, note)
  SELECT doc, zone_id, version, document, published_at, NULL, NULL, 'G7 decision 2: ride check off route 3 -> 2 km (migration 0043)'
  FROM changed
  ON CONFLICT (doc, zone_id, version) DO NOTHING;
UPDATE config_drafts
   SET document = jsonb_set(document, '{rideCheck,offRouteKm}', '2'::jsonb), version = version + 1, updated_at = now()
 WHERE doc IN ('rider_app_config', 'driver_app_config')
   AND (document #>> '{rideCheck,offRouteKm}')::numeric = 3;

WITH changed AS (
  UPDATE config_live
     SET document = jsonb_set(jsonb_set(document, '{waiting,stopFreeWaitMin}', '0'::jsonb), '{version}', to_jsonb(version + 1))
                    || jsonb_build_object('publishedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
         version = version + 1,
         published_at = now(),
         published_by = NULL
   WHERE doc = 'driver_app_config'
     AND (document #>> '{waiting,stopFreeWaitMin}')::numeric = 3
  RETURNING doc, zone_id, version, document, published_at
)
INSERT INTO config_history (doc, zone_id, version, document, published_at, published_by, approved_by, note)
  SELECT doc, zone_id, version, document, published_at, NULL, NULL, 'G7 decision 4: free minutes at each stop 3 -> 0 (migration 0043)'
  FROM changed
  ON CONFLICT (doc, zone_id, version) DO NOTHING;
UPDATE config_drafts
   SET document = jsonb_set(document, '{waiting,stopFreeWaitMin}', '0'::jsonb), version = version + 1, updated_at = now()
 WHERE doc = 'driver_app_config'
   AND (document #>> '{waiting,stopFreeWaitMin}')::numeric = 3;
