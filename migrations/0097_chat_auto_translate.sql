-- v0.18.64 §85 (owner 2026-11-11 "the language must arrive with the receiver language and the translate when click on
-- it must open original language"): chat messages arrive translated into the reader's language.
-- Message.lang: the language the text was written in (exact for quick replies and automatic messages, the sender's
-- app language for typed text). A nullable column with no default: no table rewrite (Rule 46).
ALTER TABLE trip_messages ADD COLUMN IF NOT EXISTS lang text;
-- One kept translation per message and target language (chat.autoTranslate.cache): every later request (another device,
-- a reopen, a retry, another server copy) answers the kept text. No foreign key to trip_messages (that would lock it
-- while the app runs); the daily chat purge (purgeOldMessages) deletes a message's translations with it.
CREATE TABLE IF NOT EXISTS trip_message_translations (
  message_id text NOT NULL,
  lang       text NOT NULL CHECK (lang IN ('sv', 'fr', 'en')),
  text       text NOT NULL CHECK (char_length(text) >= 1),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (message_id, lang)
);
-- undo:
-- DROP TABLE IF EXISTS trip_message_translations;
-- ALTER TABLE trip_messages DROP COLUMN IF EXISTS lang;
