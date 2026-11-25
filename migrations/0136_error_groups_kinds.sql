-- movera: no-transaction
-- v0.18.158 (contract.json#crashCatcher.kinds; owner 2026-11-24 "Add to admin all kind of crash"): a crash group may
-- now be of kind dart_error, native_crash or freeze too (crash and error kept). Rule 46: the new CHECK is added NOT
-- VALID (no table scan under the lock) and validated after (light lock). Safe to run again: the old check is dropped
-- IF EXISTS and the new one is added only when it is not there.
ALTER TABLE error_groups DROP CONSTRAINT IF EXISTS error_groups_kind_check;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'error_groups_kind_158') THEN ALTER TABLE error_groups ADD CONSTRAINT error_groups_kind_158 CHECK (kind IN ('crash', 'error', 'dart_error', 'native_crash', 'freeze')) NOT VALID; END IF; END $$;
ALTER TABLE error_groups VALIDATE CONSTRAINT error_groups_kind_158;
-- undo:
-- (only when no group of a new kind is left)
-- ALTER TABLE error_groups DROP CONSTRAINT IF EXISTS error_groups_kind_158;
-- ALTER TABLE error_groups ADD CONSTRAINT error_groups_kind_check CHECK (kind IN ('crash', 'error')) NOT VALID;
-- ALTER TABLE error_groups VALIDATE CONSTRAINT error_groups_kind_check;
