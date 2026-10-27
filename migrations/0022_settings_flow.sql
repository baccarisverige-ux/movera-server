-- Contract v0.8.0 settings flow (owner 2026-10-27).
-- §6.4 country standard and §6.5 country rules: drafts and live documents may belong to a country as well as to a
-- zone. A country's documents use the scope key 'standard-<CC>' (e.g. standard-SE) in zone_id; the server checks
-- the key (config/service.ts scopeOf), so the zone foreign key goes.
ALTER TABLE config_drafts DROP CONSTRAINT IF EXISTS config_drafts_zone_id_fkey;
ALTER TABLE config_live DROP CONSTRAINT IF EXISTS config_live_zone_id_fkey;
ALTER TABLE config_drafts DROP CONSTRAINT IF EXISTS config_drafts_doc_check;
ALTER TABLE config_drafts ADD CONSTRAINT config_drafts_doc_check CHECK (doc IN ('rider_app_config', 'driver_app_config', 'pricing', 'dispatch', 'country_rules'));
ALTER TABLE config_drafts ADD CONSTRAINT config_drafts_scope_check CHECK (zone_id !~ '^standard-' OR zone_id ~ '^standard-[A-Z]{2}$');
ALTER TABLE config_live ADD CONSTRAINT config_live_scope_check CHECK (zone_id !~ '^standard-' OR zone_id ~ '^standard-[A-Z]{2}$');

-- §6.6: which pricing document a quote and a trip were priced with (the zone's own or the country standard's key),
-- and every rule of booking time a booked trip keeps (contract.json#bookingSnapshot).
ALTER TABLE quotes ADD COLUMN pricing_scope text;
ALTER TABLE trips ADD COLUMN pricing_scope text;
ALTER TABLE trips ADD COLUMN booking_rules jsonb;

-- §6.7 (owner 2026-10-27): an Exclusive offer sent while the driver is on a trip never counts toward auto-offline.
-- Every offer remembers whether its driver was on a trip when it was sent.
ALTER TABLE offers ADD COLUMN driver_on_trip boolean NOT NULL DEFAULT false;
CREATE FUNCTION offers_driver_on_trip() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.driver_on_trip := COALESCE((SELECT online_status = 'on_trip' FROM drivers WHERE driver_id = NEW.driver_id), false);
  RETURN NEW;
END $$;
CREATE TRIGGER offers_driver_on_trip BEFORE INSERT ON offers FOR EACH ROW EXECUTE FUNCTION offers_driver_on_trip();
