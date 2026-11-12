-- movera: no-transaction
-- L78-S (contract v0.18.78, contract.json#adminListFilters.incidentsByPerson + total; Rule 33): GET /admin/incidents
-- ?driverId= / ?riderId= (driver and rider detail pages, Reports > Care) read one person's cases newest first and count
-- them. Without these, both walk incidents_newest (the whole table) or scan it (measured: test/db/query_plans.test.ts
-- "admin incidents by driver/rider"). The keys match the list's order (opened_at DESC, incident_id DESC), so the page is
-- an index range read with its keyset cursor and the count reads only that person's entries. Partial: cases with no
-- driver / no rider are never asked for by person.
-- No-transaction + CONCURRENTLY: no table lock while the app runs (Rule 46); IF NOT EXISTS: re-runnable.
CREATE INDEX CONCURRENTLY IF NOT EXISTS incidents_driver_newest ON incidents (driver_id, opened_at DESC, incident_id DESC) WHERE driver_id IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS incidents_rider_newest ON incidents (rider_id, opened_at DESC, incident_id DESC) WHERE rider_id IS NOT NULL;
-- undo:
-- DROP INDEX CONCURRENTLY IF EXISTS incidents_driver_newest;
-- DROP INDEX CONCURRENTLY IF EXISTS incidents_rider_newest;
