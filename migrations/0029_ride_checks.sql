-- movera-server migration 0029: ride check answers (contract v0.12.0 §22, owner safety part 2 decisions 2026-10-28).
-- One row per ride check an app reported (the card showed and/or was answered), kept on the trip. "ok" stays here only;
-- "need_help" and no answer within 2 minutes open (or join) the trip's ride_check incident.
CREATE TABLE ride_checks (
  trip_id text NOT NULL REFERENCES trips (trip_id),
  side text NOT NULL CHECK (side IN ('rider', 'driver')),
  check_id text NOT NULL,
  trigger text NOT NULL,
  subject_id text NOT NULL,
  shown_at timestamptz,
  answer text CHECK (answer IN ('ok', 'need_help')),
  answered_at timestamptz,
  no_answer_at timestamptz,
  position jsonb,
  incident_id text REFERENCES incidents (incident_id),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (trip_id, side, check_id)
);

-- Incident.alarm: the panel rings and the incident escalates (sos, driver_silent, ride_check need_help).
ALTER TABLE incidents ADD COLUMN alarm boolean NOT NULL DEFAULT true;
-- Incident.rideCheck { checkId, trigger, by, answer, shownAt?, answeredAt?, lateAnswer? } for kind ride_check.
ALTER TABLE incidents ADD COLUMN ride_check jsonb;
