-- movera-server migration 0010: admin trip tools, refunds and the rider wallet (contract §3, §3.1; owner decisions 30–34).

-- Movera-paid money for a driver who lost a trip (reassign, admin cancel) is a bonus entry.
ALTER TABLE earnings_entries DROP CONSTRAINT earnings_entries_kind_check;
ALTER TABLE earnings_entries ADD CONSTRAINT earnings_entries_kind_check
  CHECK (kind IN ('trip', 'pickup_pay', 'fee_share', 'adjustment', 'tip', 'bonus'));
-- A trip can have several adjustments (refunds taken from the driver): one row each.
ALTER TABLE earnings_entries DROP CONSTRAINT earnings_entries_driver_id_trip_id_kind_key;
CREATE UNIQUE INDEX earnings_once_per_trip ON earnings_entries (driver_id, trip_id, kind) WHERE kind IN ('trip', 'pickup_pay', 'fee_share');

-- One wallet per rider (one currency in the test week): the balance and its ledger (WalletEntry).
ALTER TABLE riders ADD COLUMN wallet_minor bigint NOT NULL DEFAULT 0 CHECK (wallet_minor >= 0);
CREATE TABLE wallet_entries (
  entry_id     text PRIMARY KEY,
  rider_id     text NOT NULL REFERENCES riders (rider_id),
  kind         text NOT NULL CHECK (kind IN ('topup', 'charge', 'refund', 'payout', 'adjustment')),
  currency     char(3) NOT NULL,
  amount_minor bigint NOT NULL,
  trip_id      text REFERENCES trips (trip_id),
  at           timestamptz NOT NULL
);
CREATE INDEX wallet_entries_rider ON wallet_entries (rider_id, at DESC);

-- The wallet money a cash trip uses first (the driver collects the rest in cash).
ALTER TABLE trips ADD COLUMN wallet_applied_minor bigint NOT NULL DEFAULT 0;

-- Refunds (Refund). The rider chooses where the money goes (owner decision 30): the wallet at once, or Swish /
-- a bank account, which an admin pays by hand and marks paid.
CREATE TABLE refunds (
  refund_id     text PRIMARY KEY,
  trip_id       text NOT NULL REFERENCES trips (trip_id),
  rider_id      text NOT NULL REFERENCES riders (rider_id),
  currency      char(3) NOT NULL,
  amount_minor  bigint NOT NULL CHECK (amount_minor > 0),
  reason        text NOT NULL,
  status        text NOT NULL CHECK (status IN ('pending_approval', 'done', 'rejected')),
  approval_id   text,
  from_driver   boolean NOT NULL DEFAULT false,
  destination   text CHECK (destination IN ('wallet', 'swish', 'bank')),
  payout_to     jsonb,
  payout_status text CHECK (payout_status IN ('pending', 'paid')),
  paid_at       timestamptz,
  paid_by       text,
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL
);
CREATE INDEX refunds_trip ON refunds (trip_id);
CREATE INDEX refunds_rider ON refunds (rider_id, created_at DESC);
CREATE INDEX refunds_payout ON refunds (payout_status) WHERE payout_status = 'pending';
