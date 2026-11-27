-- v0.18.171 (contract.json#googleRoadLines; owner 2026-11-27 "Google on key screens", at most 4 Google calls per trip
-- including the quote, daily split 1,400 prices / 600 road lines): the trip's Google Routes call count (it survives a
-- driver change: accept clears eta_route, not this) and the daily budget across all countries.
-- trips.google_route_calls: a constant default (Postgres 11+ adds it without a table rewrite).
ALTER TABLE trips ADD COLUMN IF NOT EXISTS google_route_calls integer NOT NULL DEFAULT 0;
-- One row per America/Los_Angeles day, country (reporting only) and kind; the limits are checked on the SUM of the day.
CREATE TABLE IF NOT EXISTS google_route_calls_daily (
  day date NOT NULL,
  country text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('quote', 'road_line')),
  calls integer NOT NULL DEFAULT 0,
  PRIMARY KEY (day, country, kind)
);
-- The one global budget (config documents are per zone or country only): GET/PUT /admin/maps/google-budget.
-- No row = the defaults (2000 / 1400).
CREATE TABLE IF NOT EXISTS google_routes_budget (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  daily_limit integer NOT NULL CHECK (daily_limit BETWEEN 100 AND 100000),
  quotes_per_day integer NOT NULL CHECK (quotes_per_day >= 0 AND quotes_per_day <= daily_limit),
  updated_at timestamptz NOT NULL,
  updated_by text
);
-- undo: (Rule 21: only with the owner's OK, the counts would be lost)
-- DROP TABLE IF EXISTS google_routes_budget;
-- DROP TABLE IF EXISTS google_route_calls_daily;
-- ALTER TABLE trips DROP COLUMN IF EXISTS google_route_calls;
