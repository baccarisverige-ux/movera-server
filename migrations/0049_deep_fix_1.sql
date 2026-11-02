-- Deep fix round 1 (contract v0.18.14, fix list 2026-11-02).
-- g7-g9 H1: what every accepted route change moved the price by; the early-end cap is booked fare + this.
ALTER TABLE trips ADD COLUMN IF NOT EXISTS route_delta_minor bigint NOT NULL DEFAULT 0;
-- g1-g3 H2: a right code is marked, so the per-number daily lock counts only wrong codes (attempts − verified).
ALTER TABLE otp_sessions ADD COLUMN IF NOT EXISTS verified boolean NOT NULL DEFAULT false;
-- g1-g3 H1: a driver set offline because a document expired during his shift.
ALTER TABLE drivers DROP CONSTRAINT IF EXISTS drivers_offline_reason_check;
ALTER TABLE drivers ADD CONSTRAINT drivers_offline_reason_check CHECK (offline_reason IS NULL OR offline_reason IN ('no_position', 'missed_offers', 'vehicle_blocked', 'fleet_removed', 'account_status', 'admin', 'documents_expired'));
