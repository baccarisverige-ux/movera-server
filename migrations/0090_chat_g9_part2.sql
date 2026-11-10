-- v0.18.56 §78 (G9 part 2, owner Q79–Q85 2026-11-10): chat & calls on the server.
-- Message.quickReplyId and Message.auto (arrived | on_my_way) on the stored chat message.
ALTER TABLE trip_messages ADD COLUMN IF NOT EXISTS quick_reply_id text;
ALTER TABLE trip_messages ADD COLUMN IF NOT EXISTS auto text;
-- No new index on trip_messages (Rule 46 would need CONCURRENTLY, which deadlocks two copies starting together):
-- "one automatic message of each kind per trip" and the per-minute count (chat.settings.spamPerMin) are read under
-- the trip lock through the existing (trip_id, sequence) index; a trip has few messages.
-- inAppCalls.push (Q79): which trip streams are open right now, on any server copy (Rule 33: never in one copy's
-- memory). A stream writes its row when it opens, refreshes seen_at on each heartbeat and deletes it when it closes;
-- a row not seen for 90 s is a stream of a copy that died.
CREATE TABLE IF NOT EXISTS trip_stream_presence (
  stream_id  text PRIMARY KEY,
  trip_id    text NOT NULL,
  actor      text NOT NULL,
  subject_id text NOT NULL,
  seen_at    timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS trip_stream_presence_trip ON trip_stream_presence (trip_id, actor, subject_id);
-- undo:
-- DROP TABLE IF EXISTS trip_stream_presence;
-- ALTER TABLE trip_messages DROP COLUMN IF EXISTS auto;
-- ALTER TABLE trip_messages DROP COLUMN IF EXISTS quick_reply_id;
