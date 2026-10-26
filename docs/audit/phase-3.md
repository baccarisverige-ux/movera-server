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
| 4 | Rider cancel while searching / offered (offer withdrawn on the feed) / accepted inside and after the free 2 min / arrived / on board (refused); driver cancel before boarding (back to dispatch, other driver takes it) and on board (pays what was driven); no-show refused before 5 min, then 65 kr owed and 80 % to the driver | `04_cancel.test.ts` | passes |
| 5 | Decline → next driver; exclusive offer timeout (15 s) → late accept 409 → other driver; no drivers: waiting steps, busy end at 8 min (sample document); with no busy step the search expires at exactly 10 min; keep waiting +3 min | `05_dispatch.test.ts` | passes |
| 6 | Raise while searching (fare and driver earnings + raise, Movera share unchanged) and while offered (open offer withdrawn, re-offered at the new price, the driver who declined asked again); 2 × cap, currency, zero; refused once accepted and after expiry; raise when the quote is 0 (finding P3-1, fixed) | `06_raise.test.ts` | passes |
| 7 | Rider ends early after 0.4 km / 1 min = `end_early_minimum` (minimum_adjust, lines, driver earnings); driver completes far from the drop-off = driven fare; at the drop-off the booked fare stands; Priority 1 km / 2 min = `minimum_kicks_in` from quote to final fare | `07_endings.test.ts` | passes |

## Not done yet

Scenarios 8–11 and the Phase 1 findings (in progress).

## Findings

### P3-1 — Raise price: the 2 × cap is skipped when the quoted fare is 0 (S3, fixed)

- **Steps.** Publish a pricing document whose economy category prices to 0 (base, per km, per min, minimum 0, app
  fee 0 %: an admin can publish it, e.g. a free-ride promotion). Book economy (quote 0 kr). `POST
  /trips/{id}/raise-price { increase: 10 000 kr }` → **200**, fare 10 000 kr, and the whole raise is added to the
  driver's earnings.
- **Contract.** CONTRACT.md §3.6 and `contract.json#dispatch.raisePrice`: "The new fare may not pass `maxFactor` × the
  quoted fare (`400 invalid_request`, reason `raise_too_high`)". 2 × 0 = 0, so every raise must be refused.
- **Root cause.** `src/trips/service.ts` `raisePrice`: `if (booked > 0 && fareMinor > booked * RAISE_MAX_FACTOR)`;
  the `booked > 0` guard turned the cap off for a 0 quote (`booked_fare_minor` is `NOT NULL`, set from the quote).
- **Severity.** S3: wrong money is possible but only after an admin publishes a 0 price; the sample settings never
  quote 0.
- **Fix.** The guard is removed; the cap applies to every quote. Nothing else changes (a quote above 0 is capped as
  before).
- **Test.** `test/e2e/06_raise.test.ts` "a quote of 0 …": failed before the fix (`expected 200 to be 400`), passes
  after. The other raise cases (cap exactly at 2 ×, above it, currency, zero increase) pass before and after.

## Observations (not defects by the contract)

- **No-show fee shown vs charged (contract fixtures, not the server).** The server charges the pricing document's
  `noShowFee` (65 kr, "money in Pricing", CONTRACT.md §6 table), but the sample `rider_app_config.json` /
  `driver_app_config.json` say `waiting.noShowFee` 50 kr. An app that shows the config value would show 50 kr while
  65 kr is owed. For the contract owner (sample documents) and the app phases.

- **Destination is not limited.** Only the pickup must be in an open zone (`service_not_available`); the contract
  says nothing about the drop-off, so a drop-off outside every zone is quoted. Owner question if that matters.
- **Refresh retry window.** Sending the same refresh token again within 60 s while its replacement was never used is
  treated as a lost answer (a new pair is issued, the unused replacement dropped), not as theft. After the window,
  or once the replacement was used, it is theft and the whole session ends (`refresh_token_reused`).
