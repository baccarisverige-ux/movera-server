-- v0.18.134 (contract.json#accountDeletion; owner button 2026-11-20 "Accept, keep debt (Rec.)", Rules
-- decisions/session-2026-11-06.md). WAITS FOR THE NEW SERVER (owner 2026-11-19: nothing on the current server).
-- drivers.deletion_requested_at: the driver's request (riders has it since 0006). erased_at: set last by account_erase in
-- the same transaction as the erase (a second run finds nothing). kept_debts: the only personal data kept after the erase
-- (owner: "only the debt record (name, number, amount) is kept until it is paid or written off"); one row per account and
-- currency. Rule 46: nullable columns with no default rewrite no row; a new empty table. Safe to run again (IF NOT EXISTS).
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS deletion_requested_at timestamptz;
ALTER TABLE riders ADD COLUMN IF NOT EXISTS erased_at timestamptz;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS erased_at timestamptz;
CREATE TABLE IF NOT EXISTS kept_debts (
  account_kind text NOT NULL,
  account_id   text NOT NULL,
  first_name   text NOT NULL,
  last_name    text NOT NULL,
  phone        text NOT NULL,
  amount_minor bigint NOT NULL,
  currency     text NOT NULL,
  created_at   timestamptz NOT NULL,
  settled_at   timestamptz,
  PRIMARY KEY (account_kind, account_id, currency)
);
CREATE INDEX IF NOT EXISTS riders_deletion_due ON riders (deletion_requested_at) WHERE deletion_requested_at IS NOT NULL AND erased_at IS NULL;
CREATE INDEX IF NOT EXISTS drivers_deletion_due ON drivers (deletion_requested_at) WHERE deletion_requested_at IS NOT NULL AND erased_at IS NULL;
-- undo:
-- DROP INDEX IF EXISTS drivers_deletion_due; DROP INDEX IF EXISTS riders_deletion_due; DROP TABLE IF EXISTS kept_debts;
-- ALTER TABLE drivers DROP COLUMN IF EXISTS erased_at; ALTER TABLE riders DROP COLUMN IF EXISTS erased_at;
-- ALTER TABLE drivers DROP COLUMN IF EXISTS deletion_requested_at;
