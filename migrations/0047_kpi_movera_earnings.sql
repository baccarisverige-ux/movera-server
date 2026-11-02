-- Audit 2026-11-02 H2 (contract v0.18.13): kpi_days.movera_earnings_minor took pickup pay and the driver bonus off
-- twice (trips.commission_minor is already net of them, rules/commission.ts) and never took refunds off. Rewrite the
-- stored days with the new rule (applied once by the migration runner).
UPDATE kpi_days SET movera_earnings_minor = movera_earnings_minor + pickup_pay_minor + driver_bonus_minor - refunds_minor;
