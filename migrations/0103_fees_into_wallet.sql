-- movera: no-transaction
-- S5 J8 (contract v0.18.84 debtModel.migrations 0103 + debtModel.riderWallet; owner Q-M1 2026-11-12): every fee still
-- owed moves into the rider's wallet once, as a WalletEntry kind fee (−fee) in the balance of the fee's currency.
-- The rider_fees row keeps its status (owed, history); the fee entry marks it as in the wallet.
-- Idempotent: one fee entry per trip (unique index, built CONCURRENTLY: no table lock), and the move is ONE statement
-- that only moves the balance for the entries it really inserted, so a second run (or an old server copy's fee, swept
-- again by src/riders/debt.ts at payment) never counts a fee twice.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS wallet_entries_fee_once ON wallet_entries (trip_id) WHERE kind = 'fee';

WITH owed AS (
  SELECT f.trip_id, f.rider_id, f.currency, f.amount_minor, f.created_at
    FROM rider_fees f
   WHERE f.status = 'owed'
     AND NOT EXISTS (SELECT 1 FROM wallet_entries w WHERE w.trip_id = f.trip_id AND w.kind = 'fee')
), ins AS (
  INSERT INTO wallet_entries (entry_id, rider_id, kind, currency, amount_minor, trip_id, at)
  -- entry_id like src/ids.ts newId("wlt", fee time): 10 Crockford base32 chars of the fee's milliseconds, so the rider's
  -- wallet history (ordered by entry_id) shows the fee at its own time; 16 more chars from the trip id keep it unique.
  SELECT 'wlt_' || (SELECT string_agg(substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ', ((floor(extract(epoch FROM o.created_at) * 1000)::bigint / power(32, 9 - i)::bigint) % 32)::int + 1, 1), '' ORDER BY i) FROM generate_series(0, 9) AS i)
         || upper(substr(md5(o.trip_id), 1, 16)), o.rider_id, 'fee', o.currency, -o.amount_minor, o.trip_id, o.created_at FROM owed o
  ON CONFLICT (trip_id) WHERE kind = 'fee' DO NOTHING
  RETURNING rider_id, currency, amount_minor
), sums AS (
  SELECT rider_id, currency, sum(amount_minor) AS delta FROM ins GROUP BY rider_id, currency
)
INSERT INTO rider_wallets (rider_id, currency, balance_minor, updated_at)
SELECT rider_id, currency, delta, now() FROM sums
ON CONFLICT (rider_id, currency) DO UPDATE SET balance_minor = rider_wallets.balance_minor + EXCLUDED.balance_minor, updated_at = now();

-- undo (moves the money back out; only before any fee entry was paid):
-- WITH d AS (DELETE FROM wallet_entries w WHERE w.kind = 'fee' AND w.at < '<deploy time>' RETURNING rider_id, currency, amount_minor),
--      s AS (SELECT rider_id, currency, sum(amount_minor) AS delta FROM d GROUP BY 1, 2)
-- UPDATE rider_wallets w SET balance_minor = w.balance_minor - s.delta FROM s WHERE w.rider_id = s.rider_id AND w.currency = s.currency;
-- DROP INDEX CONCURRENTLY IF EXISTS wallet_entries_fee_once;
