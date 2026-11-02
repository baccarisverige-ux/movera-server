-- v0.18.16 A2 (owner build-spec Q4): an admin can pause one driver's payouts from his profile. Renumber at merge.
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS payout_hold_at timestamptz;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS payout_hold_reason text;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS payout_hold_by text;
