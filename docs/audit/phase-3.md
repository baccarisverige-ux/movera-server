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
| 8 | Same Idempotency-Key twice (also at the same moment) → one trip, replayed answer, other body 409; two drivers accept a radar group at once → exactly one 200, the other 409 and `offer_withdrawn`; events shuffled → the app keeping the highest version ends at the server's state; trip stream dropped and resumed with Last-Event-ID → no gap, no duplicate; offer feed resume; both apps "restart" mid-trip, reread (`/rider/trips/active`, `Driver.activeTripId`), a stale command gets 409 `version_mismatch` with the current projection | `08_concurrency.test.ts` | passes |
| 9 | Admin manual booking: not served (404 `operation_not_enabled`); assign to a chosen driver; reassign (driver's stream closes, trip searches again without them); admin cancel (an admin outside the zone is refused); refund (finance → 202, approved by the Super admin; Super admin direct 201; never above what was paid); block a driver and block a car mid-trip (findings P3-3); reported cash above the fare (finding P3-2) | `09_admin.test.ts` | passes |

## Not done yet

Scenarios 10–11 and the remaining Phase 1 findings (in progress).

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

### P3-2 — A driver's reported cash had no upper bound (Phase 1 finding; S2, fixed)

- **Steps.** Complete a 217 kr cash trip with `POST /trips/{id}/complete { cashCollected: 1 000 000 kr }` → **200**;
  the trip stores 1 000 000 kr cash; the driver's earnings report shows `cashCollected` 1 000 000 kr (their cash
  balance owed to Movera); and `POST /admin/trips/{id}/refund { amount: 50 000 kr }` by the Super admin → **201**,
  a refund of 50 000 kr on a 217 kr fare (`refundRoom` takes "paid" = cash collected + wallet).
- **Contract.** `CompleteCommand.cashCollected` is a `Money` with no stated bound; the rider owes the fare, which
  already holds every outstanding fee (§3.7); tips are not available (`tips_not_available`). Nothing allows cash
  above what is owed, so bounding it to the fare is within the contract.
- **Root cause.** `src/trips/ride.ts` `completeTrip` took `body.cashCollected.amountMinor` as given.
- **Severity.** S2: wrong money in the cash balance and the refund room, but not reachable from the shipped driver
  app (it completes without `cashCollected`, so the server uses fare − wallet); an admin must also approve the
  refund.
- **Fix.** More cash than fare − wallet is refused: `400 invalid_request`, reason `cash_above_fare`. A count up to
  the fare (a short count leaves fees owed, as before) is unchanged.
- **Test.** `test/e2e/09_admin.test.ts` "a driver's reported cash cannot pass the fare …": failed before the fix
  (`expected 200 to be 400`), passes after; the existing tests that send exact counts (`ride.test.ts`,
  `review_ride.test.ts`, `review_admin.test.ts`) pass unchanged.

### P3-3 — A driver blocked (or whose car was blocked) during a trip came back online when it ended (S2, fixed)

- **Steps.** Driver on a trip (`in_trip`); an admin sets the driver `suspended` (`POST /admin/drivers/{id}/status`)
  or blocks the car (`POST /admin/vehicles/{id}/review { decision: blocked }`). The trip runs to its end, as decided.
  After `complete` the driver is **`online`** again. With the blocked car, the very next booking **offers the trip
  to that driver** (probe: offer present). With the suspended account no offer is sent (dispatch checks
  `account_status`), but the driver app and the admin's live map show the driver online.
- **Expected.** `docs/DECISIONS.md`: "A blocked driver goes offline (a ride already going runs to its end)"; "A blocked
  fleet takes its drivers offline; a trip under way runs to its end. A car that is no longer approved takes its
  driver offline too." CONTRACT.md §6 table: on hold / suspended "can't go online".
- **Root cause.** The block only switches drivers that are `online` / `going_online` to `offline`; an `on_trip`
  driver is left for the trip's end, but `releaseDriver` (`src/trips/ride.ts`) always turned `on_trip` back into
  `online`. Dispatch does not check the car's status, so a blocked car kept getting offers.
- **Fix.** `releaseDriver` turns `on_trip` into `online` only when the driver may still drive (account `active`, car
  approved or none, fleet approved or none, the same blocks the three admin actions apply), else `offline`
  (`online_since` cleared). Nothing changes for a driver who was not blocked.
- **Test.** `test/e2e/09_admin.test.ts` "blocking a driver mid-trip …" and "blocking the car mid-trip …": both failed
  before the fix (`expected 'online' not to be 'online'`, `expected 'online' to be 'offline'`), pass after.

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
