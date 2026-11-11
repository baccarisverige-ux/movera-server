-- movera: no-transaction
-- S05 A5 / S07 T2 (audits/global-plan-2026-11-08): the nightly KPI day count (admin/kpis.ts countDay) reads one zone's
-- trips by coalesce(ended_at, updated_at) (figures and money) and by created_at (new riders); neither had an index.
-- Rule 46: built CONCURRENTLY (no table lock).
-- S07 M12 (rider_wallets CHECK balance_minor >= 0) is NOT here: riders/wallet.ts moveWallet inserts the delta itself
-- (INSERT .. ON CONFLICT DO UPDATE), and Postgres checks the CHECK on that proposed row, so every wallet spend would fail.
CREATE INDEX CONCURRENTLY IF NOT EXISTS trips_zone_ended ON trips (zone_id, (coalesce(ended_at, updated_at)));
CREATE INDEX CONCURRENTLY IF NOT EXISTS trips_zone_created ON trips (zone_id, created_at);

-- undo:
-- DROP INDEX CONCURRENTLY IF EXISTS trips_zone_created;
-- DROP INDEX CONCURRENTLY IF EXISTS trips_zone_ended;
