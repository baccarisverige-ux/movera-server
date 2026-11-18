-- S4 B1.16 Q-B13 (owner W1 Q78 "Do not count it", 2026-11-11; contract v0.18.120 contract.json#autoOffline.outage):
-- one row per outage of a server copy's LISTEN link (src/realtime/outages.ts): down_at = the copy's last proof the
-- link worked, seen_at = when it last said "still down", up_at = its reconnect (NULL while down). The auto-offline
-- count (src/dispatch/autoOffline.ts missedInRow / missedInRowOf) skips an Exclusive or hand-sent offer that expired
-- inside any copy's window (an open one ends at seen_at + 60 s). A NEW table, so the plain index takes no lock on
-- anything the app uses (Rule 46). Rows older than 7 days are pruned by the copies at each reconnect.
CREATE TABLE IF NOT EXISTS realtime_outages (
  outage_id bigserial PRIMARY KEY,
  copy_id text NOT NULL,
  down_at timestamptz NOT NULL,
  seen_at timestamptz NOT NULL,
  up_at timestamptz,
  CONSTRAINT realtime_outages_seen_after_down CHECK (seen_at >= down_at),
  CONSTRAINT realtime_outages_up_after_down CHECK (up_at IS NULL OR up_at >= down_at)
);
CREATE INDEX IF NOT EXISTS realtime_outages_down_at ON realtime_outages (down_at);
-- undo:
-- DROP TABLE IF EXISTS realtime_outages;
