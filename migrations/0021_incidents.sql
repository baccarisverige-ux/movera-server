-- movera-server migration 0021: SOS and incidents (contract v0.7.0 §15, owner safety part 1 decisions 2026-10-27).
-- One row per incident: an SOS from the rider or the driver, or the server's "car lost" alarm (driver_silent).
-- At most one open (open | investigating) incident of a kind per trip. incident_events is the admin alarm feed
-- (GET /admin/incidents/stream): one row per change with the whole incident as it was, numbered without gaps.
CREATE TABLE incidents (
  incident_id text PRIMARY KEY,
  trip_id text REFERENCES trips (trip_id),
  kind text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]{0,63}$'),
  severity text NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'investigating', 'resolved', 'dismissed')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  raised_by text NOT NULL CHECK (raised_by IN ('rider', 'driver', 'system')),
  zone_id text,
  rider_id text,
  driver_id text,
  -- The GPS the SOS phone sent once: { lat, lng, accuracyM?, at }.
  position jsonb,
  -- The car's latest position when the incident opened (GeoFix); the admin reads the live one.
  driver_fix jsonb,
  opened_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  escalated_at timestamptz,
  taken_by text,
  taken_at timestamptz,
  resolved_by text,
  resolved_at timestamptz,
  resolution text
);
CREATE UNIQUE INDEX incidents_one_open_per_trip ON incidents (trip_id, kind) WHERE status IN ('open', 'investigating');
CREATE INDEX incidents_newest ON incidents (opened_at DESC, incident_id DESC);

CREATE TABLE incident_events (
  sequence bigint PRIMARY KEY,
  event_id text NOT NULL UNIQUE,
  incident_id text NOT NULL REFERENCES incidents (incident_id),
  kind text NOT NULL CHECK (kind IN ('incident_opened', 'incident_updated', 'incident_escalated', 'incident_closed')),
  zone_id text,
  incident jsonb NOT NULL,
  occurred_at timestamptz NOT NULL
);
