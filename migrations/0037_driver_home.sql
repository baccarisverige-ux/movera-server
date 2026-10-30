-- movera-server migration 0037: driver group 3 "Home & going online" (contract v0.18.4 §29, owner G3-R4).
-- Riders online per zone are real: the rider's last authenticated map or price call and the zone it was in.
ALTER TABLE riders ADD COLUMN last_seen_at timestamptz;
ALTER TABLE riders ADD COLUMN last_seen_zone_id text;
CREATE INDEX riders_last_seen ON riders (last_seen_at) WHERE last_seen_at IS NOT NULL;
-- G3-R1: the no-position job looks for online drivers.
CREATE INDEX drivers_online ON drivers (online_status) WHERE online_status = 'online';
