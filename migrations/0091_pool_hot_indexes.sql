-- movera: no-transaction
-- Stress T-A follow-up (owner 2026-11-10, audits/stress-ta-2026-11-10/RESULT-2.md): the DB pool ran out at 200 + 200
-- because hot queries read whole tables. Rule 46: every index is built CONCURRENTLY (no table lock).

-- B1.11: driving-time limit (drivers/drivingTime.ts) read every trip of the table for each driver (no driver_id
-- index). A finished trip counts only while its last time is inside the window: (driver, its last time).
CREATE INDEX CONCURRENTLY IF NOT EXISTS trips_driver_last ON trips (driver_id, (greatest(arrived_at, boarded_at, ended_at, updated_at))) WHERE driver_id IS NOT NULL;
-- ... and a running trip always counts: the driver's trips that are not over yet (a small index).
CREATE INDEX CONCURRENTLY IF NOT EXISTS trips_driver_open ON trips (driver_id) WHERE driver_id IS NOT NULL AND status NOT IN ('completed', 'cancelled_by_rider', 'cancelled_by_driver', 'cancelled_by_admin', 'cancelled_by_system', 'no_show', 'expired', 'failed');
-- B3.8: the "almost there" sent-check of every ETA tick read notifications by trip with no index.
CREATE INDEX CONCURRENTLY IF NOT EXISTS notifications_trip ON notifications (trip_id, created_at) WHERE trip_id IS NOT NULL;
-- B1.13: the general timer lanes (every kind but the trip lane's) walked the whole trip-lane backlog on timers_due.
CREATE INDEX CONCURRENTLY IF NOT EXISTS timers_due_general ON timers (due_at, timer_id) WHERE kind NOT IN ('trip_eta', 'ride_check_scan', 'near_dropoff');

-- undo:
-- DROP INDEX CONCURRENTLY IF EXISTS trips_driver_last;
-- DROP INDEX CONCURRENTLY IF EXISTS trips_driver_open;
-- DROP INDEX CONCURRENTLY IF EXISTS notifications_trip;
-- DROP INDEX CONCURRENTLY IF EXISTS timers_due_general;
