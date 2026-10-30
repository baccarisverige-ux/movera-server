-- movera-server migration 0039: driver group 4, incoming offer and exclusive offer (contract v0.18.6 §31, owner decisions
-- 1-7 of 2026-10-29 and G4-E1..E7 of 2026-10-30 in Rules decisions/driver-g4.md). Safe to run twice.

-- G4-E2 "Set 10 everywhere": every published driver document whose auto-offline limit is not 10 (Z001 and FR-PC were
-- published with 3 on 25 Oct) gets 10, as its next version with a history line, in every country (SE and FR). Drafts get
-- it too (their version + 1) so a later publish from the panel does not bring the old limit back. The admin can still
-- change it per zone afterwards. Documents without the field already use the contract default (10).
WITH changed AS (
  UPDATE config_live SET
    version = version + 1,
    published_at = now(),
    published_by = NULL,
    document = jsonb_set(jsonb_set(document, '{offers,autoOffline,missedExclusive}', '10'::jsonb), '{version}', to_jsonb(version + 1))
               || jsonb_build_object('publishedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  WHERE doc = 'driver_app_config'
    AND jsonb_typeof(document #> '{offers,autoOffline,missedExclusive}') IS NOT NULL
    AND document #> '{offers,autoOffline,missedExclusive}' <> '10'::jsonb
  RETURNING doc, zone_id, version, document, published_at
)
INSERT INTO config_history (doc, zone_id, version, document, published_at, published_by, approved_by, note)
SELECT doc, zone_id, version, document, published_at, NULL, NULL, 'G4-E2: auto-offline limit set to 10 in every zone (owner "Set 10 everywhere", migration 0039)'
FROM changed
ON CONFLICT (doc, zone_id, version) DO NOTHING;

UPDATE config_drafts SET
  version = version + 1,
  updated_at = now(),
  document = jsonb_set(document, '{offers,autoOffline,missedExclusive}', '10'::jsonb)
WHERE doc = 'driver_app_config'
  AND jsonb_typeof(document #> '{offers,autoOffline,missedExclusive}') IS NOT NULL
  AND document #> '{offers,autoOffline,missedExclusive}' <> '10'::jsonb;

-- Decision 3: the rider's rating as it was when the offer was sent (Offer.riderRating); NULL = none (no rating yet, or
-- the zone's DriverAppConfig.offers.offerCard.riderRating is false). Never a made-up value.
ALTER TABLE offers ADD COLUMN IF NOT EXISTS rider_rating double precision CHECK (rider_rating IS NULL OR (rider_rating >= 0 AND rider_rating <= 5));

-- Decision 1 + E6: the new-offer push is sent through the push outbox (notifications, pushed_at) but is not a bell
-- notice: bell = false keeps it out of GET /notifications, the unread count and mark-read. push_until: not sent after
-- the offer's expiresAt.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS bell boolean NOT NULL DEFAULT true;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS push_until timestamptz;
