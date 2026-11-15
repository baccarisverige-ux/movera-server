-- S5 J8 (contract v0.18.84 debtModel.dbFloor + debtModel.migrations 0102; owner Q-S5-3 "Block booking at max (Rec.)",
-- owner 2026-11-13 15:00 "Any amount"): a rider's wallet balance may now go below 0 (an unpaid fee is a negative
-- balance), down to a safety floor per currency that follows the admin's Max rider debt. The floor ONLY moves down
-- (src/riders/debtFloor.ts: an admin save of Max rider debt or of a cancel / no-show fee writes
-- min(current, −3 × max, −(max + 4 × the largest fee)) under the floor row's lock), so a stale read by a wallet write
-- only ever sees a higher (stricter) floor and no lock order between the two is needed.
-- Starting floors = 3 × the configDefaults.maxRiderDebt: SE −900 kr, FR −90 €, TN −252 DT. A currency with no row
-- keeps the old rule (never below 0).
CREATE TABLE IF NOT EXISTS wallet_floors (
  currency    char(3) PRIMARY KEY,
  floor_minor bigint NOT NULL CHECK (floor_minor <= 0),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO wallet_floors (currency, floor_minor) VALUES ('SEK', -90000), ('EUR', -9000), ('TND', -252000)
  ON CONFLICT (currency) DO NOTHING;

-- Every wallet write is checked against the floor of its currency in the same statement (a row trigger; no table scan,
-- no lock beyond the trigger's own short catalog lock).
CREATE OR REPLACE FUNCTION rider_wallets_floor_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  f bigint;
BEGIN
  IF NEW.balance_minor >= 0 THEN
    RETURN NEW;
  END IF;
  SELECT floor_minor INTO f FROM wallet_floors WHERE currency = NEW.currency;
  IF NEW.balance_minor < coalesce(f, 0) THEN
    RAISE EXCEPTION 'rider wallet % % below its floor %', NEW.rider_id, NEW.balance_minor, coalesce(f, 0)
      USING ERRCODE = 'check_violation', CONSTRAINT = 'rider_wallets_floor';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS rider_wallets_floor ON rider_wallets;
CREATE TRIGGER rider_wallets_floor BEFORE INSERT OR UPDATE OF balance_minor ON rider_wallets
  FOR EACH ROW EXECUTE FUNCTION rider_wallets_floor_check();

-- Only now is the old "never below 0" rule (0096) dropped: the floor already guards every write.
ALTER TABLE rider_wallets DROP CONSTRAINT IF EXISTS rider_wallets_balance_nonneg;

-- undo: (only while no balance is below 0)
-- ALTER TABLE rider_wallets ADD CONSTRAINT rider_wallets_balance_nonneg CHECK (balance_minor >= 0) NOT VALID;
-- DROP TRIGGER IF EXISTS rider_wallets_floor ON rider_wallets;
-- DROP FUNCTION IF EXISTS rider_wallets_floor_check();
-- DROP TABLE IF EXISTS wallet_floors;
