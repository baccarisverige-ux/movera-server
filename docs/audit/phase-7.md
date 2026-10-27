# Audit Phase 7 (server): performance, measured

Date: 2026-10-27. Branch `audit/phase-7`. Plan: `movera-contracts/docs/audit/AUDIT_PLAN.md`, Phase 7. The apps' numbers are in each app's `docs/audit/phase-7.md`.

## Method

- **Response times:** the e2e harness (`test/e2e/harness.ts`, a real server on Postgres 16) now records every response's route, status and Fastify `elapsedTime` (`sim.timings`; `E2E_TIMING_OUT=<file>` also writes them as JSON lines). Whole e2e suite (14 files, 70 tests): `E2E_TIMING_OUT=t.jsonl npx vitest run test/e2e`.
- **Queries:** `pg_stat_statements` (track = all) over the same run, then `EXPLAIN` on every distinct SELECT/UPDATE/DELETE with `enable_seqscan = off`, and `EXPLAIN ANALYZE` on 300,000 synthetic rows for the one without a usable index.
- Audit container: 4 cores, local Postgres 16, no other load. Absolute times on Render will be higher; the shape is what counts.

## Measured

**HTTP**, 2,557 responses: p50 4.8 ms, p95 28.7 ms, p99 61.3 ms. Slowest routes by p95 (long-lived SSE streams left out):

| Route | n | p50 | p95 | max |
|---|---:|---:|---:|---:|
| POST /admin/auth/sign-in (argon2 on purpose) | 28 | 40.1 | 165.2 | 255.4 |
| POST /admin/auth/setup-password (argon2) | 27 | 35.7 | 83.0 | 100.1 |
| POST /trips | 63 | 25.7 | 72.4 | 112.2 |
| POST /offers/{id}/accept | 47 | 20.4 | 48.7 | 62.5 |
| POST /driver/availability | 45 | 13.6 | 43.8 | 57.6 |
| POST /quotes | 67 | 10.3 | 34.1 | 71.6 |
| POST /trips/{id}/cancel | 58 | 9.4 | 30.6 | 34.8 |
| GET /driver/profile | 96 | 6.7 | 21.5 | 30.9 |

One whole ride (book → offer → accept → arrive → board → start → complete, new `15_timing.test.ts`), 3 runs: 54 requests each time (the driver app's 30 s position updates included), p95 19.5–20.9 ms, slowest 44–47 ms.

**Queries:** every statement averaged under 1 ms on the test data; the most called were the timer poll (3,128 calls), the session check (1,903) and the driver's live-trip lookup (838). Of 224 distinct statements, the planner had no index for: `zones` bounding box (a few dozen rows, fine), `vehicles` by plate and `rider_fees` by status (false alarms: they use their expression/partial index once the values are bound, which node-pg does), a few admin/test lookups, and **`earnings_entries` by `trip_id`**.

**Live apps** (see the apps' reports): rider trip screens 36 requests a minute after the rider fix (54 before), driver 0 a minute besides its event streams.

## Findings

| Id | Sev | Finding | Fix | Test / evidence |
|---|---|---|---|---|
| P7-S1 | S4 | `earnings_entries` had no index that starts with `trip_id`. The admin bonus check (`bonusSoFar` in `src/admin/trips.ts`, run whenever an admin gives a driver bonus: assign, radar group, bonus, or a cancel or reassign that pays the lost driver) summed a trip's entries by reading the whole table, or the whole `(driver_id, trip_id, kind)` index. On 300,000 rows: 17.1 ms (parallel seq scan) or 14.2 ms (full index walk). | Migration `0020_earnings_trip_index.sql`: `CREATE INDEX earnings_trip ON earnings_entries (trip_id, kind)`. Same query: 0.085 ms. | `test/db/query_plans.test.ts` ("trip bonus paid") fails before, passes after. |

No slow endpoint: everything except the deliberately slow password hashing answered in under 115 ms in the suite.

## Budgets added (CI, run by `npm run test:coverage`)

- `test/db/query_plans.test.ts`: 22 hot queries (the most called in the harness run plus the bonus sum) must use an index with a condition on its first column (no `Seq Scan`, no full-index walk), with `enable_seqscan = off` and a realistic earnings table.
- `test/e2e/15_timing.test.ts`: one whole ride needs at most 60 requests (measured 54), no response over 1,000 ms, p95 under 250 ms (measured about 20 ms). The margins are for slow CI runners; a query per row, a missing index under load or a polling loop still trips them.

## Gates

`npm run typecheck`, `npm run lint`, `npm run test:coverage`: 58 files, 671 tests, lines 94.54 %, statements 89.88 %, coverage floors unchanged.
