-- movera: no-transaction
-- S7 W2 Q126 = Q-B4 (owner 2026-11-15 "Yes, open ones only (Rec.)", contract v0.18.126 §69 note; Rule 33): the admin
-- alarm feed GET /admin/incidents/stream with no cursor starts from the open incidents: the newest event of each open
-- (open | investigating) incident. This index makes that one short read per open incident (newest first) instead of a
-- scan of the whole incident_events history. The open incidents themselves are found through the partial index
-- incidents_one_open_per_trip (0021).
-- No-transaction + CONCURRENTLY: no table lock while the app runs (Rule 46); IF NOT EXISTS: re-runnable.
CREATE INDEX CONCURRENTLY IF NOT EXISTS incident_events_by_incident ON incident_events (incident_id, sequence DESC);
-- undo:
-- DROP INDEX CONCURRENTLY IF EXISTS incident_events_by_incident;
