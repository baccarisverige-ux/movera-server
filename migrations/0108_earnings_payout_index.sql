-- movera: no-transaction
-- v0.18.92 BQ-M22 (contract.json#priceDisplay.payoutSummary.entries; supervisor MF1, Rules
-- audits/impact/server-m24-m22-supervisor.md): Payout.summary reads the payout's OWN entries (earnings_entries.payout_id),
-- one batched read per payout page. No index started with payout_id (0009 / 0025 are (driver_id, at)), so the read
-- would walk the table. Rule 46: built CONCURRENTLY, no table lock; partial (only paid-out entries carry a payout_id).
-- Safe to run again (IF NOT EXISTS).
CREATE INDEX CONCURRENTLY IF NOT EXISTS earnings_payout ON earnings_entries (payout_id) WHERE payout_id IS NOT NULL;
-- undo:
-- DROP INDEX CONCURRENTLY IF EXISTS earnings_payout;
