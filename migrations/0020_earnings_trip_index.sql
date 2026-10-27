-- Audit Phase 7 (P7-S1): earnings_entries had no index that starts with trip_id, so the admin bonus check
-- (bonusSoFar: sum of a trip's bonus entries) read the whole table. Measured on 300,000 rows: 17.1 ms
-- parallel seq scan before, 0.07 ms index scan after. test/db/query_plans.test.ts pins it.
CREATE INDEX earnings_trip ON earnings_entries (trip_id, kind);
