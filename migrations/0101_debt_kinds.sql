-- movera: no-transaction
-- S5 J8 (contract v0.18.84 debtModel.migrations 0101; owner Q-M1 2026-11-12 "into the wallet", Q-S5-1 "Both"):
-- the rider's wallet ledger gets two kinds, `fee` (an unpaid cancel / no-show fee, −fee) and `debt_paid` (+debt, the
-- debt read and paid with a trip), and the driver's earnings get `paid_to_movera` (+amount, the admin's "Driver paid
-- Movera"). Rule 46: each CHECK is swapped as ADD … NOT VALID (no table scan under the lock) + VALIDATE (no write lock),
-- each its own statement (no-transaction file: the short lock of the swap is never held while VALIDATE scans).
-- Every statement re-runs safely (IF EXISTS / IF NOT EXISTS), so a cut-off run is simply run again.
ALTER TABLE wallet_entries DROP CONSTRAINT IF EXISTS wallet_entries_kind_check;
ALTER TABLE wallet_entries ADD CONSTRAINT wallet_entries_kind_check
  CHECK (kind IN ('topup', 'charge', 'refund', 'payout', 'adjustment', 'fee', 'debt_paid')) NOT VALID;
ALTER TABLE wallet_entries VALIDATE CONSTRAINT wallet_entries_kind_check;

ALTER TABLE earnings_entries DROP CONSTRAINT IF EXISTS earnings_entries_kind_check;
ALTER TABLE earnings_entries ADD CONSTRAINT earnings_entries_kind_check
  CHECK (kind IN ('trip', 'pickup_pay', 'fee_share', 'adjustment', 'tip', 'bonus', 'paid_to_movera')) NOT VALID;
ALTER TABLE earnings_entries VALIDATE CONSTRAINT earnings_entries_kind_check;

-- Must-fix 3 (supervisor J8 round 1, deploy window): a fee J8 settled in the wallet (debt_paid, a correction, credit)
-- says so here. A fee an OLD server copy marked paid / waived / refunded during the deploy keeps false, so the payment
-- sweep (src/riders/debt.ts sweepOwedFees) lifts its −fee from the wallet once instead of charging it again.
ALTER TABLE rider_fees ADD COLUMN IF NOT EXISTS settled_in_wallet boolean NOT NULL DEFAULT false;

-- undo: (only while no fee / debt_paid / paid_to_movera row exists)
-- ALTER TABLE rider_fees DROP COLUMN IF EXISTS settled_in_wallet;
-- ALTER TABLE wallet_entries DROP CONSTRAINT IF EXISTS wallet_entries_kind_check;
-- ALTER TABLE wallet_entries ADD CONSTRAINT wallet_entries_kind_check CHECK (kind IN ('topup', 'charge', 'refund', 'payout', 'adjustment')) NOT VALID;
-- ALTER TABLE earnings_entries DROP CONSTRAINT IF EXISTS earnings_entries_kind_check;
-- ALTER TABLE earnings_entries ADD CONSTRAINT earnings_entries_kind_check CHECK (kind IN ('trip', 'pickup_pay', 'fee_share', 'adjustment', 'tip', 'bonus')) NOT VALID;
