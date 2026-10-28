-- contract v0.10.3 (owner Reports answers 2026-10-28): money lines of the KPI summary. Existing rows get 0 and are
-- re-summed by the backfill (npm run admin -- kpi-backfill --from <first day>).
ALTER TABLE kpi_days
  ADD COLUMN tips_minor bigint NOT NULL DEFAULT 0,
  ADD COLUMN refunds_minor bigint NOT NULL DEFAULT 0,
  ADD COLUMN fees_minor bigint NOT NULL DEFAULT 0,
  ADD COLUMN movera_earnings_minor bigint NOT NULL DEFAULT 0;
