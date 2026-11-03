-- v0.18.19 (contract.json#bookLater.liveFixes.ownerDefaults; owner Q5 2026-11-03 + M6-a; live test MED 4).
-- Zones whose driver document still holds the OLD built-in reservation times (never set by an admin since) get the
-- owner values: a normal ride's "be online before" 30 → 60 min, and every ride type's reminders [60, 15] → [120].
-- Any other value (an admin's own choice) is left as it is. Drafts and live documents alike.
-- A live document that changes is published as its next version, with a config_history row (note below), so the
-- admin's History shows the change and can roll it back like any other publish.
CREATE FUNCTION pg_temp.owner_defaults(d jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE k text;
BEGIN
  IF d #> '{reservations,rideTypes,normal,onlineBeforeMin}' = '30'::jsonb THEN
    d := jsonb_set(d, '{reservations,rideTypes,normal,onlineBeforeMin}', '60');
  END IF;
  FOREACH k IN ARRAY ARRAY['normal', 'airport', 'longTrip', 'comfortPremium', 'event'] LOOP
    IF d #> ARRAY['reservations', 'rideTypes', k, 'reminderMin'] = '[60, 15]'::jsonb THEN
      d := jsonb_set(d, ARRAY['reservations', 'rideTypes', k, 'reminderMin'], '[120]'::jsonb);
    END IF;
  END LOOP;
  RETURN d;
END $$;

DO $$
DECLARE r record; next_doc jsonb; next_version integer; at timestamptz := now();
BEGIN
  FOR r IN SELECT doc, zone_id, version, document FROM config_live WHERE doc = 'driver_app_config' LOOP
    next_doc := pg_temp.owner_defaults(r.document);
    CONTINUE WHEN next_doc = r.document;
    next_version := r.version + 1;
    next_doc := jsonb_set(jsonb_set(next_doc, '{version}', to_jsonb(next_version)), '{publishedAt}', to_jsonb(to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
    UPDATE config_live SET version = next_version, document = next_doc, published_at = at, published_by = 'system'
      WHERE doc = r.doc AND zone_id = r.zone_id;
    INSERT INTO config_history (doc, zone_id, version, document, published_at, published_by, approved_by, note)
      VALUES (r.doc, r.zone_id, next_version, next_doc, at, 'system', NULL,
              'Owner defaults for booked rides (v0.18.19): normal online 30 → 60 min, reminders [60, 15] → [120]');
  END LOOP;
  UPDATE config_drafts SET document = pg_temp.owner_defaults(document)
    WHERE doc = 'driver_app_config' AND document IS NOT NULL AND pg_temp.owner_defaults(document) <> document;
END $$;
