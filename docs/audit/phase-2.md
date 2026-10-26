# Phase 2 — CI hardening (movera-server)

Branch `audit/phase-2`, based on `origin/main` 5e6edc7. Machine: cloud container, 4 CPUs, local Postgres 16.

## Done

### 1. Reliable test suite
- `vitest.config.ts`: `hookTimeout: 60_000` (afterAll teardown exceeded the 10 s default).
- `test/db/tripLog.test.ts`: fixed `sleep(100)` waits for NOTIFY after commit replaced by `waitUntil` polling (20 ms, up to 10 s). The negative checks (no notification before commit / after rollback) keep their wait and are now followed by a positive poll, so the rollback test asserts that only the committed event was notified.
- `test/dispatch/review.test.ts` M2: per-test timeout 120 s (≈94 simulated steps × 3 HTTP posts; test body unchanged).
- Evidence (2026-10-26): `npx vitest run` ×3 → 568/568, 40/40 files each; exit 0; 66 s, 137 s, 155 s.

## Not done yet
- CI workflow, ESLint, coverage floors, npm audit, secret scan, vitest upgrade, S4 cleanups.
