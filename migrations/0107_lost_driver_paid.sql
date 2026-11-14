-- v0.18.90 BQ-M21 (contract.json#moneyBase.lostDriverPaid; owner 2026-11-13 23:42 UTC "Movera commission is how much
-- movera keep"): what Movera paid on a trip to the driver(s) who lost it (the driverBonus of an admin reassign / cancel,
-- a bonus entry each). The admin view takes it off moneySplit.movera / moveraKeepsNow. Raised by src/admin/trips.ts
-- payLostDriver in the same transaction as the bonus entry. ADD COLUMN with a constant default changes no stored row.
ALTER TABLE trips ADD COLUMN IF NOT EXISTS lost_driver_paid_minor bigint NOT NULL DEFAULT 0;
-- Trips paid before this file: on a trip with no paid end every bonus entry is a lost-driver payment (bonuses are only
-- written at the paid end, after it on a completed trip, or by cancel / reassign); on a paid trip, the bonus entries of
-- drivers other than the trip's driver. Only rows with such entries are touched (row locks, no table lock).
UPDATE trips t SET lost_driver_paid_minor = b.paid
  FROM (SELECT e.trip_id, sum(e.amount_minor) AS paid
          FROM earnings_entries e JOIN trips x ON x.trip_id = e.trip_id
         WHERE e.kind = 'bonus'
           AND (NOT (x.status = 'completed' OR coalesce(x.payment_status, '') IN ('captured', 'partially_refunded', 'refunded'))
                OR e.driver_id IS DISTINCT FROM x.driver_id)
         GROUP BY e.trip_id) b
 WHERE t.trip_id = b.trip_id AND t.lost_driver_paid_minor IS DISTINCT FROM b.paid;
-- undo:
-- ALTER TABLE trips DROP COLUMN IF EXISTS lost_driver_paid_minor;
