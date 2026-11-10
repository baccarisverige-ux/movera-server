-- movera: no-transaction
-- v0.18.56 §78 (G9 part 2, owner Q79–Q85 2026-11-10): chat & calls on the server.
-- Message.quickReplyId and Message.auto (arrived | on_my_way) on the stored chat message.
ALTER TABLE trip_messages ADD COLUMN IF NOT EXISTS quick_reply_id text;
ALTER TABLE trip_messages ADD COLUMN IF NOT EXISTS auto text;
-- One automatic message of each kind per trip (chat.autoArrived.when, chat.onTheWay.when): the backstop of the
-- check made under the trip lock.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS trip_messages_one_auto ON trip_messages (trip_id, auto) WHERE auto IS NOT NULL;
-- Rate limit (chat.settings.spamPerMin): messages of one sender on one trip in the last minute.
CREATE INDEX CONCURRENTLY IF NOT EXISTS trip_messages_sender_recent ON trip_messages (trip_id, sender_id, created_at);
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
-- DROP INDEX CONCURRENTLY IF EXISTS trip_messages_sender_recent;
-- DROP INDEX CONCURRENTLY IF EXISTS trip_messages_one_auto;
-- ALTER TABLE trip_messages DROP COLUMN IF EXISTS auto;
-- ALTER TABLE trip_messages DROP COLUMN IF EXISTS quick_reply_id;
