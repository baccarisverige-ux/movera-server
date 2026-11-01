-- movera-server migration 0042: driver group 6, arrived and waiting (contract v0.18.8 §34, contract.json#arrivedWaiting;
-- Rules decisions/driver-g6.md). Safe to run twice.

-- Rider PIN before Start (per-zone admin switch, default off): the 4-digit PIN of the trip (the rider and the admin see it),
-- the wrong tries in a row, the lock after too many and when the driver gave the right one.
ALTER TABLE trips ADD COLUMN IF NOT EXISTS pickup_pin char(4);
ALTER TABLE trips ADD COLUMN IF NOT EXISTS pin_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS pin_locked_until timestamptz;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS pin_verified_at timestamptz;

-- Reverse no-show: a fee already paid is refunded to the rider's wallet (status refunded).
ALTER TABLE rider_fees DROP CONSTRAINT IF EXISTS rider_fees_status_check;
ALTER TABLE rider_fees ADD CONSTRAINT rider_fees_status_check CHECK (status IN ('owed', 'paid', 'waived', 'refunded'));
