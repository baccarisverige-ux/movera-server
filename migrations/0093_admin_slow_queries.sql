-- movera: no-transaction
-- Admin slow queries (owner 2026-11-10, test/db/query_plans_backlog.test.ts). Rule 46: every index is built
-- CONCURRENTLY (no table lock).

-- Admin all-trips list with no filter (admin/lists.ts listTrips): newest first by (created_at, trip_id), keyset cursor;
-- without this index every trip of the table was sorted for one page.
CREATE INDEX CONCURRENTLY IF NOT EXISTS trips_created ON trips (created_at, trip_id);
-- IN-G10.3: a driver's own payouts page (admin/payouts.ts driverPayouts): his payouts newest first, keyset cursor.
CREATE INDEX CONCURRENTLY IF NOT EXISTS payouts_driver_created ON payouts (driver_id, created_at, payout_id);

-- undo:
-- DROP INDEX CONCURRENTLY IF EXISTS trips_created;
-- DROP INDEX CONCURRENTLY IF EXISTS payouts_driver_created;
