-- Live clean-up 1 (contract v0.18.13, audit 2026-11-02).
-- G5-8 smart late rule: the latest heading-to-pickup check of a trip (TripProjection.headingCheck), from accept to arrival.
ALTER TABLE trips ADD COLUMN IF NOT EXISTS heading_check jsonb;
-- Driving-time limits (decisions/driving-time-limits.md): when the driver last went offline, and when his counted
-- driving time started (reset after drivingLimits.resetAfterOfflineHours offline in a row).
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS went_offline_at timestamptz;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS driving_since timestamptz;
-- Audit M1: one payout per currency, so the weekly "once" rule is per driver, period AND currency.
DROP INDEX IF EXISTS payouts_weekly_once;
CREATE UNIQUE INDEX payouts_weekly_once ON payouts (driver_id, period_start, currency) WHERE source = 'weekly';
-- Every way a driver goes offline (his own tap, auto offline, admin, no position) stamps went_offline_at with the
-- command's own time (updated_at), so the 6-hour reset sees the real offline start.
CREATE OR REPLACE FUNCTION drivers_went_offline() RETURNS trigger AS $$
BEGIN
  IF NEW.online_status = 'offline' AND OLD.online_status IS DISTINCT FROM 'offline' THEN
    NEW.went_offline_at := coalesce(NEW.updated_at, now());
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS drivers_went_offline ON drivers;
CREATE TRIGGER drivers_went_offline BEFORE UPDATE OF online_status ON drivers FOR EACH ROW EXECUTE FUNCTION drivers_went_offline();
