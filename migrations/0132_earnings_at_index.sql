-- movera: no-transaction
-- v0.18.153 P29 (contract.json#driverIncomeYear; owner 2026-11-21 "Execute! Add section in admin all what need"; DAC7):
-- GET /admin/finance/driver-income and its CSV read one year of earnings entries over ALL drivers by entry time. The only
-- time indexes start with driver_id (0009 earnings_driver), so that read would walk the whole table. Rule 46: built
-- CONCURRENTLY, no table lock. Safe to run again (IF NOT EXISTS).
CREATE INDEX CONCURRENTLY IF NOT EXISTS earnings_at ON earnings_entries (at);
-- undo:
-- DROP INDEX CONCURRENTLY IF EXISTS earnings_at;
