-- movera-server migration 0012: fleet invitations, in-app notifications, the SMS outbox and Apple / Google links
-- (contract v0.5.3 §8 and §14, contract.json#driverOnboarding.fleetInvitations; owner decisions of 2026-10-25).

-- Joining a fleet is two-sided: a driver_request (the driver asked with the code, the owner's name and e-mail) or an
-- owner_invite (the owner invited a phone number; driver_id is filled the moment that number signs up).
CREATE TABLE fleet_invitations (
  invitation_id  text PRIMARY KEY CHECK (invitation_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  fleet_id       text NOT NULL REFERENCES fleets (fleet_id),
  direction      text NOT NULL CHECK (direction IN ('driver_request', 'owner_invite')),
  driver_id      text REFERENCES drivers (driver_id),
  phone          text CHECK (phone ~ '^\+[1-9][0-9]{6,14}$'),
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled', 'expired')),
  decided_at     timestamptz,
  decided_by     text,
  expires_at     timestamptz NOT NULL,
  version        integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (driver_id IS NOT NULL OR phone IS NOT NULL)
);
CREATE INDEX fleet_invitations_fleet ON fleet_invitations (fleet_id, status);
CREATE INDEX fleet_invitations_driver ON fleet_invitations (driver_id, status);
CREATE INDEX fleet_invitations_phone ON fleet_invitations (phone) WHERE status = 'pending';

-- In-app notifications (contract Notification; GET /notifications). data carries what the app needs to open the
-- right screen (an invitationId, a tripId).
CREATE TABLE notifications (
  notification_id  text PRIMARY KEY CHECK (notification_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  audience         text NOT NULL CHECK (audience IN ('rider', 'driver')),
  subject_id       text NOT NULL,
  kind             text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]{0,63}$'),
  title            text NOT NULL,
  body             text NOT NULL,
  deep_link        text,
  trip_id          text,
  data             jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_subject ON notifications (audience, subject_id, created_at DESC, notification_id DESC);

-- Every SMS the server wants sent, whatever provider does it. Without a provider (the test week until the owner
-- picks one) a message is written here as skipped, so nothing is lost and the admin can see it.
CREATE TABLE sms_outbox (
  sms_id       text PRIMARY KEY CHECK (sms_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  phone        text NOT NULL,
  text         text NOT NULL,
  kind         text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]{0,63}$'),
  status       text NOT NULL CHECK (status IN ('queued', 'sent', 'failed', 'skipped')),
  provider     text,
  provider_ref text,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  sent_at      timestamptz
);
CREATE INDEX sms_outbox_created ON sms_outbox (created_at DESC);

-- An Apple / Google identity linked to an account (contract §8). The same identity may hold a rider and a driver
-- account (two apps), so the actor is part of the key.
CREATE TABLE auth_provider_links (
  provider          text NOT NULL CHECK (provider IN ('apple', 'google')),
  provider_subject  text NOT NULL,
  actor             text NOT NULL CHECK (actor IN ('rider', 'driver')),
  subject_id        text NOT NULL,
  email             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, provider_subject, actor)
);
CREATE INDEX auth_provider_links_subject ON auth_provider_links (actor, subject_id);

-- PHONE_REQUIRED: the link token the app carries from the provider sign-in to the phone verification.
CREATE TABLE auth_link_tokens (
  token_sha256      text PRIMARY KEY,
  provider          text NOT NULL CHECK (provider IN ('apple', 'google')),
  provider_subject  text NOT NULL,
  app               text NOT NULL CHECK (app IN ('rider', 'driver')),
  first_name        text,
  last_name         text,
  email             text,
  expires_at        timestamptz NOT NULL,
  used_at           timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
