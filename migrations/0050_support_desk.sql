-- Build-all A1 "Support desk" (contract v0.18.15 §37, contract.json#supportDesk; owner 2026-11-02
-- decisions/other-support-promos.md QO-1 / QO-2 / QO-4 / QO-5 + rule 16).
-- Who works on a ticket (claim / assign), who solved it, the safety case opened from it, the first support answer.
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS assigned_admin_id text REFERENCES admins (admin_id);
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS solved_by text;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS solved_at timestamptz;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS incident_id text REFERENCES incidents (incident_id);
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS first_reply_at timestamptz;
-- Owner "Not rating only comment suggestions": the person's optional comment after the ticket was solved.
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS feedback_text text;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS feedback_at timestamptz;
UPDATE support_tickets t SET first_reply_at = m.at
  FROM (SELECT ticket_id, min(at) AS at FROM ticket_messages WHERE sender = 'support' GROUP BY ticket_id) m
  WHERE m.ticket_id = t.ticket_id AND t.first_reply_at IS NULL;
CREATE INDEX IF NOT EXISTS support_tickets_assigned ON support_tickets (assigned_admin_id, updated_at DESC);

-- Admin › Support › Settings per country (never saved = contract.json#supportDesk.settings.defaults).
CREATE TABLE IF NOT EXISTS support_settings (
  country     text PRIMARY KEY CHECK (country ~ '^[A-Z]{2}$'),
  doc         jsonb NOT NULL,
  updated_at  timestamptz NOT NULL,
  updated_by  text
);

-- Alerts full flow (contract v0.18.15 §38, contract.json#alertDesk; owner 2026-11-02 Q5 "FULL FLOW"): who works on
-- each alert and its history, the shared mutes / settings / rules, and every admin's own quiet hours.
-- Settings, rules and mutes per country (SE, FR, TN): a mute or a rule in one country never touches another.
CREATE TABLE IF NOT EXISTS admin_alert_book (
  country     text PRIMARY KEY CHECK (country ~ '^[A-Z]{2}$'),
  rev         integer NOT NULL DEFAULT 1,
  settings    jsonb NOT NULL DEFAULT '{}'::jsonb,
  rules       jsonb NOT NULL DEFAULT '[]'::jsonb,
  mutes       jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS admin_alert_records (
  alert_id      text PRIMARY KEY,
  kind          text NOT NULL,
  level         text NOT NULL CHECK (level IN ('critical', 'important', 'info')),
  title         text NOT NULL,
  zone_id       text,
  since         timestamptz NOT NULL,
  -- new = nobody acted yet (the row exists so two admins taking at once queue on its lock).
  status        text NOT NULL CHECK (status IN ('new', 'taken', 'done', 'snoozed')),
  owner         text REFERENCES admins (admin_id),
  snooze_until  timestamptz,
  events        jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at    timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_alert_records_recent ON admin_alert_records (updated_at DESC);
CREATE TABLE IF NOT EXISTS admin_alert_quiet (
  admin_id   text PRIMARY KEY REFERENCES admins (admin_id),
  quiet_on   boolean NOT NULL,
  from_hm    text NOT NULL,
  to_hm      text NOT NULL,
  updated_at timestamptz NOT NULL
);

-- Incidents settings (contract v0.18.15, contract.json#incidentDesk): the panel's incident settings document.
CREATE TABLE IF NOT EXISTS admin_incident_settings (
  country     text PRIMARY KEY CHECK (country ~ '^[A-Z]{2}$'),
  rev         integer NOT NULL DEFAULT 1,
  settings    jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz,
  updated_by  text
);

-- Review rules (contract v0.18.15 §40, contract.json#reviewRules; owner G14 Q6 "Make them real").
CREATE TABLE IF NOT EXISTS review_rules (
  country     text PRIMARY KEY CHECK (country ~ '^[A-Z]{2}$'),
  doc         jsonb NOT NULL,
  updated_at  timestamptz NOT NULL,
  updated_by  text
);
-- Where each rated person stands against the lines (one action per crossing) and the admin review list.
CREATE TABLE IF NOT EXISTS review_people (
  who         text NOT NULL CHECK (who IN ('driver', 'rider')),
  person_id   text NOT NULL,
  country     text,
  level       text NOT NULL CHECK (level IN ('warn', 'review', 'block')),
  average     numeric(4, 2) NOT NULL,
  count       integer NOT NULL,
  since       timestamptz NOT NULL,
  queued      boolean NOT NULL DEFAULT false,
  PRIMARY KEY (who, person_id)
);
