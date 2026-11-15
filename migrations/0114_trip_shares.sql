-- v0.18.116 §94 BQ-S10 "Share my trip" (contract.json#shareTrip; owner 2026-11-02 Q1 "Build it for real", Rules
-- decisions/driver-g14.md:11, and the S10 answers of 2026-11-15): the rider's live trip links.
-- Only the SHA-256 of a link's token is kept (token_hash), never the token or the URL: a copy of this table cannot
-- open a link. No personal data: the trip, the rider, the zone and three times. A link ends when the trip ends
-- (read from trips.status when the link is read: no timer), when the rider stops it (revoked_at), when the zone's
-- switch is off (revoked_at is then set by the read) or at expires_at (created_at + 6 h). Rows are deleted 30 days
-- after created_at (jobs/housekeeping.ts cleanup_trip_shares; owner Q7).
-- 0113 is left to the S7 alert-cap job (Rules plan/NUMBERS.md).
-- Rule 46: a NEW table and its own indexes (the table is empty, nothing waits); no existing table is rewritten. The
-- foreign key only reads trips (a child insert takes KEY SHARE on the trip row, which lockTrip's FOR NO KEY UPDATE
-- does not block). Safe to run again (IF NOT EXISTS).
CREATE TABLE IF NOT EXISTS trip_shares (
  share_id text PRIMARY KEY,
  token_hash bytea NOT NULL UNIQUE,
  trip_id text NOT NULL REFERENCES trips (trip_id),
  rider_id text NOT NULL,
  zone_id text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS trip_shares_trip_live_idx ON trip_shares (trip_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS trip_shares_created_idx ON trip_shares (created_at);
-- undo:
-- DROP TABLE IF EXISTS trip_shares;
