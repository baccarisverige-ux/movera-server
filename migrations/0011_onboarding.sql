-- movera-server migration 0011: driver sign-up details, fleets and documents
-- (contract v0.5.3 §14, contract.json#driverOnboarding; owner decisions of 2026-10-25).

-- The details a driver sends once after the first sign-in (POST /driver/onboarding). account_type stays NULL for
-- drivers made before v0.5.3 (the CLI's test drivers): they keep the old rules (own car, no fleet needed).
ALTER TABLE drivers
  ADD COLUMN account_type      text CHECK (account_type IN ('driver', 'fleet')),
  ADD COLUMN last_name         text NOT NULL DEFAULT '',
  ADD COLUMN date_of_birth     date,
  ADD COLUMN email             text,
  ADD COLUMN country           char(2) CHECK (country IN ('SE', 'FR', 'TN')),
  ADD COLUMN city_id           text,
  ADD COLUMN language          text,
  ADD COLUMN terms_accepted_at timestamptz,
  ADD COLUMN fleet_id          text,
  ADD COLUMN fleet_linked_at   timestamptz;

-- A fleet account's company. One per owner; the join code exists only once an admin approved the fleet.
CREATE TABLE fleets (
  fleet_id         text PRIMARY KEY CHECK (fleet_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  name             text NOT NULL,
  org_number       text NOT NULL,
  address          text NOT NULL DEFAULT '',
  country          char(2) NOT NULL CHECK (country IN ('SE', 'FR', 'TN')),
  city_id          text NOT NULL,
  zone_id          text NOT NULL,
  owner_driver_id  text NOT NULL UNIQUE REFERENCES drivers (driver_id),
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'blocked')),
  code             text UNIQUE CHECK (code ~ '^MV-[A-Z2-9]{5}$'),
  review_note      text,
  reviewed_at      timestamptz,
  reviewed_by      text,
  version          integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE drivers ADD CONSTRAINT drivers_fleet FOREIGN KEY (fleet_id) REFERENCES fleets (fleet_id);
CREATE INDEX drivers_fleet ON drivers (fleet_id);

-- Fleet-owned cars: fleet_id is the owner; driver_id is now "who has it picked" (NULL = free). Cars made before
-- v0.5.3 keep driver_id as their owner and fleet_id NULL.
ALTER TABLE vehicles ALTER COLUMN driver_id DROP NOT NULL;
ALTER TABLE vehicles ADD COLUMN fleet_id text REFERENCES fleets (fleet_id);
CREATE INDEX vehicles_fleet ON vehicles (fleet_id);

-- Join tries, for the limit per driver and hour (contract.json#driverOnboarding.fleetCode.joinAttemptsPerHour).
CREATE TABLE fleet_join_attempts (
  driver_id  text NOT NULL REFERENCES drivers (driver_id),
  at         timestamptz NOT NULL
);
CREATE INDEX fleet_join_attempts_driver ON fleet_join_attempts (driver_id, at);

-- One document per owner (a driver or a car) and type; a new upload replaces it. driver_id is the account the
-- document belongs to (the fleet owner for a car's), which decides who may read it.
CREATE TABLE documents (
  document_id   text PRIMARY KEY CHECK (document_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  driver_id     text NOT NULL REFERENCES drivers (driver_id),
  owner_kind    text NOT NULL CHECK (owner_kind IN ('driver', 'vehicle')),
  owner_id      text NOT NULL,
  type          text NOT NULL CHECK (type ~ '^[a-z][a-z0-9_]{1,63}$'),
  status        text NOT NULL DEFAULT 'in_review' CHECK (status IN ('missing', 'in_review', 'approved', 'rejected', 'expired')),
  expires_at    timestamptz,
  file_name     text,
  media_type    text,
  file_size     integer CHECK (file_size >= 0),
  uploaded_at   timestamptz,
  reviewed_at   timestamptz,
  reviewed_by   text,
  review_note   text,
  version       integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX documents_current ON documents (owner_kind, owner_id, type);
CREATE INDEX documents_driver ON documents (driver_id);

-- The file itself, encrypted (AES-256-GCM) with the server's documents key; never served as a public link.
CREATE TABLE document_files (
  document_id  text PRIMARY KEY REFERENCES documents (document_id) ON DELETE CASCADE,
  key_id       text NOT NULL,
  iv           bytea NOT NULL,
  tag          bytea NOT NULL,
  ciphertext   bytea NOT NULL
);

-- Approvals and the audit may now name fleets, vehicles and documents.
ALTER TABLE approvals DROP CONSTRAINT approvals_target_type_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_target_type_check
  CHECK (target_type IN ('trip', 'payment', 'refund', 'payout', 'config', 'driver', 'rider', 'fleet', 'vehicle', 'document'));
