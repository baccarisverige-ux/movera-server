# Audit Phase 3 — ride lifecycle, server part (simulation harness)

Branch `audit/phase-3`. Plan: `movera-contracts/docs/audit/AUDIT_PLAN.md` (Phase 3).

## The harness

`test/e2e/harness.ts` starts one real server per test file: `buildApp` on a local port, its own fresh Postgres
database (cloned from the migrated template, like every other test), the LISTEN/NOTIFY hub, and the start-up
preparation of the staging server (`prepareTestWeek`: the test fleet MV-TESTA with its three drivers and cars, the
three test riders, the sample settings in every open zone, the bootstrap Super admin and its password link). Riders,
drivers and admins use only HTTP (`fetch`) and Server-Sent Events (`/trips/{id}/events`, `/driver/offers/stream`),
with the headers the apps send (Bearer token, `Idempotency-Key`, `Last-Event-ID`), and refresh an expired access
token like the apps. The server's clock is injected; `sim.advance(s)` moves it and runs the durable timers that
came due (offer expiry, search steps, search end, no-show windows), as the timer worker would. `fakeOsrm()` is a
local HTTP stand-in for Movera's OSRM that can also be switched off.

The e2e files are under `test/e2e/*.test.ts`, so `npm test` / `npm run test:coverage` in CI runs them.

## Done

| # | Scenario | File | Result |
|---|---|---|---|
| 1 | Sign-in rider / driver / admin, expired access token, refresh reuse (and the lost-answer retry) | `01_signin.test.ts` | passes |
| 2 | Quote, category, pickup / destination validation, quote mismatch / expiry / reuse, route with fake OSRM, OSRM down, no OSRM | `02_quotes.test.ts` | passes |
| 3 | Request → offer (exclusive, over the offer feed) → accept → arrive → board → start → complete; fare, earnings, Movera share and the earnings report against `fixtures/fares.json` `economy_plain`; the three views agree | `03_ride.test.ts` | passes |

## Not done yet

Scenarios 4–11 and the Phase 1 findings (in progress).

## Findings

None yet.

## Observations (not defects by the contract)

- **Destination is not limited.** Only the pickup must be in an open zone (`service_not_available`); the contract
  says nothing about the drop-off, so a drop-off outside every zone is quoted. Owner question if that matters.
- **Refresh retry window.** Sending the same refresh token again within 60 s while its replacement was never used is
  treated as a lost answer (a new pair is issued, the unused replacement dropped), not as theft. After the window,
  or once the replacement was used, it is theft and the whole session ends (`refresh_token_reused`).
