-- G30 (contract v0.18.76, contract.json#emailVerified; owner 2026-11-12 Q2 "Keep, show Not verified", Q6 and S3):
-- when the CURRENT e-mail was proven (riders / drivers.email_verified_at), and when a driver first became active
-- (drivers.first_activated_at, server-internal, never sent). Nullable columns without a default: no table rewrite.
-- Nothing is deleted and no e-mail is changed (Rule 21).
ALTER TABLE riders ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS first_activated_at timestamptz;
-- emailVerified.writePaths.provider (owner Q4): Apple / Google said it checked the e-mail (constant default: no rewrite).
ALTER TABLE auth_link_tokens ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT false;

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

-- undo:
-- ALTER TABLE riders DROP COLUMN IF EXISTS email_verified_at;
-- ALTER TABLE drivers DROP COLUMN IF EXISTS email_verified_at;
-- ALTER TABLE drivers DROP COLUMN IF EXISTS first_activated_at;
-- ALTER TABLE auth_link_tokens DROP COLUMN IF EXISTS email_verified;
