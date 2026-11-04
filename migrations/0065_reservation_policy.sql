-- v0.18.19 (owner 2026-11-03, contract.json#bookLater.liveFixes.includedWaiting): ONE included waiting for booked rides,
-- the same in every zone (admin Dispatch › Bokningar, "Included waiting" of the reservation policy). The server keeps it
-- here; a booked ride's free waiting is this many minutes, counted from the pickup time.
CREATE TABLE reservation_policy (
  id                    smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  included_waiting_min  integer NOT NULL DEFAULT 5 CHECK (included_waiting_min BETWEEN 0 AND 60),
  rev                   integer NOT NULL DEFAULT 1 CHECK (rev >= 1),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            text
);
INSERT INTO reservation_policy (id) VALUES (1);
