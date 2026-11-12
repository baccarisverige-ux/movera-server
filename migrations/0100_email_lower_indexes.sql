-- movera: no-transaction
-- G30 (contract v0.18.76, contract.json#emailVerified.unique): addresses are compared lower-cased; the "verified on
-- another account of the same app" check probes these instead of a full table scan (Rule 33). Not UNIQUE: unchecked
-- duplicates may already exist and are kept (owner Q2, Rule 21); uniqueness of VERIFIED addresses is kept by the server
-- under a per-address lock. CONCURRENTLY: no table lock (Rule 46).
CREATE INDEX CONCURRENTLY IF NOT EXISTS riders_email_lower ON riders (lower(email)) WHERE email IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS drivers_email_lower ON drivers (lower(email)) WHERE email IS NOT NULL;
-- undo:
-- DROP INDEX CONCURRENTLY IF EXISTS riders_email_lower;
-- DROP INDEX CONCURRENTLY IF EXISTS drivers_email_lower;
