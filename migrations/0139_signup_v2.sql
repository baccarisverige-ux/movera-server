-- v0.18.166 (contract.json#signupV2; owner 2026-11-26 "Oui, tout construire"): the Swedish sign-up fields. Both columns
-- are optional (null for every driver who signed up before, and for France). personal_number is personal data: it is
-- masked for an admin without drivers.viewSensitive and erased with the account (accounts/deletion.ts).
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS personal_number text;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS taxi_license_number text;
-- Owner 2026-11-26 "Oui, ajouter l'adresse (Recommandé)": the home address (DAC7, invoices), signupV2.address.
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS address_street text;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS address_postal_code text;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS address_city text;
-- undo (Rule 21: only with the owner's OK, the data would be lost):
-- ALTER TABLE drivers DROP COLUMN personal_number; ALTER TABLE drivers DROP COLUMN taxi_license_number;
-- ALTER TABLE drivers DROP COLUMN address_street, DROP COLUMN address_postal_code, DROP COLUMN address_city;
