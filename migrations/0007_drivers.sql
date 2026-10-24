-- movera-server migration 0007: vehicles, driver availability and location, trip GPS traces
-- (contract §2 Driver / Vehicle, §3.3 driverMotion, §12 live drivers; owner decision 11: traces kept 30 days).

CREATE TABLE vehicles (
  vehicle_id    text PRIMARY KEY CHECK (vehicle_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  driver_id     text NOT NULL REFERENCES drivers (driver_id),
  make          text NOT NULL,
  model         text NOT NULL,
  year          integer NOT NULL CHECK (year BETWEEN 1950 AND 2100),
  color         text NOT NULL,
  plate         text NOT NULL,
  seats         integer NOT NULL DEFAULT 4 CHECK (seats BETWEEN 1 AND 20),
  category_ids  text[] NOT NULL DEFAULT '{}',
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'blocked')),
  version       integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX vehicles_plate ON vehicles (upper(replace(plate, ' ', '')));
CREATE INDEX vehicles_driver ON vehicles (driver_id);

ALTER TABLE drivers ADD CONSTRAINT drivers_vehicle FOREIGN KEY (vehicle_id) REFERENCES vehicles (vehicle_id);
-- When the driver last became free (came online or finished a trip): the "waiting without a ride" score factor.
ALTER TABLE drivers ADD COLUMN last_free_at timestamptz;

-- The zone of the latest fix, so dispatch and the admin map can filter by zone without geometry per query.
ALTER TABLE driver_locations ADD COLUMN zone_id text REFERENCES zones (zone_id);
CREATE INDEX driver_locations_zone ON driver_locations (zone_id, received_at DESC);

-- Every fix during a trip (owner decision 11: deleted 30 days after the trip). Feeds end-early distance and the
-- admin trace.
CREATE TABLE trip_locations (
  trip_id      text NOT NULL REFERENCES trips (trip_id),
  driver_id    text NOT NULL,
  measured_at  timestamptz NOT NULL,
  lat          double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng          double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
  accuracy     double precision NOT NULL CHECK (accuracy >= 0),
  heading      double precision,
  speed_mps    double precision,
  moving       boolean NOT NULL DEFAULT false,
  PRIMARY KEY (trip_id, measured_at, driver_id)
);
CREATE INDEX trip_locations_measured ON trip_locations (measured_at);
