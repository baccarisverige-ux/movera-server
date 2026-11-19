-- v0.18.133 (contract.json#payoutLines; S5 J12-J15, owner 2026-11-19 "driver payout 3 lines", "carry line only when
-- needed", "carry counts toward owed limit"): the parts of a payout made while CountryRules.payoutLinesOn is on.
-- NULL on every payout made before (and while the switch is off): those rows are read as they are, never rewritten
-- (a past payout below 0 is read as its carry in code, src/admin/payoutLines.ts; Q-S5-7, no UPDATE).
-- Rule 46: nullable columns with no default rewrite no row; the ALTER's lock is held only for the catalog change.
-- Values are checked in code (makePayouts), no CHECK here (check_migrations R2). Safe to run again (IF NOT EXISTS).
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS earned_minor bigint;
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS owed_minor bigint;
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS carried_in_minor bigint;
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS carried_out_minor bigint;
-- undo:
-- ALTER TABLE payouts DROP COLUMN IF EXISTS earned_minor, DROP COLUMN IF EXISTS owed_minor,
--   DROP COLUMN IF EXISTS carried_in_minor, DROP COLUMN IF EXISTS carried_out_minor;
