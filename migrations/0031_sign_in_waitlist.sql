-- movera-server migration 0031: the sign-in waiting list (contract v0.15.0 §24, owner 2026-10-29 decision 5).
-- A number answered 403 sign_in_restricted can ask to join; one row per phone and app, counted. The admin reads it.
CREATE TABLE IF NOT EXISTS sign_in_waitlist (
  phone text NOT NULL CHECK (phone ~ '^\+[1-9][0-9]{6,14}$'),
  app text NOT NULL CHECK (app IN ('rider', 'driver')),
  locale text CHECK (locale IN ('sv', 'fr', 'en')),
  ip text,
  count integer NOT NULL DEFAULT 1 CHECK (count >= 1),
  first_at timestamptz NOT NULL,
  last_at timestamptz NOT NULL,
  PRIMARY KEY (phone, app)
);
CREATE INDEX IF NOT EXISTS sign_in_waitlist_last_at_idx ON sign_in_waitlist (last_at DESC, phone, app);
-- Asks per client address in the last hour (the rate limit) are counted from this log.
CREATE TABLE IF NOT EXISTS sign_in_waitlist_asks (
  ip text NOT NULL,
  at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sign_in_waitlist_asks_ip_at_idx ON sign_in_waitlist_asks (ip, at);
