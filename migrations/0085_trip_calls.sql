-- v0.18.38 §62 (fix job 8, contract.json#inAppCalls): in-app calls between a trip's rider and driver. Every call state
-- lives here (rule 33: no call state in one server copy's memory); start / answer / end lock the row. No audio, no numbers.
CREATE TABLE IF NOT EXISTS trip_calls (
  call_id text PRIMARY KEY,
  trip_id text NOT NULL REFERENCES trips (trip_id),
  caller text NOT NULL CHECK (caller IN ('rider', 'driver')),
  callee text NOT NULL CHECK (callee IN ('rider', 'driver')),
  state text NOT NULL CHECK (state IN ('ringing', 'answered', 'ended', 'missed')),
  started_at timestamptz NOT NULL,
  answered_at timestamptz,
  ended_at timestamptz,
  ended_reason text CHECK (ended_reason IN ('hangup', 'declined', 'failed', 'missed', 'max_length', 'trip_cancelled'))
);
CREATE INDEX IF NOT EXISTS trip_calls_by_trip ON trip_calls (trip_id, started_at DESC);
-- One live call per trip, also when two server copies start one at the same moment.
CREATE UNIQUE INDEX IF NOT EXISTS trip_calls_one_live ON trip_calls (trip_id) WHERE state IN ('ringing', 'answered');

-- The call's CallView (or the relayed signal) on the trip event; new realtime kinds (contract.json#realtime.kinds).
ALTER TABLE trip_events ADD COLUMN IF NOT EXISTS call jsonb;
ALTER TABLE trip_events DROP CONSTRAINT IF EXISTS trip_events_kind_check;
ALTER TABLE trip_events ADD CONSTRAINT trip_events_kind_check
  CHECK (kind IN ('trip_projection', 'rider_cancelled', 'driver_cancelled', 'location', 'driver_arrived', 'rider_on_the_way', 'payment_updated', 'rating_updated', 'message', 'pickup_moved',
                  'call_ringing', 'call_answered', 'call_signal', 'call_ended', 'call_missed'));
