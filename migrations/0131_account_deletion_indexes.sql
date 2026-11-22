-- movera: no-transaction
-- v0.18.134 (contract.json#accountDeletion), P28 merge plan 2026-11-21: Rule 46. The account_erase job's "due now" reads
-- were indexed in 0123 with a plain CREATE INDEX, which locks riders / drivers for writes while it builds. Built here
-- CONCURRENTLY instead (no table lock; the runner checks no index is left INVALID). Safe to run again (IF NOT EXISTS).
CREATE INDEX CONCURRENTLY IF NOT EXISTS riders_deletion_due ON riders (deletion_requested_at) WHERE deletion_requested_at IS NOT NULL AND erased_at IS NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS drivers_deletion_due ON drivers (deletion_requested_at) WHERE deletion_requested_at IS NOT NULL AND erased_at IS NULL;
-- undo:
-- DROP INDEX CONCURRENTLY IF EXISTS drivers_deletion_due; DROP INDEX CONCURRENTLY IF EXISTS riders_deletion_due;
