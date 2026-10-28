-- movera-server migration 0026: content from the admin to the apps (contract v0.10.0 §19, owner Content answers 2026-10-28).

-- Every published version of a content place per zone; the highest version is the live one (history = all rows).
CREATE TABLE content_items (
  slot          text NOT NULL,
  zone_id       text NOT NULL REFERENCES zones (zone_id),
  version       integer NOT NULL CHECK (version >= 1),
  title         text NOT NULL,
  text          jsonb NOT NULL,
  image         text,
  expires_at    timestamptz,
  reaccept      boolean,
  versions      jsonb,
  published_at  timestamptz NOT NULL,
  published_by  text NOT NULL,
  restored_from integer,
  PRIMARY KEY (slot, zone_id, version)
);
CREATE INDEX content_items_zone ON content_items (zone_id, slot, version DESC);

-- Who accepted which legal version in which zone, and when.
CREATE TABLE terms_acceptances (
  actor            text NOT NULL CHECK (actor IN ('rider', 'driver')),
  subject_id       text NOT NULL,
  zone_id          text NOT NULL REFERENCES zones (zone_id),
  content_version  integer NOT NULL,
  accepted_at      timestamptz NOT NULL,
  PRIMARY KEY (actor, subject_id, zone_id, content_version)
);
CREATE INDEX terms_acceptances_zone ON terms_acceptances (zone_id, accepted_at DESC);
