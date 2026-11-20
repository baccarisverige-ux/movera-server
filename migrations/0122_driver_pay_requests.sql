-- Contract v0.18.139 contract.json#driverPayRequest (owner 2026-11-20 "ask driver monthly to pay how much due to
-- Movera ... link to pay"; TEMPORARY monthly settlement): one row per driver and month the server asked him to pay
-- what he owes Movera (src/drivers/payRequest.ts). The primary key (driver_id, month) is what makes the monthly job
-- ask each driver once: a second run, a retry or a second server copy inserts nothing and writes no notice.
-- asked_minor / currency = what he owed at that moment (for the screen's "asked" line; the amount to pay is always
-- read fresh). A NEW table: nothing the running app uses is locked (Rule 46).
CREATE TABLE IF NOT EXISTS driver_pay_requests (
  driver_id text NOT NULL,
  month text NOT NULL,
  currency text NOT NULL,
  asked_minor bigint NOT NULL,
  asked_at timestamptz NOT NULL,
  PRIMARY KEY (driver_id, month),
  CONSTRAINT driver_pay_requests_month CHECK (month ~ '^[0-9]{4}-[0-9]{2}$'),
  CONSTRAINT driver_pay_requests_asked_above_zero CHECK (asked_minor > 0)
);
-- undo:
-- DROP TABLE IF EXISTS driver_pay_requests;
