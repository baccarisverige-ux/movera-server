-- v0.18.16 A2 (owner G16 Q16-1 + Q16-2 "Warn → Pause → Ban"): the rider's moderation level, its reason and, for a
-- pause, when it ends. riders.status stays the gate: paused / banned = suspended.
-- Safe to run twice. (Fix job 0, contract 0.18.39: was 0060 on the old A2 branch.)
ALTER TABLE riders ADD COLUMN IF NOT EXISTS moderation_level text NOT NULL DEFAULT 'none';
ALTER TABLE riders ADD COLUMN IF NOT EXISTS moderation_reason text;
ALTER TABLE riders ADD COLUMN IF NOT EXISTS moderation_until timestamptz;
ALTER TABLE riders ADD COLUMN IF NOT EXISTS moderation_set_at timestamptz;
DO $$ BEGIN
  ALTER TABLE riders ADD CONSTRAINT riders_moderation_level_check CHECK (moderation_level IN ('none', 'warning', 'paused', 'banned'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- A rider suspended before levels existed is banned (until an admin undoes it).
UPDATE riders SET moderation_level = 'banned' WHERE status = 'suspended' AND moderation_level = 'none';
CREATE INDEX IF NOT EXISTS riders_pause_end ON riders (moderation_until) WHERE moderation_level = 'paused';
