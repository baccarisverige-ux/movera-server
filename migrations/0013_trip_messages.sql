-- movera-server migration 0013: the trip chat (contract Message, GET and POST /trips/{tripId}/messages; realtime
-- kind message, §4).

-- One row per chat message on a trip: the rider's, the driver's, or support's (an admin writing in the panel).
-- The same Message goes out as a trip event of kind message; sequence is that event's, taken under the trip
-- lock, so it orders the chat strictly and is the list's cursor. created_at is the Message's `at`.
CREATE TABLE trip_messages (
  message_id  text PRIMARY KEY CHECK (message_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  trip_id     text NOT NULL REFERENCES trips (trip_id),
  sequence    bigint NOT NULL CHECK (sequence >= 1),
  sender      text NOT NULL CHECK (sender IN ('rider', 'driver', 'support')),
  sender_id   text NOT NULL,
  text        text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 2000),
  created_at  timestamptz NOT NULL,
  UNIQUE (trip_id, sequence)
);
CREATE INDEX trip_messages_trip_created ON trip_messages (trip_id, created_at);
