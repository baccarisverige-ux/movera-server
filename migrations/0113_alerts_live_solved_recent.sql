-- movera: no-transaction
-- S7 alert cap (Rules plan/S7-RECHECK-2026-11-15.md row 1, audits/impact/alert-cap-safety.md). The admin alert book
-- (src/admin/alerts.ts liveAlerts) now reads every open alert and, of the solved (green) ones, only the newest per kind.
-- Solved alerts stay until an admin marks them done and auto_offline makes one per offline event, so the solved rows
-- have no upper bound; with only (country, state) from 0066 each read (every 15 s per open admin tab) would walk and
-- sort every solved row of the country. This index gives them newest first per country and kind, so the read stops
-- after the cap. Rule 46: built CONCURRENTLY, no table lock; partial (only solved rows). Safe to run again.
CREATE INDEX CONCURRENTLY IF NOT EXISTS admin_alerts_live_solved_recent ON admin_alerts_live (country, kind, solved_at DESC NULLS LAST) WHERE state = 'solved';
-- undo:
-- DROP INDEX CONCURRENTLY IF EXISTS admin_alerts_live_solved_recent;
