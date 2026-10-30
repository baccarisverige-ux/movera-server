-- movera-server migration 0036: push to a closed phone (contract v0.18.3 §28, owner decision R7). Every bell notice
-- is also sent as an FCM push after its command committed; pushed_at marks the notices the push dispatcher took.
-- Notices that exist before this migration count as taken, so switching push on never sends old ones.
ALTER TABLE notifications ADD COLUMN pushed_at timestamptz;
UPDATE notifications SET pushed_at = created_at;
CREATE INDEX notifications_push_waiting ON notifications (created_at) WHERE pushed_at IS NULL;
