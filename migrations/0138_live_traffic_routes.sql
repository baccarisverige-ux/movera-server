-- v0.18.163 (contract.json#liveTraffic; owner 2026-11-25 "Google trafic réel", then "the cheapest method, about 2 Google
-- calls per trip"): a quote's road comes from Google Routes with live traffic (route_source 'google') and keeps Google's
-- encoded polyline; the trip copies it and the ETA follows it during the trip with no new call (trips/etaRoute.ts).
-- The inline check of 0005 (Postgres name quotes_route_source_check) is replaced by one that also allows 'google'.
-- NOT VALID (R2): rows already there are 'osrm' or 'estimate' and stay right; new rows are checked. New columns are
-- nullable with no default (no table rewrite).
ALTER TABLE quotes DROP CONSTRAINT IF EXISTS quotes_route_source_check;
ALTER TABLE quotes ADD CONSTRAINT quotes_route_source_163 CHECK (route_source IN ('google', 'osrm', 'estimate')) NOT VALID;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS route_polyline text;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS route_polyline text;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS eta_route jsonb;
-- undo: only once no quote has route_source 'google' (quotes are swept a day after they expire):
-- ALTER TABLE trips DROP COLUMN IF EXISTS eta_route;
-- ALTER TABLE trips DROP COLUMN IF EXISTS route_polyline;
-- ALTER TABLE quotes DROP COLUMN IF EXISTS route_polyline;
-- ALTER TABLE quotes DROP CONSTRAINT IF EXISTS quotes_route_source_163;
-- ALTER TABLE quotes ADD CONSTRAINT quotes_route_source_check CHECK (route_source IN ('osrm', 'estimate')) NOT VALID;
