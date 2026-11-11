-- S07 audit M12 / E16 (audits/global-plan-2026-11-08/AUDIT-S07.md): rider_wallets (0070) had no "never below 0" rule;
-- the old riders.wallet_minor had CHECK (>= 0) (0010). No path can write a negative balance: 0070 copied only
-- riders.wallet_minor (itself CHECK >= 0), credits are positive, and the one spend (ride/money.ts spendWallet) takes at
-- most the locked balance; moveWallet now writes spends as a guarded UPDATE. Rule 46: NOT VALID, then VALIDATE.
ALTER TABLE rider_wallets ADD CONSTRAINT rider_wallets_balance_nonneg CHECK (balance_minor >= 0) NOT VALID;
ALTER TABLE rider_wallets VALIDATE CONSTRAINT rider_wallets_balance_nonneg;

-- undo:
-- ALTER TABLE rider_wallets DROP CONSTRAINT IF EXISTS rider_wallets_balance_nonneg;
