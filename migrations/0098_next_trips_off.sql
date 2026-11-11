-- v0.18.65 §86 (owner phone test 2026-11-11, contract.json#nextTripsSwitch): the driver stopped next-trip offers on
-- the trip sheet's radar for his current trip (rule 33: the state lives here, not in a server copy's memory).
-- Cleared when each trip of his ends (releaseDriver).
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS next_trips_off boolean NOT NULL DEFAULT false;
