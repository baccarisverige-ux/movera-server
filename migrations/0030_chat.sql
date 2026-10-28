-- movera-server migration 0030: trip chat retention (contract v0.13.0 §22, owner 2026-10-28). The nightly job
-- deletes chat messages older than 90 days, except those of a trip with a safety case; these indexes keep it cheap.
-- (0029 is taken by the safety part 2 branch.)
CREATE INDEX IF NOT EXISTS trip_messages_created_at_idx ON trip_messages (created_at);
CREATE INDEX IF NOT EXISTS incidents_trip_id_idx ON incidents (trip_id) WHERE trip_id IS NOT NULL;
