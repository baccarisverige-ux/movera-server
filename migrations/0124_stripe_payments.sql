-- v0.18.141 (DRAFT, contract.json#stripeFees; owner 2026-11-20 "So we use stripe"): Stripe is used for exactly two
-- things, the rider's owed fee (purpose rider_fee, ref_id = the fee's trip) and later the driver's monthly amount owed
-- to Movera (purpose driver_invoice). One row per Stripe PaymentIntent; at most one open per purpose + ref. Each Stripe
-- event id is stored once so a repeated webhook changes nothing. No key or card data is stored (the PaymentIntent's
-- client secret is kept only to answer a repeated pay call with the same open intent). Not on main / Render yet.
CREATE TABLE IF NOT EXISTS stripe_payments (
  payment_intent_id text PRIMARY KEY,
  purpose      text NOT NULL CHECK (purpose IN ('rider_fee', 'driver_invoice')),
  subject_id   text NOT NULL,
  ref_id       text NOT NULL,
  currency     text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  status       text NOT NULL CHECK (status IN ('requires_payment', 'processing', 'succeeded', 'failed', 'canceled', 'refund_pending', 'refunded')),
  client_secret text,
  paid_twice   boolean NOT NULL DEFAULT false,
  refund_id    text,
  created_at   timestamptz NOT NULL,
  paid_at      timestamptz,
  refunded_at  timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS stripe_payments_one_open ON stripe_payments (purpose, ref_id) WHERE status IN ('requires_payment', 'processing');
CREATE INDEX IF NOT EXISTS stripe_payments_subject ON stripe_payments (purpose, subject_id, created_at);
CREATE TABLE IF NOT EXISTS stripe_events (
  event_id    text PRIMARY KEY,
  type        text NOT NULL,
  received_at timestamptz NOT NULL
);
-- undo:
-- DROP TABLE IF EXISTS stripe_events; DROP TABLE IF EXISTS stripe_payments;
