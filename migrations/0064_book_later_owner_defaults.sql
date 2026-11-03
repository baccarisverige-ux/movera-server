-- v0.18.19 (contract.json#bookLater.liveFixes.ownerDefaults; owner Q5 2026-11-03 + M6-a; live test MED 4).
-- Zones whose driver document still holds the OLD built-in reservation times (never set by an admin since) get the
-- owner values: a normal ride's "be online before" 30 → 60 min, and every ride type's reminders [60, 15] → [120].
-- Any other value (an admin's own choice) is left as it is. Drafts and live documents alike.
UPDATE config_live SET document = jsonb_set(document, '{reservations,rideTypes,normal,onlineBeforeMin}', '60')
  WHERE doc = 'driver_app_config' AND document #> '{reservations,rideTypes,normal,onlineBeforeMin}' = '30'::jsonb;
UPDATE config_drafts SET document = jsonb_set(document, '{reservations,rideTypes,normal,onlineBeforeMin}', '60')
  WHERE doc = 'driver_app_config' AND document #> '{reservations,rideTypes,normal,onlineBeforeMin}' = '30'::jsonb;
DO $$
DECLARE k text;
BEGIN
  FOREACH k IN ARRAY ARRAY['normal', 'airport', 'longTrip', 'comfortPremium', 'event'] LOOP
    UPDATE config_live SET document = jsonb_set(document, ARRAY['reservations', 'rideTypes', k, 'reminderMin'], '[120]'::jsonb)
      WHERE doc = 'driver_app_config' AND document #> ARRAY['reservations', 'rideTypes', k, 'reminderMin'] = '[60, 15]'::jsonb;
    UPDATE config_drafts SET document = jsonb_set(document, ARRAY['reservations', 'rideTypes', k, 'reminderMin'], '[120]'::jsonb)
      WHERE doc = 'driver_app_config' AND document #> ARRAY['reservations', 'rideTypes', k, 'reminderMin'] = '[60, 15]'::jsonb;
  END LOOP;
END $$;
