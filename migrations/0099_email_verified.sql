-- G30 (contract v0.18.76, contract.json#emailVerified; owner 2026-11-12 Q2 "Keep, show Not verified", Q6 and S3):
-- when the CURRENT e-mail was proven (riders / drivers.email_verified_at), and when a driver first became active
-- (drivers.first_activated_at, server-internal, never sent). Nullable columns without a default: no table rewrite.
-- Nothing is deleted and no e-mail is changed (Rule 21).
ALTER TABLE riders ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS first_activated_at timestamptz;
-- emailVerified.writePaths.provider (owner Q4): Apple / Google said it checked the e-mail (constant default: no rewrite).
ALTER TABLE auth_link_tokens ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT false;

-- The backfill of these columns runs in 0100 (no-transaction): here, inside this file's transaction, it would keep the
-- ADD COLUMNs' ACCESS EXCLUSIVE lock on riders and drivers for its whole run and every read would queue behind it
-- (Rule 46, supervisor G30 F1: ~1 s on a Rule-33-size copy). This file is ALTERs only: no rewrite, instant.

-- undo:
-- ALTER TABLE riders DROP COLUMN IF EXISTS email_verified_at;
-- ALTER TABLE drivers DROP COLUMN IF EXISTS email_verified_at;
-- ALTER TABLE drivers DROP COLUMN IF EXISTS first_activated_at;
-- ALTER TABLE auth_link_tokens DROP COLUMN IF EXISTS email_verified;
