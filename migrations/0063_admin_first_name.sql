-- A1 live fix (contract v0.18.18 §43, contract.json#adminNames; owner 2026-11-03 "Real name from Team"): every admin's
-- first name, set in Team. Until set the panel shows "Admin"; an e-mail is never shown as a name.
-- Numbered 0063 after the open A2 (up to 0062) and Book later (0051) branches; renumber at merge if needed.
ALTER TABLE admins ADD COLUMN IF NOT EXISTS first_name text CHECK (first_name IS NULL OR (length(first_name) BETWEEN 1 AND 40 AND position('@' IN first_name) = 0));
