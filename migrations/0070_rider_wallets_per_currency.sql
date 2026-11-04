-- contract v0.18.28 (fix job 6, ledger L11/R11, owner Q4 2026-11-04: "leave old wallet rows; show balances per currency
-- from now on"): the rider's wallet keeps one balance per currency. A France refund lands in the EUR balance and only
-- pays EUR trips; nothing is ever converted.
CREATE TABLE rider_wallets (
  rider_id      text NOT NULL REFERENCES riders (rider_id),
  currency      text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  balance_minor bigint NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rider_id, currency)
);
-- Old rows untouched (owner Q4, rule 21): riders.wallet_minor and every wallet_entries row stay as they are. The one
-- old balance was always shown to the rider as SEK (GET /wallet answered currency "SEK"), so it is copied as the SEK
-- balance; from now on rider_wallets is the balance and riders.wallet_minor is no longer written.
INSERT INTO rider_wallets (rider_id, currency, balance_minor, updated_at)
SELECT rider_id, 'SEK', wallet_minor, updated_at FROM riders WHERE wallet_minor <> 0;
