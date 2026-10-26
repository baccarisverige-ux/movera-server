# Audit Phase 3 — one ride with the three apps (cross-app run)

Branch `audit/phase-3-crossapp`. Server part: `docs/audit/phase-3.md`. How to run it again: `test/crossapp/README.md`.

## What ran

- **Server**: this branch (`main` after #18), `MOVERA_ENV=staging`, `npx tsx src/main.ts` on `127.0.0.1:8080`,
  its own Postgres database (cluster 16/main), `SEED_TEST_ON_START=true` (fleet MV-TESTA, test riders, sample
  settings), bootstrap Super admin. Real clock, real timer worker, no OSRM, no Google key. An HTTPS front
  (`test/crossapp/serve.mjs`, self-signed) on `:8443`, because the rider's staging build refuses a non-https API.
- **Rider**: `movera-rider-app` `main` (265fd2a), `flutter build web --release --pwa-strategy=none
  --dart-define=MOVERA_FLAVOR=staging --dart-define=MOVERA_API_BASE_URL=https://localhost:8443
  --dart-define=MOVERA_AUTH_REQUIRED=true` (the Pages live flags), phone 390 × 844, Chromium (Playwright 1.56).
  Account +46701740608, code 1234.
- **Driver**: `Movera-driver-app` `main` (11ccb12), `flutter build web --release --dart-define=MOVERA_AUTH_REQUIRED=true
  --dart-define=MOVERA_API_BASE_URL=https://localhost:8443` (the Pages live flags), same browser. Account
  +46701740605 (Test Åkare, car TST 001), code 1234.
- **Admin**: `Admin-panel-movera-dispatch` `main` (e89de99), `VITE_ADMIN_API=https://localhost:8443 npx vite build`,
  desktop 1440 × 900, password set through the server's setup link, then signed in.
- **The ride**: economy, cash, Sergels torg (59.3326, 18.0649) → Odenplan (59.3429, 18.0496), 1.8 km, quote 75 kr.

Three runs: **run 1** by hand step by step on the `main` builds (found the defects below), **run 2/3** with
`test/crossapp/run.mjs` on the builds with the fixes (run 3 is the clean evidence; run 2 found a stand-in mistake in
my own script, see "Not defects"). Screenshots: `<scratchpad>/p3x/<n>-<step>-<app>.png` (run 3), `p3x/run1/` (run 1);
`p3x/run3/steps.json` holds, per step, what each app showed next to the server's `GET /admin/trips/{id}`, and
`p3x/run3/network.json` every API call of each app with its answer.

### Stand-ins (not the real thing; said here so nobody reads more into the result)

- **GPS** is a script position (`navigator.geolocation` replaced). Headless Chromium's emulation answers a fresh
  `getCurrentPosition` only when the position changes, so the driver's location batches timed out without it (an
  environment effect, not an app defect: the browser itself hung on the same call).
- **Address search** (`/locations/autocomplete`, `/geocode`, `/reverse-geocode`) is answered in the rider's browser:
  without a Google key the server answers 503 `address search unavailable` (as designed). Trips, quotes, offers,
  dispatch, events and money are the real server's.
- **Maps**: no Google Maps key, so map areas are empty (the driver shows Google's "didn't load Google Maps" page
  behind the home screen); no OSRM, so the driver app says "Rutten är inte tillgänglig" and the server prices from
  its straight-line estimate.
- **CanvasKit** is served from the local build (gstatic.com is not reachable from the sandbox).

## What matched (run 3, trip `trp_01M5WVBM6K2VAN7SE8AFW1EATS`)

Server truth from `GET /admin/trips/{id}` at each step; "—" = the screen does not show it.

| Step | Server | Rider web | Driver web | Admin panel (live) |
|---|---|---|---|---|
| 1 request | `searching` → `offered` (exclusive), fare 75 kr | "Finding your driver · Meet at Sergels torg, Stockholm · Cash · 75 kr" | exclusive offer card: **56,34 kr** (= driverEarnings 54,79 + pickupPay 1,55 of the offer), Sergels torg 1 min → Odenplan 1,8 km, Kontant | driver row Online |
| 2 offer | `offered` (radar after the exclusive ran out) | still searching ("busier than usual", raise options from **Current 75 kr**) | radar offer: 56,34 kr, Sergels torg 300 m → Stockholm 5 min · 1,8 km | Online |
| 3 accept | `accepted` → `driver_to_pickup`, driver Test, car Volvo V60 Black **TST 001**, earnings 54,79, commission 18,66, pickupPay 1,55 | "Pickup in 1 min", **Test · Black Volvo V60 · TST 001**, Cash · 75 kr | "Hämta Passagerare · Sergels torg, Stockholm" | driver **På resa** |
| 4 arrive | `arrived`, free wait until +5 min | "Test is here · TST 001 · Black Volvo V60", "I'm on the way" (→ driver: "Passagerare är på väg") | waiting clock, "Starta resan" | På resa |
| 5 start | `in_trip` (board + start) | "ON TRIP · Arrive by … · Odenplan · Movera · Cash · 75 kr", TST 001 | "Lämna av Passagerare · Odenplan", "Ta emot kontant" | På resa |
| 6 complete | `completed`, `paymentStatus captured`, fare 75 kr | "Trip complete"; receipt (run 1, scrolled): **#ZBRP4X** (the id's last 6), Test, Black Volvo V60, **Total payment 75 kr, Cash**; run 3 did not scroll the receipt | collect **75 kr**, "Din intäkt 56,34 kr", "Du är skyldig Movera −18,66 kr"; done screen 56,34 kr "inkl. +1,55 kr Movera-bonus", Rese-ID **…8AFW1EATS**, Kontant | driver back **Online** |

Money adds up across the three: 75,00 = 54,79 (driver earnings) + 1,55 (pickup pay) + 18,66 (commission); the driver
app's 56,34 kr is earnings + pickup pay and its "owes Movera 18,66 kr" is the commission on a cash trip. Trip id,
status, driver and car agree between rider, driver and server at every step. Rider's rating (5 stars) reached the
server (`POST /trips/{id}/rating` 201, `ratingStatus submitted`).

## What did not match

| # | Where | Mismatch | Status |
|---|---|---|---|
| M1 | Admin | The live panel **cannot show the trip at all**: Trips, trip detail, live map are demo pages in a live build ("0 resor i demodata … Kunde inte laddas"). Only the driver row (Online → På resa → Online) is live. Trip id, status, car and money were read from the server's admin API instead. | Known Phase 1 finding (admin baseline §8, S1 "no live trips"), a feature, not fixed here |
| M2 | Driver | After a reload the app showed the radar **off** while the server kept the driver **online** (offers sent, admin "Online"). | **Fixed** (D-1) |
| M3 | Driver | The map of a real trip said **"Demoerbjudanden" / "Demo offers"**. | **Fixed** (D-2) |
| M4 | Rider | Receipt offered **tips 10/20/30 kr**; a chosen tip was **never sent** (server: `tips_not_available`), and a tip without stars left the rider on an error. | **Fixed** (R-1) |
| M5 | Driver | A driver signing in fresh (new browser / cleared storage) while the server holds an accepted trip: the app showed **"Radar LIVE · Söker resor"**, the server `on_trip` with `activeTripId`; the rider was waiting for that driver. | Found, **not fixed** (D-3, needs the trip restored from the server; not a small fix) |
| M6 | Driver | The done screen calls the pickup pay "Movera-bonus" (`inkl. +1,55 kr Movera-bonus`); the server calls it `pickupPay`. The amount matches. | Wording, S4, not changed |

## Defects

### D-1 — Driver app: a restart left the server's "online" behind (S3, fixed, Movera-driver-app)

- **Steps.** Driver web build, sign in, tap the radar (online). Reload the page. The app opens with **Radar AV**
  (decision D11: never online by itself after a restart). `GET /driver/profile` → `onlineStatus: online`; the admin
  lists the driver **Online**; the server keeps choosing the driver (until its last fix is 120 s old) and exclusive
  offers time out against `missed_exclusive`. The app has no feed and sends no location.
- **Root cause.** `LivePresence` (`lib/core/live/live_driver_services.dart`) starts with `serverOnline = false`;
  `goOffline()` returns early when `!serverOnline`, and nothing at start reads the server's state. D11 was kept on
  the phone only.
- **Fix.** `LivePresence.settleAfterStart()`: once per start, before the driver goes online, a server `online` is
  set `offline` (`POST /driver/availability` with the profile's version; a version mismatch is retried with the
  server's). `on_trip` and `offline` are left alone, and a tap on the radar meanwhile wins (same queue). Home calls it
  in `initState` in a live build.
- **Test.** `test/core/live_driver_services_test.dart` "D11: …" (3 tests: stale online turned offline once; on_trip
  left alone; going online right after the start is not undone). Before the fix they do not compile
  (`settleAfterStart` does not exist); after: pass. Full driver suite 2198 passed, analyze clean.
- **Evidence.** Run 1: `p3x/run1/driver-reload-radar-off.png` and the profile answer `onlineStatus: online`. Run 3
  (a server still holding the driver online from run 2): at start `GET /driver/profile` online → `POST
  /driver/availability` offline → the driver's tap → online (`p3x/run3/network.json`, 19:34:13–17).

### D-2 — Driver app: "Demo offers" over the map of a live trip (S4, fixed, Movera-driver-app)

- **Steps.** Accept a live offer. The trip map shows "Demoerbjudanden" above the map buttons (run 1, `p3x/run1/
  3-accept-driver.png`, `4-arrive-driver.png`).
- **Root cause.** `_buildMapControls` (`accept_ride_panel.dart`) always drew the demo dispatch's label.
- **Fix.** The label only without `LiveDriverServices` (the demo); nothing else moves.
- **Test.** `test/audit/trip_map_controls_test.dart` "p3x: a live trip is not labelled as demo offers": failed
  before (`Found 1 widget with text containing Demo offers`), passes after; the demo test (label stays on screen)
  passes unchanged.
- **Evidence.** Run 3 driver screenshots 3–5: no label.

### R-1 — Rider app: tips offered that the server never receives (S3, fixed, movera-rider-app)

- **Steps.** Complete a live trip. Ride summary: "Tip Test 10 kr / 20 kr / 30 kr". Pick 10 kr and 5 stars, Done →
  only `POST /trips/{id}/rating {stars: 5}` is sent (`ride.feedback.tip_not_sent` in the log); the rider is told
  nothing (`p3x/run1/7a-rate-tip-rider.png`). Pick only a tip, Done → `StateError('Tips are not available yet.')`,
  the screen stays with its error.
- **Contract/server.** `POST /trips/{id}/rating` with a tip → `400 tips_not_available` (`src/trips/ride.ts`).
- **Root cause.** The tip options came from the zone config / built-in seed whatever the transport; only the
  repository knew the server has no tips.
- **Fix.** `RideCompleteController(tipsOnServer:)`; the app scope passes `!api.contractWire`, so against
  movera-server the tip card shows its existing honest state "Tips unavailable". Demo/dev builds unchanged.
- **Test.** `test/ride_complete/tip_honest_state_test.dart` "p3x: against movera-server (no tips yet) no amount is
  offered": does not compile before (`tipsOnServer` does not exist), passes after. Full rider suite 2971 passed,
  analyze clean.
- **Evidence.** Run 3 `p3x/6-complete-rider.png`: "Tips unavailable".

### D-3 — Driver app: a trip held by the server is not restored on a fresh sign-in (S2, not fixed)

- **Steps.** Run 2 stopped after accept (script error). The next run signed the driver in from a new browser
  context: `GET /driver/profile` → `onlineStatus: on_trip`, `activeTripId: trp_01M5WT3X…`; the app showed **Radar
  LIVE · Söker resor** and no trip (`p3x/run2` network and `failed-driver.png` of that run). The rider's trip stayed
  `accepted` until I cancelled it as admin.
- **Root cause (read in code).** The driver app restores an active trip only from its own storage
  (`PrefsActiveRideRepository`); `activeTripId` from the profile is never read (`grep activeTripId lib/` → only the
  local session). A reload in the same browser keeps the storage, so it restores there.
- **Why not fixed here.** Restoring a trip from the server means reading it, picking the screen stage from its status
  and taking over its events: a feature-sized change in the trip screen, not a smallest fix. Recommended for the
  driver app's next phase; the server already sends what is needed (`Driver.activeTripId`, `GET /trips/{id}`).

## Observations (not defects by the contract, not changed)

- **Calls the server does not serve**: rider `GET /ride-types` (404, not in the contract), `GET
  /rider/promotions/active` (404, not in the contract), `POST /telemetry/logs` (404 `operation_not_enabled`, **in the
  contract** `postTelemetryLog`; the server does not implement it, so app logs are lost — S4). The rider falls back
  without showing an error.
- **Driver "waiting" subtitle**: on arrival the driver sheet says "Väntar på Passagerare · Odenplan, Stockholm" (the
  drop-off) while waiting at the pickup. Arguably the next destination; owner question.
- **Offer naming**: the rider sees 75 kr; the driver sees 56,34 kr. Both are right (fare vs. earnings + pickup pay);
  only the driver's done screen names the 1,55 kr "Movera-bonus" (M6).

## Not defects (my own mistakes, kept so nobody repeats them)

- Run 2 booked a trip whose **pickup address said "Odenplan"** at Sergels torg's coordinates. The rider app geocodes
  the pickup's label too (`geocode {query: "Sergels torg, Stockholm"}`), and my stub answered Odenplan to every
  geocode. With the stub answering by query (run 3) the pickup is "Sergels torg, Stockholm" everywhere.

## What could not be run

- **The admin panel's trip views** (M1): not built for live; nothing to compare.
- **Maps, routes and real address search**: no Google key and no OSRM locally (stand-ins above).
- **Real phones** (Android/iOS builds, background location, push): web builds only.
- **Card payments**: cash only in the test week.
- The admin's own actions on the trip (cancel/reassign/refund) from the panel: not available in the live panel (M1);
  the one admin cancel used to clean up after run 2 went through the API with curl.

## PRs

- movera-server: this document, `test/crossapp/` (`serve.mjs`, `run.mjs`, `README.md`) and an ESLint block for
  those scripts. No server code changed: no server defect was found in this run.
- Movera-driver-app: D-1, D-2.
- movera-rider-app: R-1.
- Admin-panel-movera-dispatch: no change (M1 is the known S1 feature gap).
