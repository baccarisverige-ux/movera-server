-- v0.18.20 (BASE job 4, contract.json#alertDesk.serverDetection; owner 2026-11-04 A1–A3): the alerts the SERVER finds.
-- One row per alert; at most one open or solved alert per cause. state: open = the cause is there now; solved = the
-- cause ended by itself (owner A2: shown green with solved_t until an admin marks it done); closed = an admin marked
-- it done. cause_live: the cause is still there (a closed alert whose cause is still there makes no new alert).
CREATE TABLE admin_alerts_live (
  alert_id    text PRIMARY KEY,
  cause_key   text NOT NULL,
  kind        text NOT NULL,
  country     text NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  zone_id     text,
  level       text NOT NULL CHECK (level IN ('critical', 'important', 'info')),
  title       text NOT NULL,
  title_t     jsonb NOT NULL,
  detail      text NOT NULL DEFAULT '',
  detail_t    jsonb,
  since       timestamptz NOT NULL,
  state       text NOT NULL CHECK (state IN ('open', 'solved', 'closed')),
  cause_live  boolean NOT NULL DEFAULT true,
  solved_at   timestamptz,
  solved_t    jsonb,
  ref         jsonb NOT NULL DEFAULT '{}'::jsonb,
  seen_at     timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL
);
-- No duplicates: one alert per cause until an admin closes it.
CREATE UNIQUE INDEX admin_alerts_live_cause ON admin_alerts_live (cause_key) WHERE state <> 'closed';
CREATE INDEX admin_alerts_live_country ON admin_alerts_live (country, state);
CREATE INDEX admin_alerts_live_tracked ON admin_alerts_live (cause_key) WHERE cause_live;

-- Owner A3: custom rules hold for N minutes before they alert; the server keeps since when each one holds, per zone.
CREATE TABLE admin_alert_rule_state (
  rule_key      text PRIMARY KEY,
  holding_since timestamptz NOT NULL
);
