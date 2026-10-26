-- movera-server migration 0016: the driver goes silent with the rider on board (owner decision 2026-10-26).
-- After 30 minutes without a driver position the trip carries an admin alert
-- { kind: "driver_silent", silentSince, lastFixAt, at, autoFailAt }; after 3 hours the server fails the trip
-- and the alert stays on it as the reason. NULL: no alert.
ALTER TABLE trips ADD COLUMN driver_silent_alert jsonb;
