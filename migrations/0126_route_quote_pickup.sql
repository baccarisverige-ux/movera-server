-- v0.18.143 (owner 2026-11-20 "must rider can change !!!!", contract.json#onTrip.routeChange.whileSearching): a route
-- price made while a live trip is searched may move the pickup to any place. Safe to run twice; nullable, no lock.
ALTER TABLE route_quotes ADD COLUMN IF NOT EXISTS pickup jsonb;
-- undo:
-- ALTER TABLE route_quotes DROP COLUMN IF EXISTS pickup;
