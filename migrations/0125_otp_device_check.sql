-- movera: no-transaction
-- v0.18.138 (contract.json#deviceCheck; owner 2026-11-20 "Ok" to Rules audits/impact/sms-abuse-open-launch-2026-11-20.md,
-- Rules decisions/session-2026-11-06.md, plan/NUMBERS.md): SMS abuse guards on POST /auth/otp/request.
-- install_id: the app install that asked for the code (OtpRequest.installId), counted per hour
-- (countryLimits.codesPerDevicePerHour). device_check_sha256: SHA-256 of the Play Integrity / App Attest token used,
-- so one token is good once (unique). Both NULL on every older row and on a request without them.
-- Shapes are checked in code (src/auth/routes.ts), no CHECK here (check_migrations R2). Rule 46: nullable columns
-- with no default rewrite no row; the indexes are built CONCURRENTLY (no-transaction file, safe to run again).
ALTER TABLE otp_sessions ADD COLUMN IF NOT EXISTS install_id text;
ALTER TABLE otp_sessions ADD COLUMN IF NOT EXISTS device_check_sha256 text;
CREATE INDEX CONCURRENTLY IF NOT EXISTS otp_sessions_install_created_idx ON otp_sessions (install_id, created_at) WHERE install_id IS NOT NULL;
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS otp_sessions_device_check_uidx ON otp_sessions (device_check_sha256) WHERE device_check_sha256 IS NOT NULL;
-- undo:
-- DROP INDEX CONCURRENTLY IF EXISTS otp_sessions_device_check_uidx;
-- DROP INDEX CONCURRENTLY IF EXISTS otp_sessions_install_created_idx;
-- ALTER TABLE otp_sessions DROP COLUMN IF EXISTS device_check_sha256;
-- ALTER TABLE otp_sessions DROP COLUMN IF EXISTS install_id;
