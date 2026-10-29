-- movera-server migration 0032: Crashes & errors (contract v0.16.0 §11, owner 2026-10-29).
-- Crash and error reports (POST /telemetry/crashes, and the server's own unhandled 5xx errors) grouped by fingerprint:
-- app + platform + normalized message + top stack frame. The admin lists the groups and marks them fixed.
CREATE TABLE IF NOT EXISTS error_groups (
  error_id     text PRIMARY KEY,
  fingerprint  text NOT NULL UNIQUE,
  app          text NOT NULL CHECK (app IN ('driver', 'rider', 'server')),
  platform     text NOT NULL CHECK (platform IN ('android', 'ios', 'web', 'server')),
  kind         text NOT NULL CHECK (kind IN ('crash', 'error')),
  message      text NOT NULL,
  top_frame    text,
  app_versions text[] NOT NULL DEFAULT '{}',
  count        integer NOT NULL DEFAULT 1 CHECK (count >= 1),
  first_seen   timestamptz NOT NULL,
  last_seen    timestamptz NOT NULL,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'fixed')),
  fixed_at     timestamptz
);
CREATE INDEX IF NOT EXISTS error_groups_last_seen_idx ON error_groups (last_seen DESC, error_id);
-- Distinct devices per group (a hash of the signed-in account, or of the address; never the raw value).
CREATE TABLE IF NOT EXISTS error_group_devices (
  error_id   text NOT NULL REFERENCES error_groups (error_id) ON DELETE CASCADE,
  device     text NOT NULL,
  last_seen  timestamptz NOT NULL,
  PRIMARY KEY (error_id, device)
);
-- Each kept report points at its group; at most maxEventsPerGroup reports are kept per group (the count goes on).
-- 'server' reports are the server's own unhandled errors.
ALTER TABLE telemetry ADD COLUMN IF NOT EXISTS error_id text REFERENCES error_groups (error_id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS telemetry_error_id_idx ON telemetry (error_id) WHERE error_id IS NOT NULL;
