-- v0.18.37 §61 go offline after trips (owner 2026-11-05, contract.json#goOfflineAfterTrips): the driver tapped Go offline
-- during a trip; he goes offline when his last trip ends (rule 33: the state lives here, not in a server copy's memory).
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS offline_after_trip boolean NOT NULL DEFAULT false;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS offline_after_trip_at timestamptz;
-- Driver.offlineReason after_trip: set when his last trip ended.
ALTER TABLE drivers DROP CONSTRAINT IF EXISTS drivers_offline_reason_check;
ALTER TABLE drivers ADD CONSTRAINT drivers_offline_reason_check CHECK (offline_reason IS NULL OR offline_reason IN ('no_position', 'missed_offers', 'vehicle_blocked', 'fleet_removed', 'account_status', 'admin', 'documents_expired', 'after_trip'));
