-- movera-server migration 0018 (audit Phase 4, P4-2): every document upload a driver starts, so the server can
-- limit uploads per driver and hour (429 upload_limit) before reading a file of up to 10 MB into memory.
CREATE TABLE document_upload_attempts (
  driver_id  text NOT NULL REFERENCES drivers (driver_id),
  at         timestamptz NOT NULL
);
CREATE INDEX document_upload_attempts_driver ON document_upload_attempts (driver_id, at);
