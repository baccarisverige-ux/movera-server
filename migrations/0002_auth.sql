-- movera-server migration 0002: phone sign-in, sessions with rotating refresh tokens, push devices.
-- Contract v0.5.0 §8 (contract.json#auth).

-- Test numbers (outside production only): no SMS, the fixed code signs in. Keyed by phone and app, so one
-- number can be a test rider and a test driver.
CREATE TABLE test_phones (
  phone       text NOT NULL CHECK (phone ~ '^\+[1-9][0-9]{6,14}$'),
  app         text NOT NULL CHECK (app IN ('rider', 'driver')),
  note        text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (phone, app)
);

-- One row per code sent (or, for a test number, per sign-in started). The code itself is never stored.
CREATE TABLE otp_sessions (
  session_id    text PRIMARY KEY,
  phone         text NOT NULL,
  app           text NOT NULL CHECK (app IN ('rider', 'driver')),
  code_sha256   char(64) NOT NULL,
  is_test       boolean NOT NULL,
  locale        text,
  ip            text,
  attempts      integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts  integer NOT NULL CHECK (max_attempts >= 1),
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX otp_sessions_phone ON otp_sessions (phone, app, created_at DESC);
CREATE INDEX otp_sessions_ip ON otp_sessions (ip, created_at DESC);

-- A signed-in device. Every refresh rotates the refresh token; the session ends at sign-out, on refresh-token
-- reuse, or 30 days after the last refresh.
CREATE TABLE auth_sessions (
  session_id      text PRIMARY KEY,
  actor           text NOT NULL CHECK (actor IN ('rider', 'driver', 'admin')),
  subject_id      text NOT NULL,
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  revoked_reason  text,
  user_agent      text,
  ip              text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_refresh_at timestamptz
);
CREATE INDEX auth_sessions_subject ON auth_sessions (actor, subject_id);

-- Only hashes are kept. replaced_by links a used token to the one issued in its place.
CREATE TABLE refresh_tokens (
  token_sha256  char(64) PRIMARY KEY,
  session_id    text NOT NULL REFERENCES auth_sessions (session_id) ON DELETE CASCADE,
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz,
  replaced_by   char(64),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_session ON refresh_tokens (session_id);

-- Push tokens, keyed by token and actor (contract §8). Stored now; nothing is sent in the first test week.
CREATE TABLE push_devices (
  token        text NOT NULL CHECK (length(token) BETWEEN 1 AND 4096),
  actor        text NOT NULL CHECK (actor IN ('rider', 'driver')),
  subject_id   text NOT NULL,
  session_id   text REFERENCES auth_sessions (session_id) ON DELETE SET NULL,
  provider     text NOT NULL CHECK (provider IN ('fcm', 'apns')),
  platform     text NOT NULL CHECK (platform IN ('ios', 'android', 'web')),
  app_version  text,
  locale       text,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (token, actor)
);
CREATE INDEX push_devices_subject ON push_devices (actor, subject_id);
