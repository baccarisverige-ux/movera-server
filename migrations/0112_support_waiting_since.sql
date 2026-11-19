-- movera: no-transaction
-- v0.18.112 BQ-A04 (contract.json#supportDesk.inboxOrder; owner item 109 "Yes, pages + oldest first (Rec.)", Rules
-- decisions/session-2026-11-06.md:1116): the support inbox lists the oldest-waiting ticket first.
-- support_tickets.waiting_since = while the ticket is open, the time of the first rider / driver message that has no
-- support answer after it (ticket_messages.n gives the order); NULL otherwise. src/support/tickets.ts refreshWaiting()
-- keeps it after every message and status change; the UPDATE below fills it once for the tickets that exist.
-- Rule 46: a nullable column with no default rewrites no row (the ALTER's lock is held only for the catalog change);
-- the UPDATE touches only open tickets (row locks, no table lock); the partial index is built CONCURRENTLY.
-- Not atomic (no-transaction file): every statement is safe to run again (IF NOT EXISTS, the UPDATE recomputes).
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS waiting_since timestamptz;
UPDATE support_tickets t SET waiting_since = (
  SELECT min(m.at) FROM ticket_messages m
  WHERE m.ticket_id = t.ticket_id AND m.sender <> 'support'
    AND m.n > coalesce((SELECT max(s.n) FROM ticket_messages s WHERE s.ticket_id = t.ticket_id AND s.sender = 'support'), 0)
) WHERE t.status = 'open';
CREATE INDEX CONCURRENTLY IF NOT EXISTS support_tickets_waiting ON support_tickets (waiting_since, ticket_id) WHERE waiting_since IS NOT NULL;
-- undo:
-- DROP INDEX CONCURRENTLY IF EXISTS support_tickets_waiting;
-- ALTER TABLE support_tickets DROP COLUMN IF EXISTS waiting_since;
