-- Contract v0.7.2 (owner 2026-10-28, contract.json#surgeLive): one sample per open zone and minute, smart surge on or
-- off, so the admin's Surge tab shows real demand, price checks and the surge timeline. Kept 8 days.
CREATE TABLE surge_samples (
  zone_id      text NOT NULL REFERENCES zones (zone_id),
  at           timestamptz NOT NULL,
  requests     integer NOT NULL CHECK (requests >= 0),
  free_drivers integer NOT NULL CHECK (free_drivers >= 0),
  ratio        numeric(8, 3) NOT NULL CHECK (ratio >= 0),
  multiplier   numeric(4, 2) NOT NULL CHECK (multiplier >= 1),
  source       text NOT NULL CHECK (source IN ('manual', 'scheduled', 'smart', 'off')),
  PRIMARY KEY (zone_id, at)
);
