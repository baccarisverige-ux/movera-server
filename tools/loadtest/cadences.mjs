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
// as Dart's Timer.periodic). Budgets are steady-state rates: a stay of T seconds is off by up to every/(2T).

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

/** Requests per minute one phone sends in `state` from its timers (the request budget of that state). */
export function budgetPerMinute(app, state) {
  const out = {};
  for (const e of CADENCES[app][state] ?? []) out[e.id] = (60 / e.every) * (e.batch ? e.batch.length : 1);
  return out;
}

/** The whole table as rows (for the report and the step-60 proof). */
export function cadenceRows() {
  const rows = [];
  for (const [app, states] of Object.entries(CADENCES)) for (const [state, entries] of Object.entries(states)) for (const e of entries) rows.push({ app, state, id: e.id, everySeconds: e.every, perMinute: Number(((60 / e.every) * (e.batch ? e.batch.length : 1)).toFixed(2)), source: e.source });
  return rows;
}
