-- movera: no-transaction
-- S04/S05 audit A10 (audits/global-plan-2026-11-08/AUDIT-S05.md): the hourly offer-push purge (dispatch/offerPush.ts
-- purgeOfferPushes: kind = new offer, bell = false, push_until < cutoff OR (push_until IS NULL AND created_at < cutoff))
-- had no matching index and read the whole notifications table every hour. Rule 46: built CONCURRENTLY (no table lock).
CREATE INDEX CONCURRENTLY IF NOT EXISTS notifications_offer_push_purge ON notifications (kind, push_until, created_at) WHERE bell = false;

-- undo:
-- DROP INDEX CONCURRENTLY IF EXISTS notifications_offer_push_purge;
