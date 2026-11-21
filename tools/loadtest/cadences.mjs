// The real apps' request cadences, per phone state (global plan step 60, T1 part 2). ONE table: the fake phones in
// phones.mjs read only this, and test/tools/loadtest_phones.test.ts checks the measured counts against it (G0: tool
// counts = request budgets within 10 %). Every number cites the app code on origin/main:
//   rider  = movera-rider-app  9b316429 (2026-11-10)     driver = Movera-driver-app be423a57 (2026-11-10)
// Budgets agree with Rules audits/global-plan-2026-11-08/AUDIT-R09.md §3.1 and architecture-2026-11-08/GM3-DRIVER.md §3.2
// (rider Home 8.8, Choose 19.5, Finding 7.5 / 11.5 after 3 min, Waiting / Arrived / Trip 13.5 + 2 per trip event,
// Receipt 7.5; driver offline 7, online idle 14, to pickup / on trip 9.67). A PR that changes a number says why.
//
// Entry fields: id (counter key), method, path(ctx) → path under /api/v1, every (seconds), source (file:line),
// dynamic (optional: the app takes the period from the answer, clamped), batch (optional: one tick sends several GETs),
// timer (optional: entries with the same timer are ONE app timer whose request changes with the state),
// immediate (optional: the app also asks at once when the state starts; otherwise the first tick is one period later,
// as Dart's Timer.periodic), when + only (optional: the app's timer runs but a tick asks only while when(phone) is true;
// such entries are not in the per-minute budget). Budgets are steady-state rates: a stay of T s is off by up to every/(2T).
// This first table is the "old" one (the default). LOADTEST_CADENCE=real picks CADENCES_REAL below (S4e).

import { LoadtestGuardError } from "./guards.mjs";

/** Requests every periodic timer sends, per state. Timers with the same id keep running across a state change. */
const RIDER_WATCH_HOME = { id: "GET /rider/trips/active", timer: "rider_trip_watch", method: "GET", path: () => "/rider/trips/active", every: 8, source: "rider lib/features/ride_booking/application/rider_trip_watch.dart:24 (pollEvery 8 s), Home branch :13" };
const RIDER_WATCH_RIDE = {
  id: "GET /rider/trips?booked-banner",
  timer: "rider_trip_watch", // the same 8 s Timer as Home: only the branch (the path) changes
  method: "GET",
  path: () => "/rider/trips?kind=scheduled&status=driver_to_pickup&status=arrived",
  every: 8,
  source: "rider rider_trip_watch.dart:24 (8 s) + ride-screen path :49 (booked banner, also on the receipt)",
};
const RIDER_PRESENCE = { id: "GET /rider/nearby-vehicles (presence)", method: "GET", path: (c) => `/rider/nearby-vehicles?lat=${c.lat.toFixed(5)}&lng=${c.lng.toFixed(5)}`, every: 45, immediate: true, source: "rider lib/features/home/application/home_presence.dart:35 (defaultEvery 45 s), :53-57 (asks at once when Home shows, then every 45 s)" };
const RIDER_NEARBY = {
  id: "GET /rider/nearby-vehicles (choose)",
  method: "GET",
  path: (c) => `/rider/nearby-vehicles?lat=${c.lat.toFixed(5)}&lng=${c.lng.toFixed(5)}`,
  every: 5,
  // The app polls at the server's refreshSeconds, clamped 5–30 s; the contract default is 5.
  dynamic: { field: "refreshSeconds", min: 5, max: 30 },
  source: "rider lib/features/ride_selection/data/nearby_cars_repository.dart:13-18 (clamp 5–30 s) + server answer refreshSeconds = contracts/contract.json#riderNearby.refreshSeconds 5",
};
const RIDER_SEARCH_CHECK = { id: "GET /trips/{id} (search check)", method: "GET", path: (c) => `/trips/${c.tripId}`, every: 15, source: "rider lib/features/finding_driver/application/finding_driver_controller.dart:96-97 (after 3 min, every 15 s; app path is the /rides/{id} alias)" };
const RIDER_BADGE = { id: "GET /trips/{id}/messages (badge)", method: "GET", path: (c) => `/trips/${c.tripId}/messages?limit=50`, every: 10, source: "rider lib/features/messages/application/messages_controller.dart:52 (tripPollInterval 10 s)" };

const DRIVER_GPS = { id: "POST /driver/location", method: "POST", path: () => "/driver/location", every: 10, body: "location", source: "driver lib/core/live/live_driver_services.dart:667 (defaultEvery 10 s), :747 Timer.periodic, :904 one fix" };
const DRIVER_AIRPORT = { id: "GET /driver/airport-queue", method: "GET", path: () => "/driver/airport-queue", every: 20, source: "driver lib/core/airport/airport_queue.dart:64 (every 20 s), :107 Timer.periodic" };
const DRIVER_BADGES = {
  id: "GET Home badges (4)",
  method: "GET",
  batch: ["/driver/profile", "/notifications", "/driver/reminders", "/driver/onboarding/settings"],
  every: 60,
  source: "driver lib/presentation/driver/documents/onboarding_refresh.dart:10 (60 s) + lib/presentation/driver/home/home_account.dart:83 (only while Home is visible), :512-537 (profile, notifications, reminders, onboarding settings)",
};
const DRIVER_SURGE = { id: "GET /driver/surge-map", method: "GET", path: () => "/driver/surge-map", every: 60, source: "driver lib/core/surge/surge_map.dart:227 (every 60 s), :284 Timer.periodic" };
const routeTo = (to) => ({
  id: `GET /routes/driving (${to})`,
  method: "GET",
  path: (c) => `/routes/driving/${c.lng.toFixed(5)},${c.lat.toFixed(5)};${c.toLng.toFixed(5)},${c.toLat.toFixed(5)}`,
  every: 90,
  immediate: true,
  source: "driver lib/core/navigation/navigation_controller.dart:194 (silentRefreshInterval 90 s), :395-420 (a new destination is routed at once)",
});
const DRIVER_ROUTE = routeTo("to pickup");
const DRIVER_ROUTE_DROPOFF = routeTo("to drop-off");

export const CADENCES = Object.freeze({
  rider: {
    home: [RIDER_WATCH_HOME, RIDER_PRESENCE],
    choose: [RIDER_WATCH_HOME, RIDER_NEARBY],
    finding: [RIDER_WATCH_RIDE],
    finding_late: [RIDER_WATCH_RIDE, RIDER_SEARCH_CHECK],
    waiting: [RIDER_WATCH_RIDE, RIDER_BADGE],
    arrived: [RIDER_WATCH_RIDE, RIDER_BADGE],
    in_trip: [RIDER_WATCH_RIDE, RIDER_BADGE],
    receipt: [RIDER_WATCH_RIDE],
  },
  driver: {
    offline_home: [DRIVER_AIRPORT, DRIVER_BADGES],
    online_idle: [DRIVER_GPS, DRIVER_AIRPORT, DRIVER_BADGES, DRIVER_SURGE],
    to_pickup: [DRIVER_GPS, DRIVER_AIRPORT, DRIVER_ROUTE],
    // GM3 §3.2 has no own "arrived" column: the trip screen stays open, so the to-pickup timers keep running.
    at_pickup: [DRIVER_GPS, DRIVER_AIRPORT, DRIVER_ROUTE],
    on_trip: [DRIVER_GPS, DRIVER_AIRPORT, DRIVER_ROUTE_DROPOFF],
  },
});

/** Requests the apps send on an event (not on a timer). Checked as requests per event, not per minute. */
export const REACTIONS = Object.freeze({
  rider: {
    rider_trip_changed: {
      // 2 GETs per trip event of the rider (the server sends one for every trip event, streams.ts:128-133, no filter).
      requests: (state) => [
        { id: "reaction GET /rider/trips?kind=scheduled", method: "GET", path: "/rider/trips?kind=scheduled&limit=100" },
        state === "home" || state === "choose" ? { id: "reaction GET /rider/trips/active", method: "GET", path: "/rider/trips/active" } : { id: "reaction GET /rider/trips?booked-banner", method: "GET", path: "/rider/trips?kind=scheduled&status=driver_to_pickup&status=arrived" },
      ],
      ids: ["reaction GET /rider/trips?kind=scheduled", "reaction GET /rider/trips/active", "reaction GET /rider/trips?booked-banner"],
      perEvent: 2,
      minGapSeconds: 0,
      source: "rider rider_trip_watch.dart:79-85 (kind rider_trip_changed → _refreshList() + check()); lib/features/reservations/data/api_reservation_repository.dart:33 (booked list ?kind=scheduled&limit=100)",
    },
  },
  driver: {
    driver_reservations_changed: {
      requests: () => [
        { id: "reaction GET /driver/reservations?scope=open", method: "GET", path: "/driver/reservations?scope=open" },
        { id: "reaction GET /driver/reservations?scope=accepted", method: "GET", path: "/driver/reservations?scope=accepted" },
      ],
      ids: ["reaction GET /driver/reservations?scope=open", "reaction GET /driver/reservations?scope=accepted"],
      perEvent: 2,
      minGapSeconds: 2,
      source: "driver lib/core/live/reservations_refresh.dart:11 (at most once per 2 s), lib/core/live/live_reservations.dart:19-35 (open + accepted)",
    },
  },
});

/**
 * Requests on entering a state / signing in (once). The phones' own flow requests (with bodies) are in phones.mjs:
 * rider POST /quotes on Choose ride (select_ride_quotes.dart:7, R09 P6; the expiry re-quote is not simulated),
 * POST /trips, cancel; driver accept / decline, head-to-pickup, arrive, board, start, complete.
 */
export const ON_ENTER = Object.freeze({
  rider: {
    signed_in: [{ id: "GET /rider/config", method: "GET", path: "/rider/config", source: "rider lib/core/config/api_rider_config_repository.dart:72 (path), :275-284 (config read with the stream, R09 P14)" }],
  },
  driver: {
    signed_in: [{ id: "GET /driver/config", method: "GET", path: "/driver/config", source: "driver lib/core/live/live_driver_config.dart:246 (every (re)connect, GM3 §2.3)" }],
    online_idle: [{ id: "GET /driver/offers", method: "GET", path: "/driver/offers", source: "driver lib/core/live/live_driver_services.dart:611-616 (offer list with the offer stream)" }],
    to_pickup: [{ id: "GET /trips/{id} (trip screen opens)", method: "GET", path: (c) => `/trips/${c.tripId}`, source: "driver lib/core/live/live_trip_commands.dart:251-252 (begin: read the trip, then head-to-pickup)" }],
  },
});

/** Streams each state keeps open (SSE). */
export const STREAMS = Object.freeze({
  rider: { config: "/rider/config/stream (always while signed in, R09 §2)", trip: "/trips/{id}/events (finding … receipt, rider lib/features/active_ride ride_completed.dart:137)" },
  driver: { config: "/driver/config/stream (signed in, live_driver_config.dart:206-337)", offers: "/driver/offers/stream (online and on a trip, GM3 §2.3)", trip: "/trips/{id}/events (a trip is open, api_driver_realtime.dart)" },
});

/* ===================================================================================================================
 * The REAL table (S4e, 2026-11-21): LOADTEST_CADENCE=real. The cadences of the load-cut app branches, audited line by
 * line (Rules audits/impact/stress-s4b-2026-11-20.md "S4e"). The old table above stays the default, so earlier runs
 * stay comparable. Sources:
 *   rider  = movera-rider-app  origin/claude/rules-email-key-browserstack-f5y0p3-loadcut-r e9e060d6 (#677)
 *   driver = Movera-driver-app origin/claude/rules-email-key-browserstack-f5y0p3-loadcut-d 077b5b85 (#654)
 * The server under test needs the load cut (#304, ...-loadcut-s): GET /driver/home-badges and airport_queue_changed.
 * (On an older server the driver app falls back to the 4 badge reads, onboarding_refresh.dart:113-130.)
 *
 * What changed against the old table:
 *   - rider trip watch: 60 s while /rider/config/stream is up (was 8 s), and on a ride screen it sends nothing unless
 *     the rider has a booked ride (the load riders book live rides only);
 *   - rider messages badge poll: gone (messages come on the trip stream);
 *   - driver airport queue: 60 s fallback (was 20 s), only while online near an airport zone, + the hint;
 *   - driver Home badges: 1 GET /driver/home-badges every 60 s (was 4 GETs).
 * Not on a timer here because the tool keeps every stream up: the trip projection poll (10 s) runs only while the trip
 * stream is down (rider lib/core/realtime/api_ride_realtime.dart:23-28, :55, :160-169).
 * =================================================================================================================== */

/** Airport zones (bounding boxes) as the server seeds them: migrations/0005_quotes.sql:15-16 (ARN, BMA), 0028_zones.sql:33-40 (CDG, ORY). */
export const AIRPORT_ZONES = Object.freeze([
  { zoneId: "ARN", south: 59.62, west: 17.85, north: 59.68, east: 17.97 },
  { zoneId: "BMA", south: 59.348, west: 17.8, north: 59.378, east: 17.88 },
  { zoneId: "CDG", south: 48.985, west: 2.49, north: 49.035, east: 2.61 },
  { zoneId: "ORY", south: 48.71, west: 2.32, north: 48.745, east: 2.41 },
]);

/** driver lib/core/airport/airport_queue.dart:87 (nearDegrees 0.02, about 2 km), :101-111 (inside or near the bounds). */
export function nearAirport(pos, zones = AIRPORT_ZONES, margin = 0.02) {
  if (!pos) return false;
  return zones.some((z) => pos.lat >= z.south - margin && pos.lat <= z.north + margin && pos.lng >= z.west - margin && pos.lng <= z.east + margin);
}

/**
 * driver airport_queue.dart:92-113 AirportQueue.wanted (online, and in a queue or at / near an airport zone) via
 * lib/presentation/driver/airport_queue/airport_queue_card.dart:24-29 (online = the location sender runs). The fake
 * drivers never join a queue, so "in a queue" is false.
 */
const onlineNearAirport = (phone) => phone.app === "driver" && phone.state != null && phone.state !== "offline_home" && nearAirport(phone.pos);

const REAL_RIDER_WATCH_HOME = {
  id: "GET /rider/trips/active",
  timer: "rider_trip_watch",
  method: "GET",
  path: () => "/rider/trips/active",
  every: 60,
  source: "rider lib/features/ride_booking/application/rider_trip_watch.dart:36 (streamUpEvery 60 s while /rider/config/stream is connected), :62 (_every), :159 Timer.periodic, :227-233 (Home: only the active trip); lib/core/config/api_rider_config_repository.dart:324-327, :341 (_setUp(true) after 30 s up or on an event)",
};
const REAL_RIDER_WATCH_RIDE = {
  id: "GET /rider/trips?booked-banner",
  timer: "rider_trip_watch", // the same 60 s timer; on a ride screen it asks only with a booked ride
  method: "GET",
  path: () => "/rider/trips?kind=scheduled&status=driver_to_pickup&status=arrived",
  every: 60,
  only: "has_booked_ride",
  when: (phone) => Boolean(phone.hasBookedRide),
  source: "rider rider_trip_watch.dart:36 (60 s), :234-236 (R09 N5: no booked ride → no banner check), :88-89 (path)",
};
const REAL_RIDER_PRESENCE = { ...RIDER_PRESENCE, source: "rider lib/features/home/application/home_presence.dart:35 (defaultEvery 45 s), :54-57 (asks at once when Home shows), :92 (then every 45 s)" };
const REAL_RIDER_NEARBY = { ...RIDER_NEARBY, source: "rider lib/features/ride_selection/data/nearby_cars_repository.dart:17-18 (clamp 5–30 s) + server refreshSeconds = contracts/contract.json#riderNearby.refreshSeconds 5" };
const REAL_RIDER_SEARCH_CHECK = { ...RIDER_SEARCH_CHECK, source: "rider lib/features/finding_driver/application/finding_driver_controller.dart:97-98 (searchTimeout 3 min, serverCheckEvery 15 s), finding_driver_controller_search.dart:41-50 (the check after the timeout), finding_driver_controller.dart:658 (GET /rides/{id}, the /trips/{id} alias)" };

const REAL_DRIVER_GPS = { ...DRIVER_GPS, source: "driver lib/core/live/live_driver_services.dart:811 (defaultEvery 10 s), :947 Timer.periodic" };
const REAL_DRIVER_AIRPORT = {
  id: "GET /driver/airport-queue",
  method: "GET",
  path: () => "/driver/airport-queue",
  every: 60,
  immediate: true,
  only: "online_near_airport",
  when: onlineNearAirport,
  source: "driver lib/core/airport/airport_queue.dart:73 (every 60 s, loadCut.airportQueueFallbackSeconds), :153-154 (one tick at once, then Timer.periodic), :163-166 (a tick asks only while wanted), :92-113 (wanted: online + near an airport)",
};
const REAL_DRIVER_BADGES = {
  id: "GET /driver/home-badges",
  method: "GET",
  path: () => "/driver/home-badges",
  every: 60,
  source: "driver lib/presentation/driver/documents/onboarding_refresh.dart:11 (60 s), :87-98 (ONE GET /driver/home-badges), lib/presentation/driver/home/home_account.dart:102-103 (only while Home is visible), :543; lib/core/account/driver_account_repository.dart:31 (path)",
};
const REAL_DRIVER_SURGE = { ...DRIVER_SURGE, source: "driver lib/core/surge/surge_map.dart:227 (every 60 s), :284 Timer.periodic" };
const realRoute = (r) => ({ ...r, source: "driver lib/core/navigation/navigation_controller.dart:203 (silentRefreshInterval 90 s), :402-421 (a new destination is routed at once; the same one again after 90 s)" });
const REAL_DRIVER_ROUTE = realRoute(DRIVER_ROUTE);
const REAL_DRIVER_ROUTE_DROPOFF = realRoute(DRIVER_ROUTE_DROPOFF);

export const CADENCES_REAL = Object.freeze({
  rider: {
    home: [REAL_RIDER_WATCH_HOME, REAL_RIDER_PRESENCE],
    choose: [REAL_RIDER_WATCH_HOME, REAL_RIDER_NEARBY],
    finding: [REAL_RIDER_WATCH_RIDE],
    finding_late: [REAL_RIDER_WATCH_RIDE, REAL_RIDER_SEARCH_CHECK],
    // no messages poll: rider lib/features/messages/application/messages_controller.dart:166-170 ("nothing polls",
    // messages come on the trip stream), :346-348 (one listing when a chat screen opens)
    waiting: [REAL_RIDER_WATCH_RIDE],
    arrived: [REAL_RIDER_WATCH_RIDE],
    in_trip: [REAL_RIDER_WATCH_RIDE],
    receipt: [REAL_RIDER_WATCH_RIDE],
  },
  driver: {
    // offline: the airport card asks nothing (wanted needs online), so only the badges
    offline_home: [REAL_DRIVER_BADGES],
    online_idle: [REAL_DRIVER_GPS, REAL_DRIVER_AIRPORT, REAL_DRIVER_BADGES, REAL_DRIVER_SURGE],
    to_pickup: [REAL_DRIVER_GPS, REAL_DRIVER_AIRPORT, REAL_DRIVER_ROUTE],
    at_pickup: [REAL_DRIVER_GPS, REAL_DRIVER_AIRPORT, REAL_DRIVER_ROUTE],
    on_trip: [REAL_DRIVER_GPS, REAL_DRIVER_AIRPORT, REAL_DRIVER_ROUTE_DROPOFF],
  },
});

const RIDER_LIST = { id: "reaction GET /rider/trips?kind=scheduled", method: "GET", path: "/rider/trips?kind=scheduled&limit=100" };
const RIDER_ACTIVE = { id: "reaction GET /rider/trips/active", method: "GET", path: "/rider/trips/active" };
const RIDER_BANNER = { id: "reaction GET /rider/trips?booked-banner", method: "GET", path: "/rider/trips?kind=scheduled&status=driver_to_pickup&status=arrived" };
const DRIVER_AIRPORT_HINT = { id: "reaction GET /driver/airport-queue", method: "GET", path: "/driver/airport-queue" };

export const REACTIONS_REAL = Object.freeze({
  rider: {
    rider_trip_changed: {
      // Home / Choose: the booked list + the active trip (2); a ride screen: the list, and the banner only with a
      // booked ride (so 1 for the load riders).
      requests: (state, phone) => [RIDER_LIST, ...(state === "home" || state === "choose" ? [RIDER_ACTIVE] : phone?.hasBookedRide ? [RIDER_BANNER] : [])],
      ids: [RIDER_LIST.id, RIDER_ACTIVE.id, RIDER_BANNER.id],
      perEvent: 2,
      minGapSeconds: 0,
      source: "rider rider_trip_watch.dart:130-137 (rider_trip_changed → _refreshList() + check()), :227-238 (check: Home → active trip; ride screen → banner only with a booked ride); lib/features/reservations/data/api_reservation_repository.dart:35 (list path)",
    },
  },
  driver: {
    driver_reservations_changed: { ...REACTIONS.driver.driver_reservations_changed, source: "driver lib/core/live/reservations_refresh.dart:9-11 (at most once per 2 s), lib/core/live/live_reservations.dart:19-35 (open + accepted)" },
    airport_queue_changed: {
      requests: () => [DRIVER_AIRPORT_HINT],
      ids: [DRIVER_AIRPORT_HINT.id],
      perEvent: 1,
      minGapSeconds: 5,
      only: "online_near_airport",
      when: onlineNearAirport,
      source: "driver lib/core/live/live_driver_config.dart:609-611 (airport_queue_changed → hint), lib/core/airport/airport_queue.dart:76 (hintGap 5 s), :161 (hint), :163-166 (asks only while wanted)",
    },
  },
});

/** The tables LOADTEST_CADENCE can pick. "old" (the default) = the table above; "real" = S4e. */
export const CADENCE_TABLES = Object.freeze({
  old: Object.freeze({ name: "old", cadences: CADENCES, reactions: REACTIONS, onEnter: ON_ENTER }),
  real: Object.freeze({ name: "real", cadences: CADENCES_REAL, reactions: REACTIONS_REAL, onEnter: ON_ENTER }),
});

/** LOADTEST_CADENCE → table. Unset or empty = "old"; an unknown name is refused (no silent fallback). */
export function cadenceTable(name) {
  const key = name == null || name === "" ? "old" : String(name);
  const table = CADENCE_TABLES[key];
  if (!table) throw new LoadtestGuardError(`LOADTEST_CADENCE must be one of ${Object.keys(CADENCE_TABLES).join(", ")}, got "${key}"`);
  return table;
}

const perMinute = (e) => (60 / e.every) * (e.batch ? e.batch.length : 1);

/**
 * Requests per minute one phone sends in `state` from its timers (the request budget of that state). Entries behind a
 * condition (`when`, e.g. the airport poll) are not in the budget: they apply to some phones only.
 */
export function budgetPerMinute(app, state, table = CADENCE_TABLES.old) {
  const out = {};
  for (const e of table.cadences[app][state] ?? []) if (!e.when) out[e.id] = perMinute(e);
  return out;
}

/** The whole table as rows (for the report and the step-60 proof). */
export function cadenceRows(table = CADENCE_TABLES.old) {
  const rows = [];
  for (const [app, states] of Object.entries(table.cadences)) for (const [state, entries] of Object.entries(states)) for (const e of entries) rows.push({ app, state, id: e.id, everySeconds: e.every, perMinute: Number(perMinute(e).toFixed(2)), ...(e.only ? { only: e.only } : {}), source: e.source });
  return rows;
}
