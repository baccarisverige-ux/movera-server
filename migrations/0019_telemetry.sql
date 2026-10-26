-- movera-server migration 0019 (audit Phase 4, P4-5): app logs, analytics events and crash reports
-- (contract §11, POST /telemetry/logs|analytics|crashes), scrubbed before storing and deleted after 30 days.
CREATE TABLE telemetry (
  telemetry_id bigserial PRIMARY KEY,
  kind         text NOT NULL CHECK (kind IN ('log', 'analytics', 'crash')),
  level        text,
  event        text,
  actor        text,
  subject_id   text,
  body         jsonb NOT NULL,
  at           timestamptz NOT NULL
);
CREATE INDEX telemetry_at ON telemetry (at);
