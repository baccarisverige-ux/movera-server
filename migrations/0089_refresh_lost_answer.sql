-- v0.18.49 §71 (owner Q6 "Accept lost answer", contract.json#auth.tokens.lostAnswer): when an old refresh token was
-- accepted once more after the 60 s retry window (its replacement never used). Null = never; a second late use ends
-- the session. No backfill: every existing token starts with its one late chance.
ALTER TABLE refresh_tokens ADD COLUMN late_retry_at timestamptz;
