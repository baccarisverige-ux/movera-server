-- movera: no-transaction
-- G30 (contract v0.18.76, contract.json#emailVerified): the backfill of 0099's columns, then the lower(email) indexes.
-- No-transaction (Rule 46, supervisor G30 F1): each UPDATE commits on its own and takes only ROW EXCLUSIVE on its
-- table, so reads never wait (measured: test/db/email_verified_migration.test.ts "F1"); app writes to a row being
-- backfilled wait for that one statement only. Re-runnable: every UPDATE touches only rows still NULL, so a run cut
-- off half-way is simply run again whole on the next start (migrate.ts NO_TRANSACTION_MARKER).
-- emailVerified.existing: only a current address that matches a successful code check on record stays Verified. A
-- successful POST /account/email/verify closed its challenge (expires_at = now) and stored the bell email_changed at
-- that same instant (accountChange.ts verifyEmailChange + afterChange share one `now`); a challenge closed by a newer
-- start has no such bell. The latest proof counts.
UPDATE riders r SET email_verified_at = p.at
FROM (
  SELECT c.subject_id, c.email, max(c.expires_at) AS at
  FROM email_changes c
  JOIN notifications n ON n.audience = c.actor AND n.subject_id = c.subject_id AND n.kind = 'email_changed' AND n.created_at = c.expires_at
  WHERE c.actor = 'rider'
  GROUP BY c.subject_id, c.email
) p
WHERE p.subject_id = r.rider_id AND p.email = lower(r.email) AND r.email_verified_at IS NULL;

UPDATE drivers d SET email_verified_at = p.at
FROM (
  SELECT c.subject_id, c.email, max(c.expires_at) AS at
  FROM email_changes c
  JOIN notifications n ON n.audience = c.actor AND n.subject_id = c.subject_id AND n.kind = 'email_changed' AND n.created_at = c.expires_at
  WHERE c.actor = 'driver'
  GROUP BY c.subject_id, c.email
) p
WHERE p.subject_id = d.driver_id AND p.email = lower(d.email) AND d.email_verified_at IS NULL;

-- emailVerified.neverActive (+ supervisor round 3): once active = an admin status change to OR from active, or any trip
-- he drove; the earliest such time. An active driver without either: his created_at.
UPDATE drivers d SET first_activated_at = s.at
FROM (
  SELECT driver_id, min(at) AS at FROM (
    SELECT target_id AS driver_id, at FROM admin_audit
    WHERE action = 'driver.status' AND target_type = 'driver' AND (detail->>'to' = 'active' OR detail->>'from' = 'active')
    UNION ALL
    SELECT driver_id, created_at AS at FROM trips WHERE driver_id IS NOT NULL
  ) seen
  GROUP BY driver_id
) s
WHERE s.driver_id = d.driver_id AND d.first_activated_at IS NULL;

UPDATE drivers SET first_activated_at = created_at WHERE account_status = 'active' AND first_activated_at IS NULL;

-- G30 (contract v0.18.76, contract.json#emailVerified.unique): addresses are compared lower-cased; the "verified on
-- another account of the same app" check probes these instead of a full table scan (Rule 33). Not UNIQUE: unchecked
-- duplicates may already exist and are kept (owner Q2, Rule 21); uniqueness of VERIFIED addresses is kept by the server
-- under a per-address lock. CONCURRENTLY: no table lock (Rule 46).
CREATE INDEX CONCURRENTLY IF NOT EXISTS riders_email_lower ON riders (lower(email)) WHERE email IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS drivers_email_lower ON drivers (lower(email)) WHERE email IS NOT NULL;
-- undo:
-- (the backfilled values go with 0099's undo, which drops the columns; the UPDATEs need no undo of their own)
-- DROP INDEX CONCURRENTLY IF EXISTS riders_email_lower;
-- DROP INDEX CONCURRENTLY IF EXISTS drivers_email_lower;
