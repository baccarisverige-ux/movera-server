-- S7 W2 Q135 (Q-B10; owner 2026-11-15 "A) yes", Rules decisions/session-2026-11-06.md "Sitting W2"): trip event kinds
-- are checked in code, not by a CHECK on trip_events (the biggest table). Until now every new kind dropped and
-- re-added trip_events_kind_check (0041, 0085), and each re-add read the whole table under a lock.
-- From here the one list is TRIP_EVENT_KINDS in src/db/tripLog.ts (equal to contract.json#realtime.kinds, proven by
-- test/db/trip_event_kinds.test.ts); appendTripEvent, the only insert path, refuses any other kind before it writes.
-- A new kind is now a code + contract change with no migration.
-- Rule 46: DROP CONSTRAINT reads no row; its lock is held only for the catalog change, and the runner's lock_timeout
-- stops it waiting behind a long query. kind stays text NOT NULL. Safe to run again (IF EXISTS).
ALTER TABLE trip_events DROP CONSTRAINT IF EXISTS trip_events_kind_check;

-- The undo below puts back the list 0085 set (= TRIP_EVENT_KINDS on the day of this file), NOT VALID first so the
-- lock is short, then VALIDATE (a light lock). If a kind was added in code since, add it to the list first: otherwise
-- VALIDATE stops on the rows that carry it and the CHECK (already guarding new rows) refuses that kind.
-- undo:
-- ALTER TABLE trip_events DROP CONSTRAINT IF EXISTS trip_events_kind_check;
-- ALTER TABLE trip_events ADD CONSTRAINT trip_events_kind_check
--   CHECK (kind IN ('trip_projection', 'rider_cancelled', 'driver_cancelled', 'location', 'driver_arrived', 'rider_on_the_way', 'payment_updated', 'rating_updated', 'message', 'pickup_moved',
--                   'call_ringing', 'call_answered', 'call_signal', 'call_ended', 'call_missed')) NOT VALID;
-- ALTER TABLE trip_events VALIDATE CONSTRAINT trip_events_kind_check;
