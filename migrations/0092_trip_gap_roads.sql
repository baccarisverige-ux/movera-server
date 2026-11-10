-- Owner decision 2026-11-10 (road snapping of GPS gaps, src/trips/ride/gapRoads.ts): the road distance OSRM gave for a
-- gap in a trip's trace (tunnel, signal loss), between the kept fixes measured at from_ts and to_ts. Paid km
-- (kmOnBoard) reads only this table, so every server copy and every restart pays the same km. road_m null = asked,
-- no road answer (routing off or down): the straight line is paid. At most 8 rows per trip (the call cap).
CREATE TABLE trip_gap_roads (
  trip_id    text NOT NULL REFERENCES trips (trip_id),
  from_ts    timestamptz NOT NULL,
  to_ts      timestamptz NOT NULL,
  road_m     integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trip_id, from_ts, to_ts)
);

-- undo:
-- DROP TABLE IF EXISTS trip_gap_roads;
