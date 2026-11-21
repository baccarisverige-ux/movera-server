-- v0.18.148 SOS by press time (contract.json#sosPressTime; Rules LAUNCH-RULE.md "Queued (after freeze)" item 1, owner
-- 2026-11-20 "SOS kept and retried; after 30 min or any refusal ... call 112", plan/NUMBERS.md): Incident.pressedAt,
-- the press time `at` of the SOS that opened an sos case (opened_at is when the server received it). NULL on cases
-- opened before this version and on other kinds. 0119-0128 are reserved by other drafts.
-- Rule 46: a nullable column with no default rewrites no row; the ALTER's lock is held only for the catalog change.
-- Safe to run again (IF NOT EXISTS).
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS pressed_at timestamptz;
-- undo:
-- ALTER TABLE incidents DROP COLUMN IF EXISTS pressed_at;
