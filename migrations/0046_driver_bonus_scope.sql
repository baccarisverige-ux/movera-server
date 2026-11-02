-- Owner bug 2026-11-01 (admin "Add money", Apply to: Exclusive → the driver saw it on a Radar offer): the money an
-- admin adds is kept per kind of offer. NULL = the old single bonus (driver_bonus_minor / priority) for both kinds.
-- Safe to run twice.
ALTER TABLE trips ADD COLUMN IF NOT EXISTS bonus_exclusive_minor bigint;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS bonus_radar_minor bigint;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS priority_exclusive boolean;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS priority_radar boolean;
