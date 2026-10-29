-- movera-server migration 0033: driver onboarding group 2 (contract v0.17.0 §25, owner 2026-10-29).
-- The per-country onboarding settings document, the car's fuel, and the notices already sent (expiry warnings per
-- document and expiry date, sign-up reminders) so each one goes out once.
ALTER TABLE config_drafts DROP CONSTRAINT IF EXISTS config_drafts_doc_check;
ALTER TABLE config_drafts ADD CONSTRAINT config_drafts_doc_check CHECK (doc IN ('rider_app_config', 'driver_app_config', 'pricing', 'dispatch', 'country_rules', 'onboarding'));

ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS fuel text CHECK (fuel IN ('petrol', 'diesel', 'hybrid', 'electric'));

-- warn_day: the warning day reached (30, 7, 1 …); 0 = the expired notice. A new expiry date starts again.
CREATE TABLE IF NOT EXISTS document_notices (
  document_id text NOT NULL REFERENCES documents (document_id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  warn_day    integer NOT NULL CHECK (warn_day >= 0),
  sent_at     timestamptz NOT NULL,
  PRIMARY KEY (document_id, expires_at, warn_day)
);

CREATE TABLE IF NOT EXISTS sign_up_reminders (
  driver_id text NOT NULL REFERENCES drivers (driver_id) ON DELETE CASCADE,
  sent_at   timestamptz NOT NULL,
  PRIMARY KEY (driver_id, sent_at)
);
