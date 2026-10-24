-- movera-server migration 0003: admin accounts, one-time setup links, sign-in attempts (contract v0.5.1 §9).

CREATE TABLE admins (
  admin_id              text PRIMARY KEY CHECK (admin_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  email                 text NOT NULL CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 254),
  name                  text NOT NULL,
  role                  text NOT NULL CHECK (role IN ('viewer', 'support', 'dispatcher', 'compliance', 'finance', 'safety', 'content', 'config', 'fleet', 'ops', 'super')),
  -- NULL = every zone ("all"); otherwise the zone ids this admin may act in.
  zone_ids              text[],
  countries             text[],
  fleet_partner_id      text,
  language              text CHECK (language IN ('en', 'fr', 'sv')),
  active                boolean NOT NULL DEFAULT true,
  password_hash         text,
  idle_timeout_seconds  integer NOT NULL DEFAULT 900 CHECK (idle_timeout_seconds BETWEEN 300 AND 14400),
  version               integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX admins_email ON admins (email);

-- One-time password links (72 h, single use). Only the token's hash is kept.
CREATE TABLE admin_setup_links (
  token_sha256  char(64) PRIMARY KEY,
  admin_id      text NOT NULL REFERENCES admins (admin_id) ON DELETE CASCADE,
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_setup_links_admin ON admin_setup_links (admin_id);

-- Failed sign-ins, for slowing down and locking guesses per e-mail and per address.
CREATE TABLE admin_sign_in_failures (
  id          bigserial PRIMARY KEY,
  email       text NOT NULL,
  ip          text,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_sign_in_failures_email ON admin_sign_in_failures (email, at DESC);
CREATE INDEX admin_sign_in_failures_ip ON admin_sign_in_failures (ip, at DESC);
