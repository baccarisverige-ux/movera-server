-- Build-all A1 "Support desk" (contract v0.18.15 §37, contract.json#supportDesk; owner 2026-11-02
-- decisions/other-support-promos.md QO-1 / QO-2 / QO-4 / QO-5 + rule 16).
-- Who works on a ticket (claim / assign), who solved it, the safety case opened from it, the first support answer.
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS assigned_admin_id text REFERENCES admins (admin_id);
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS claimed_until timestamptz;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS solved_by text;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS solved_at timestamptz;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS incident_id text REFERENCES incidents (incident_id);
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS first_reply_at timestamptz;
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
