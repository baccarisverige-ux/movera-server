-- movera: no-transaction
-- v0.18.90 BQ-M21 (contract.json#moneyBase.lostDriverPaid; owner 2026-11-13 23:42 UTC "Movera commission is how much
-- movera keep"): what Movera paid on a trip to the driver(s) who lost it (the driverBonus of an admin reassign / cancel,
-- a bonus entry each). The admin view takes it off moneySplit.movera / moveraKeepsNow. Raised by src/admin/trips.ts
-- keepLostDriverPay in the same transaction as the bonus entry.
-- Rule 46 (M21 supervisor must-fix 1): no transaction around the file, so each statement commits on its own and the
-- ADD COLUMN's short ACCESS EXCLUSIVE lock (a constant default rewrites no row) is released before the backfill runs.
-- Both statements can run again safely (IF NOT EXISTS; the backfill sets the same value again).
ALTER TABLE trips ADD COLUMN IF NOT EXISTS lost_driver_paid_minor bigint NOT NULL DEFAULT 0;
-- Backfill (M21 supervisor must-fix 2) from the exact source: every admin trip.reassign / trip.cancel audit row with a
-- driverBonus (written in the same transaction as the bonus entry since cfeef73, 2026-10-24; admin_audit is never
-- pruned). This also counts a lost driver who got the trip back. Only those trips' rows are locked (row locks while this
-- one statement runs, never the table).
UPDATE trips t SET lost_driver_paid_minor = b.paid
  FROM (SELECT a.target_id AS trip_id, sum((a.detail->'driverBonus'->>'amountMinor')::bigint) AS paid
          FROM admin_audit a
         WHERE a.action IN ('trip.reassign', 'trip.cancel') AND a.target_type = 'trip'
           AND jsonb_typeof(a.detail->'driverBonus') = 'object' AND (a.detail->'driverBonus'->>'amountMinor') IS NOT NULL
         GROUP BY a.target_id) b
 WHERE t.trip_id = b.trip_id AND t.lost_driver_paid_minor IS DISTINCT FROM b.paid;
-- undo:
-- ALTER TABLE trips DROP COLUMN IF EXISTS lost_driver_paid_minor;
