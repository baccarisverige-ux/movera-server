-- movera-server migration 0045: driver group 8, finish & cash (contract v0.18.10 §36, contract.json#finish;
-- Rules decisions/driver-g8.md). Safe to run twice.

-- Tips (TripProjection.tip), what ended the trip early (TripProjection.finish), Movera's changes to the driver's pay on a
-- trip (driver-pay, refunds taken from the driver) and the money refunded (admin moneySplit).
ALTER TABLE trips ADD COLUMN IF NOT EXISTS tip jsonb;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS end_info jsonb;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS driver_adjustments_minor bigint NOT NULL DEFAULT 0;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS refunded_minor bigint NOT NULL DEFAULT 0;
UPDATE trips t
   SET refunded_minor = r.total
  FROM (SELECT trip_id, sum(amount_minor) AS total FROM refunds WHERE status = 'done' GROUP BY trip_id) r
 WHERE r.trip_id = t.trip_id AND t.refunded_minor <> r.total;
-- A reversed no-show already set the earnings to 0 when the share was taken back, so its adjustment is not counted again.
UPDATE trips t
   SET driver_adjustments_minor = e.total
  FROM (SELECT trip_id, sum(amount_minor) AS total FROM earnings_entries WHERE kind = 'adjustment' GROUP BY trip_id) e
 WHERE e.trip_id = t.trip_id AND t.status <> 'no_show' AND t.driver_adjustments_minor <> e.total;

-- Owner G8 item 2: no Google Pay. No trip ever had it (booking always failed); the check no longer allows it.
ALTER TABLE trips DROP CONSTRAINT IF EXISTS trips_payment_method_check;
ALTER TABLE trips ADD CONSTRAINT trips_payment_method_check CHECK (payment_method IN ('card', 'apple_pay', 'cash', 'wallet'));
UPDATE quotes SET payment_method = NULL WHERE payment_method = 'google_pay';

-- ... and out of every stored rider / driver document (live as the next version with a history row, drafts, history).
CREATE OR REPLACE FUNCTION pg_temp.without_google_pay(d jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_set(d, '{paymentMethods}', coalesce((SELECT jsonb_agg(e) FROM jsonb_array_elements(d->'paymentMethods') e WHERE e <> '"google_pay"'::jsonb), '[]'::jsonb))
$$;
WITH changed AS (
  UPDATE config_live
     SET document = jsonb_set(pg_temp.without_google_pay(document), '{version}', to_jsonb(version + 1))
                    || jsonb_build_object('publishedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
         version = version + 1,
         published_at = now(),
         published_by = NULL
   WHERE doc IN ('rider_app_config', 'driver_app_config')
     AND jsonb_typeof(document->'paymentMethods') = 'array'
     AND document->'paymentMethods' @> '["google_pay"]'::jsonb
  RETURNING doc, zone_id, version, document, published_at
)
INSERT INTO config_history (doc, zone_id, version, document, published_at, published_by, approved_by, note)
  SELECT doc, zone_id, version, document, published_at, NULL, NULL, 'G8 item 2: Google Pay removed (migration 0045)'
  FROM changed
  ON CONFLICT (doc, zone_id, version) DO NOTHING;
UPDATE config_drafts
   SET document = pg_temp.without_google_pay(document), version = version + 1, updated_at = now()
 WHERE doc IN ('rider_app_config', 'driver_app_config')
   AND jsonb_typeof(document->'paymentMethods') = 'array'
   AND document->'paymentMethods' @> '["google_pay"]'::jsonb;
UPDATE config_history
   SET document = pg_temp.without_google_pay(document)
 WHERE doc IN ('rider_app_config', 'driver_app_config')
   AND jsonb_typeof(document->'paymentMethods') = 'array'
   AND document->'paymentMethods' @> '["google_pay"]'::jsonb;

-- France tips: the sample documents converted 10 / 20 / 30 kr into 0,90 / 1,80 / 2,70 €; the default is 1 / 2 / 5 €
-- (contract.json#configDefaults.countries.FR.tips). Only documents still on exactly the converted amounts move.
CREATE OR REPLACE FUNCTION pg_temp.fr_tips_converted(d jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_typeof(d->'tips') = 'array' AND jsonb_array_length(d->'tips') = 3
     AND (SELECT array_agg((t #>> '{amount,amountMinor}')::int ORDER BY o) FROM jsonb_array_elements(d->'tips') WITH ORDINALITY AS x(t, o)) = ARRAY[90, 180, 270]
     AND (SELECT bool_and(t #>> '{amount,currency}' = 'EUR') FROM jsonb_array_elements(d->'tips') t)
$$;
CREATE OR REPLACE FUNCTION pg_temp.fr_tips(d jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_set(d, '{tips}', (SELECT jsonb_agg(jsonb_set(t, '{amount,amountMinor}', to_jsonb((ARRAY[100, 200, 500])[o])) ORDER BY o) FROM jsonb_array_elements(d->'tips') WITH ORDINALITY AS x(t, o)))
$$;
WITH changed AS (
  UPDATE config_live
     SET document = jsonb_set(pg_temp.fr_tips(document), '{version}', to_jsonb(version + 1))
                    || jsonb_build_object('publishedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
         version = version + 1,
         published_at = now(),
         published_by = NULL
   WHERE doc IN ('rider_app_config', 'country_rules') AND pg_temp.fr_tips_converted(document)
  RETURNING doc, zone_id, version, document, published_at
)
INSERT INTO config_history (doc, zone_id, version, document, published_at, published_by, approved_by, note)
  SELECT doc, zone_id, version, document, published_at, NULL, NULL, 'G8: France tips 1 / 2 / 5 EUR (migration 0045)'
  FROM changed
  ON CONFLICT (doc, zone_id, version) DO NOTHING;
UPDATE config_drafts
   SET document = pg_temp.fr_tips(document), version = version + 1, updated_at = now()
 WHERE doc IN ('rider_app_config', 'country_rules') AND pg_temp.fr_tips_converted(document);

-- Live bug 2026-11-01: a rider's old unpaid fee carried by a trip was counted as Movera's commission. Commission is
-- fare − the outstanding_fee line − driver earnings − pickup pay − bonus (contract.json#finish.debt).
UPDATE trips t
   SET commission_minor = t.fare_minor - d.debt - coalesce(t.driver_earnings_minor, 0) - coalesce(t.pickup_pay_minor, 0) - coalesce(t.driver_bonus_minor, 0)
  FROM (SELECT trip_id, sum((l #>> '{amount,amountMinor}')::bigint) AS debt
          FROM trips, jsonb_array_elements(CASE WHEN jsonb_typeof(fare_lines) = 'array' THEN fare_lines ELSE '[]'::jsonb END) l
         WHERE l->>'code' = 'outstanding_fee'
         GROUP BY trip_id) d
 WHERE d.trip_id = t.trip_id
   AND t.commission_minor IS DISTINCT FROM t.fare_minor - d.debt - coalesce(t.driver_earnings_minor, 0) - coalesce(t.pickup_pay_minor, 0) - coalesce(t.driver_bonus_minor, 0);
