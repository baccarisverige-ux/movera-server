-- v0.18.33 (owner Q-Bj 2026-11-05 "Never auto-close", contract.json#alertsOldList): an SOS / safety alert is never
-- closed by the server; 24 h after its trip ended it stays open and moves to the admin's Old list (old_since set).
-- 0069–0072 are taken by open PRs #87 / #88 and jobs 4 / 5; migrate.ts applies missing files by sorted name.
ALTER TABLE admin_alerts_live ADD COLUMN old_since timestamptz;
