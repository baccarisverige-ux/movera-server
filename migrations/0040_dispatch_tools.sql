-- movera-server migration 0040: the admin's Dispatch tools of driver group 4 (contract v0.18.6 §32, owner decisions
-- G4-F1..F6 of 2026-10-31 in Rules decisions/driver-g4.md). Everything is per country (SE, FR). Safe to run twice.

-- F2 "Per country only": saved Dispatch presets. values = a DispatchDocument without its zone (version, publishedAt,
-- zoneId, country, timeZone, usesStandard left out).
CREATE TABLE IF NOT EXISTS dispatch_presets (
  preset_id   text PRIMARY KEY CHECK (preset_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  country     char(2) NOT NULL,
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  values      jsonb NOT NULL,
  version     integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by  text,
  created_at  timestamptz NOT NULL,
  updated_by  text,
  updated_at  timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS dispatch_presets_name ON dispatch_presets (country, lower(name));

-- F3 "Free ones, nearest first": driver groups (admin only; drivers are not told).
CREATE TABLE IF NOT EXISTS driver_groups (
  group_id    text PRIMARY KEY CHECK (group_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  country     char(2) NOT NULL,
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  driver_ids  text[] NOT NULL DEFAULT '{}',
  version     integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by  text,
  created_at  timestamptz NOT NULL,
  updated_by  text,
  updated_at  timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS driver_groups_name ON driver_groups (country, lower(name));

-- F4 "Repeat until taken": radar zones (an area inside an operating zone) and their rules.
CREATE TABLE IF NOT EXISTS radar_zones (
  radar_zone_id text PRIMARY KEY CHECK (radar_zone_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  country       char(2) NOT NULL,
  zone_id       text NOT NULL REFERENCES zones (zone_id),
  name          text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  polygon       jsonb NOT NULL,
  version       integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by    text,
  created_at    timestamptz NOT NULL,
  updated_by    text,
  updated_at    timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS radar_zones_name ON radar_zones (country, lower(name));

CREATE TABLE IF NOT EXISTS radar_zone_rules (
  rule_id         text PRIMARY KEY CHECK (rule_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  country         char(2) NOT NULL,
  name            text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  radar_zone_ids  jsonb NOT NULL,
  seconds         integer NOT NULL CHECK (seconds BETWEEN 5 AND 120),
  max_drivers     integer NOT NULL CHECK (max_drivers BETWEEN 1 AND 10),
  repeat          boolean NOT NULL DEFAULT false,
  version         integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by      text,
  created_at      timestamptz NOT NULL,
  updated_by      text,
  updated_at      timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS radar_zone_rules_name ON radar_zone_rules (country, lower(name));

-- A radar-zone send of one trip; with repeat it is sent again at each expiry until stopped.
CREATE TABLE IF NOT EXISTS radar_zone_sends (
  send_id        text PRIMARY KEY CHECK (send_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  trip_id        text NOT NULL REFERENCES trips (trip_id),
  radar_zone_id  text NOT NULL,
  rule_id        text NOT NULL,
  seconds        integer NOT NULL,
  max_drivers    integer NOT NULL,
  repeat         boolean NOT NULL,
  active         boolean NOT NULL DEFAULT true,
  rounds         integer NOT NULL DEFAULT 1,
  started_by     text,
  started_at     timestamptz NOT NULL,
  stopped_at     timestamptz,
  stopped_by     text,
  stop_reason    text CHECK (stop_reason IS NULL OR stop_reason IN ('admin', 'accepted', 'search_ended', 'trip_over', 'replaced'))
);
CREATE INDEX IF NOT EXISTS radar_zone_sends_trip ON radar_zone_sends (trip_id) WHERE active;

-- F6 "small premium icon at the exact location": events per country, shown to drivers.
CREATE TABLE IF NOT EXISTS area_events (
  event_id    text PRIMARY KEY CHECK (event_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  country     char(2) NOT NULL,
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  lat         double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng         double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
  polygon     jsonb,
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL CHECK (ends_at > starts_at),
  is_on       boolean NOT NULL DEFAULT true,
  details     jsonb NOT NULL,
  version     integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by  text,
  created_at  timestamptz NOT NULL,
  updated_by  text,
  updated_at  timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS area_events_country ON area_events (country, ends_at);

-- F1 "Live now, remove box": dispatch changes never wait for a second admin (one-admin rule of 2026-10-28). Dispatch
-- approvals still pending from before that rule can never be decided usefully: they expire.
UPDATE approvals SET status = 'expired'
WHERE status = 'pending_approval'
  AND (action = 'dispatch.control' OR (action = 'config.publish' AND payload->>'doc' = 'dispatch'));

-- Owner 2026-10-31 "Send the real reason" (Rules decisions/driver-g3.md): why the server set a driver offline, shown
-- by the driver app's offline card; cleared when he goes online again.
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS offline_reason text CHECK (offline_reason IS NULL OR offline_reason IN ('no_position', 'missed_offers', 'vehicle_blocked', 'fleet_removed', 'account_status', 'admin'));
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS offline_note text;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS offline_at timestamptz;
