-- v0.18.48 §70 (owner French wording, 2026-11-07): the Electric seed line follows contract.json#categoryCatalog.seedLines.
-- Only a line still at the old seed text changes; a line an admin already edited stays as it is.
UPDATE categories
SET line = jsonb_set(line, '{fr}', to_jsonb('Véhicule 100 % électrique'::text)), updated_at = now()
WHERE category_id = 'electric' AND line->>'fr' = 'Voiture 100 % électrique';
