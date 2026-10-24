-- movera-server migration 0004: zones, config documents (draft / live / history), approvals, admin audit.
-- Contract v0.5.1 §6 (config documents and the version rule), §3.1 (second-admin approval), §9 (Super admin).

-- The zones the server knows. `open` = rides may start there (owner decision 15: a deploy setting).
CREATE TABLE zones (
  zone_id     text PRIMARY KEY CHECK (zone_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  name        text NOT NULL,
  country     char(2) NOT NULL,
  currency    char(3) NOT NULL CHECK (currency IN ('SEK', 'EUR', 'TND')),
  time_zone   text NOT NULL,
  kind        text NOT NULL DEFAULT 'operating' CHECK (kind IN ('operating', 'airport')),
  center_lat  double precision NOT NULL,
  center_lng  double precision NOT NULL,
  open        boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Greater Stockholm, as the admin panel lists it (webapp/src/markets/markets.ts). Open in the test week:
-- Norrmalm, Södermalm, Östermalm, Kungsholmen, Vasastan and Södertälje (owner decision 15).
INSERT INTO zones (zone_id, name, country, currency, time_zone, kind, center_lat, center_lng, open) VALUES
  ('Z001', 'Norrmalm', 'SE', 'SEK', 'Europe/Stockholm', 'operating', 59.334, 18.063, true),
  ('Z002', 'Södermalm', 'SE', 'SEK', 'Europe/Stockholm', 'operating', 59.314, 18.07, true),
  ('Z003', 'Östermalm', 'SE', 'SEK', 'Europe/Stockholm', 'operating', 59.338, 18.088, true),
  ('Z004', 'Kungsholmen', 'SE', 'SEK', 'Europe/Stockholm', 'operating', 59.33, 18.03, true),
  ('Z005', 'Vasastan', 'SE', 'SEK', 'Europe/Stockholm', 'operating', 59.346, 18.048, true),
  ('Z006', 'Bromma', 'SE', 'SEK', 'Europe/Stockholm', 'operating', 59.34, 17.94, false),
  ('Z007', 'Solna', 'SE', 'SEK', 'Europe/Stockholm', 'operating', 59.36, 18.0, false),
  ('Z008', 'Kista', 'SE', 'SEK', 'Europe/Stockholm', 'operating', 59.403, 17.944, false),
  ('Z009', 'Södertälje', 'SE', 'SEK', 'Europe/Stockholm', 'operating', 59.195, 17.628, true),
  ('ARN', 'Arlanda', 'SE', 'SEK', 'Europe/Stockholm', 'airport', 59.649, 17.929, false),
  ('BMA', 'Bromma airport', 'SE', 'SEK', 'Europe/Stockholm', 'airport', 59.354, 17.948, false);

-- One working draft per document and zone. `version` is the draft's own counter (expectedVersion for PUT/publish).
CREATE TABLE config_drafts (
  doc         text NOT NULL CHECK (doc IN ('rider_app_config', 'driver_app_config', 'pricing', 'dispatch')),
  zone_id     text NOT NULL REFERENCES zones (zone_id),
  version     integer NOT NULL CHECK (version >= 1),
  document    jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text,
  PRIMARY KEY (doc, zone_id)
);

-- What the apps (or, for pricing and dispatch, the server) read: the last published version.
-- `version` is strictly increasing per document and zone (contract.json#configVersion).
CREATE TABLE config_live (
  doc           text NOT NULL,
  zone_id       text NOT NULL REFERENCES zones (zone_id),
  version       integer NOT NULL CHECK (version >= 1),
  document      jsonb NOT NULL,
  published_at  timestamptz NOT NULL,
  published_by  text,
  PRIMARY KEY (doc, zone_id)
);

-- Every published version, kept for the audit and to roll back.
CREATE TABLE config_history (
  doc           text NOT NULL,
  zone_id       text NOT NULL,
  version       integer NOT NULL,
  document      jsonb NOT NULL,
  published_at  timestamptz NOT NULL,
  published_by  text,
  approved_by   text,
  note          text,
  PRIMARY KEY (doc, zone_id, version)
);

-- Two-person rule (contract §3.1): an action by an admin who is not approval-exempt waits here.
CREATE TABLE approvals (
  approval_id    text PRIMARY KEY,
  action         text NOT NULL,
  target_type    text NOT NULL CHECK (target_type IN ('trip', 'payment', 'refund', 'payout', 'config', 'driver', 'rider')),
  target_id      text NOT NULL,
  payload        jsonb NOT NULL DEFAULT '{}',
  approve_permission text NOT NULL,
  zone_id        text,
  status         text NOT NULL DEFAULT 'pending_approval' CHECK (status IN ('pending_approval', 'approved', 'rejected', 'expired')),
  requested_by   text NOT NULL,
  requested_at   timestamptz NOT NULL,
  expires_at     timestamptz NOT NULL,
  decided_by     text,
  decided_at     timestamptz,
  decision_note  text
);
CREATE INDEX approvals_status ON approvals (status, requested_at DESC);

-- Who changed what in the admin, append-only.
CREATE TABLE admin_audit (
  audit_id    bigserial PRIMARY KEY,
  admin_id    text,
  action      text NOT NULL,
  target_type text NOT NULL,
  target_id   text NOT NULL,
  zone_id     text,
  detail      jsonb NOT NULL DEFAULT '{}',
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_audit_at ON admin_audit (at DESC);
