# Phase 2 — CI hardening (movera-server)

Branch `audit/phase-2` (PR #17), based on `origin/main` 5e6edc7. Local machine: cloud container, 4 CPUs, Postgres 16. Date 2026-10-26.

## Done

### 1. Reliable test suite
- `vitest.config.ts`: `hookTimeout: 60_000`.
- `test/db/tripLog.test.ts`: after-commit `sleep(100)` replaced by `waitUntil` polling (20 ms, up to 10 s).
- `test/dispatch/review.test.ts` M2: per-test timeout 120 s (body unchanged).
- `test/realtime/streams.test.ts` "closing the server ends open streams": waits for response headers instead of `sleep(100)`. This was a fifth flaky test: it timed out once in a coverage run.
- Evidence: `npx vitest run` ×3 → 568/568, 40/40 files, exit 0; 66 s, 137 s, 155 s.

### 2. CI workflow (`.github/workflows/ci.yml`)
- permissions `contents: read`; concurrency `ci-<workflow>-<ref>`, cancel-in-progress; `timeout-minutes` 20 (checks) / 10 (secret-scan); `setup-node` npm cache; `npm ci`.
- Steps: contract:verify → typecheck → lint → `npm run audit:prod` (`npm audit --omit=dev --audit-level=high`) → `npm run test:coverage` (Postgres service) → upload artifact `coverage` (always) → build.
- Job `secret-scan`: `gitleaks/gitleaks-action@v2`, full history.
- ESLint: no config existed. Added `eslint.config.js` (eslint 9, @eslint/js recommended, typescript-eslint recommended). There were 18 findings, all in `test/`. Unused imports and vars were removed, and setup calls with side effects were kept. 7 `no-explicit-any` lines each got a per-line disable with a reason. `src/` had 0 findings.
- Prettier: not used in the repo (no config, no script), so it was skipped.
- Coverage floors (`vitest.config.ts`): aggregate per glob, measured with vitest 5.0.5 / coverage-v8, rounded down to a whole percent (lines/statements/branches/functions):
  rules 97/95/92/100 (measured 97.27/95.07/92.07/100), trips 98/94/78/96 (98.11/94.06/78.37/96.77), dispatch 95/90/76/96 (95.34/90.65/76.35/96.00), auth 95/92/80/98 (95.19/92.24/80.78/98.46).
  These numbers differ from the baseline §5 numbers (vitest 3 v8 counting) because of how the provider counts, not because tests changed.
- Evidence: `npx eslint .` clean; `npm run test:coverage` ×2 → 568/568, thresholds met, exit 0 (150 s, 102 s).

### 3. Dependency advisories
- vitest 3.2.7 → 5.0.5 (+ @vitest/coverage-v8 5.0.5): tinypool/@vitest/mocker advisories gone.
- zod 3.25.76 → 4.6.7 (GHSA-mrhx-c7xc-m3w5). One type-only change, in `src/admin/peopleRoutes.ts` `param`. Error `code`/`reason` are unchanged; the free-text `message` of 400 invalid_body may be worded differently (contract: plain string).
- Evidence: `npm audit` → "found 0 vulnerabilities"; full suite with zod 4 run twice → 568/568 (126 s, 130 s). An earlier zod 4 run had 3 failing files. The same files then passed when run alone, and a vitest-5-only run at about the same time failed with "template database does not exist" (possibly another process using the shared local Postgres; not confirmed). I treat that run as environmental.

### 4. S4 cleanups
- Removed unused `fastify-plugin` dependency (no imports in src/test/tools).
- `keyOf`/`ID` dedup: implemented, then **reverted**. It removes covered lines, so trips statements fell to 93.99 % and dispatch functions to 95.95 %, under the floors. Lowering the floors is not allowed. Left for a later phase, together with resetting the floors.

## Required check names (for branch protection — owner decision D1, not changed)
- `checks`
- `secret-scan`

## Not done
- Branch protection / required checks: not changed (D1, owner).
- `keyOf`/`ID` dedup (see 4).
- Other S4 items (two sweeps, two haversines, dead exports, unbounded maps): out of scope.
