-- v0.18.16 A2 (owner build-spec Q4, contract.json#payoutMode): a country on Manual payouts makes its scheduled payouts
-- pending_approval until an admin approves the run. Safe to run twice.
ALTER TABLE payouts DROP CONSTRAINT IF EXISTS payouts_status_check;
ALTER TABLE payouts ADD CONSTRAINT payouts_status_check CHECK (status IN ('pending', 'pending_approval', 'paid'));
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS approved_at timestamptz;
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS approved_by text;
CREATE INDEX IF NOT EXISTS payouts_waiting_run ON payouts (period_end) WHERE status = 'pending_approval';
