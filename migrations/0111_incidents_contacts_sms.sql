-- v0.18.101 §92 BQ-V34 (contract.json#sosContactsSms; owner 2026-11-02 Q2 "Use them in SOS", Rules decisions/driver-g14.md:12):
-- the result of the SMS to the driver's emergency contacts of an SOS case, Incident.contactsSms
-- { status off | no_contacts | not_connected | queued | sent | failed, contacts, sent?, at }. NULL = no driver SOS on
-- the case yet (the first driver SOS sets it; later ones send nothing more). 0110 is left to BQ-M25.
-- Rule 46: a nullable column with no default rewrites no row; the ALTER's lock is held only for the catalog change.
-- Safe to run again (IF NOT EXISTS).
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS contacts_sms jsonb;
-- undo:
-- ALTER TABLE incidents DROP COLUMN IF EXISTS contacts_sms;
