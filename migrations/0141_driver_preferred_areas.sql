-- v0.18.172 (contract.json#preferredAreas; owner 2026-11-27 "house icon on Bokade resor opens a picker of preferred areas",
-- 2026-11-28 "Yes, both ways"): the areas a driver may prefer (kommun, stadsdelsomrade, city, arrondissement, commune,
-- departement) and his list. Additive only (Rule 21): drivers.home_area (0051_book_later.sql) stays.
-- The rows are NOT in this file: src/areas/seed.ts upserts them at boot from data/areas (in the image).
CREATE TABLE IF NOT EXISTS areas (
  area_id text PRIMARY KEY,                 -- e.g. SE-K-0184, SE-SDO-SODERMALM, FR-C-91326, FR-A-75104, FR-CITY-PARIS, FR-D-91
  zone_id text NOT NULL,                    -- Z001 Stockholm / FR-PC Paris
  country text NOT NULL,                    -- SE | FR
  kind text NOT NULL CHECK (kind IN ('kommun', 'stadsdelsomrade', 'city', 'arrondissement', 'commune', 'departement')),
  parent_area_id text,
  name text NOT NULL,
  name_override text,                       -- admin's (PATCH /admin/areas/{areaId}); the seed never writes it
  parent_name text,
  search_key text NOT NULL,                 -- lower case, accents removed (Söder -> soder, Saint-Denis -> saint denis)
  polygons jsonb NOT NULL,                  -- MULTIPOLYGON [ polygon = [outer ring, hole, ...], ... ], ring = [[lat, lng], ...] not closed
  bbox jsonb NOT NULL,                      -- { south, west, north, east } over all polygons
  derived boolean NOT NULL DEFAULT false,   -- true = outline built by Movera (Stockholm districts), approximate
  source text NOT NULL,
  licence text NOT NULL,
  source_year integer NOT NULL,
  active boolean NOT NULL DEFAULT true,     -- admin's; the seed never writes it after the insert
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS areas_zone_search ON areas (zone_id, active, search_key);
-- One row per data set seeded (data/areas/manifest.json sha256): the boot seed is skipped when its hash is here.
CREATE TABLE IF NOT EXISTS area_seed_runs (
  manifest_sha text PRIMARY KEY,
  rows integer NOT NULL,
  seeded_at timestamptz NOT NULL DEFAULT now()
);
-- A constant default (Postgres 11+ adds it without a table rewrite).
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS preferred_area_ids text[] NOT NULL DEFAULT '{}';
-- undo: (Rule 21: only with the owner's OK, the drivers' lists and the admin's switches would be lost)
-- ALTER TABLE drivers DROP COLUMN IF EXISTS preferred_area_ids;
-- DROP TABLE IF EXISTS area_seed_runs;
-- DROP TABLE IF EXISTS areas;
