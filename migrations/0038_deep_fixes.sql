-- movera-server migration 0038: deep fixes of driver groups 1 and 2, chat storage, legal texts (contract v0.18.5 §30,
-- owner decisions of 2026-10-30 in Rules decisions/driver-g1.md, driver-g2.md, driver-g9.md). Safe to run twice.

-- G2-D1 "Keep old until new approved": an upload of an approved (or expired) type waits here as a renewal; the approved
-- document stays untouched until an admin approves the renewal. One renewal per document; the file is sealed like
-- document_files.
CREATE TABLE IF NOT EXISTS document_renewals (
  renewal_id   text PRIMARY KEY CHECK (renewal_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  document_id  text NOT NULL UNIQUE REFERENCES documents (document_id) ON DELETE CASCADE,
  status       text NOT NULL DEFAULT 'in_review' CHECK (status IN ('in_review', 'rejected')),
  expires_at   timestamptz,
  file_name    text NOT NULL,
  media_type   text NOT NULL,
  file_size    integer NOT NULL CHECK (file_size >= 0),
  uploaded_at  timestamptz NOT NULL,
  reviewed_at  timestamptz,
  reviewed_by  text,
  review_note  text,
  version      integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  key_id       text NOT NULL,
  iv           bytea NOT NULL,
  tag          bytea NOT NULL,
  ciphertext   bytea NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- G9 (owner: "Never store messages between rider or driver in driver app or rider app"): chat notices go.
DELETE FROM notifications WHERE kind = 'trip_message';

-- G2-D5.4: the owner's test cars TST 001–003 keep working: 7 seats and electric, so XL and Electric fit. Still approved.
UPDATE vehicles SET seats = 7, fuel = 'electric', version = version + 1, updated_at = now()
WHERE upper(replace(plate, ' ', '')) IN ('TST001', 'TST002', 'TST003') AND (seats <> 7 OR fuel IS DISTINCT FROM 'electric');

-- G1-B2: the terms of use and the privacy policy per country, versioned (version 0 = the contract's drafts).
CREATE TABLE IF NOT EXISTS legal_texts (
  country       text NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  version       integer NOT NULL CHECK (version >= 1),
  terms         jsonb NOT NULL,
  privacy       jsonb NOT NULL,
  company       jsonb NOT NULL DEFAULT '{}'::jsonb,
  reaccept      boolean NOT NULL DEFAULT false,
  published_at  timestamptz NOT NULL,
  published_by  text NOT NULL,
  PRIMARY KEY (country, version)
);

CREATE TABLE IF NOT EXISTS legal_acceptances (
  actor        text NOT NULL CHECK (actor IN ('rider', 'driver')),
  subject_id   text NOT NULL,
  country      text NOT NULL,
  version      integer NOT NULL,
  accepted_at  timestamptz NOT NULL,
  PRIMARY KEY (actor, subject_id, country, version)
);

