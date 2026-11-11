import { timerLanes } from "./jobs/timers.js";
import { cacheGeometry, forgetGeometry } from "./config/geometryCache.js";
import type pg from "pg";
import { registerLoadShedding } from "./http/shed.js";
import { RIDE_CHECK_SCAN, rideCheckScanHandler } from "./safety/rideCheckServer.js";
import { SMART_SURGE_CHECK, ensurePricingTimers, pricingHandlers } from "./pricing/surge.js";
import { buildApp } from "./app.js";
import { createDb, createPool, poolOptionsFrom, type Db } from "./db/db.js";
import { migrate } from "./db/migrate.js";
import { guardProcess, waitForDatabase } from "./db/ready.js";
import { readEnv, startupWarnings } from "./env.js";
import { seedTestPhones, testPhonesFor } from "./auth/testPhones.js";
import { NIGHTLY, SWEEP_IDEMPOTENCY_KEYS, ensureMaintenanceTimers, maintenanceHandlers } from "./jobs/maintenance.js";
import { NO_FIX_OFFLINE } from "./drivers/presence.js";
import { TimerWorker, rearmParkedRecurringTimers } from "./jobs/timers.js";
import { ALERT_SWEEP, alertSweepHandler, ensureAlertSweep } from "./alerts/detector.js";
import { NotificationHub } from "./realtime/hub.js";
import { OFFER_EVENTS_CHANNEL, TRIP_EVENTS_CHANNEL } from "./db/tripLog.js";
import { dispatchHandlers, ROUND, WITHDRAW } from "./dispatch/runtime.js";
import { RADAR_ZONE_REPEAT, radarZoneRepeatHandler } from "./dispatch/tools.js";
import { rideHandlers } from "./trips/ride.js";
import { callHandlers } from "./calls/service.js";
import { etaHandler, TRIP_ETA } from "./trips/eta.js";
import { setLeaveRouter } from "./reservations/service.js";
import type { Router } from "./maps/routing.js";
import { CONFIG_CHANNEL, cacheLiveDocuments, forgetLiveDocuments } from "./config/service.js";
import { INCIDENT_EVENTS_CHANNEL } from "./safety/incidents.js";
import { ADMIN_EVENTS_CHANNEL } from "./realtime/adminEvents.js";
import { DISPATCH_EVENTS_CHANNEL } from "./dispatch/feed.js";
import { prepareTestWeek } from "./testWeek.js";
import { pushServicesFrom } from "./push/config.js";
import { PushDispatcher } from "./push/dispatcher.js";
import { onNotify } from "./notifications/service.js";

const env = readEnv();

// Rule 28: a database error escaping a background promise is logged, never fatal; the logger is the app's once it exists.
let fatalLog: { error: (data: object, message: string) => void } = { error: (data, message) => console.error(message, (data as { err?: Error }).err?.message ?? "") };
guardProcess({ error: (data, message) => fatalLog.error(data, message) });

let db: Db | undefined;
let pool: pg.Pool | undefined;
let hub: NotificationHub | undefined;
let worker: TimerWorker | undefined;
let pusher: PushDispatcher | undefined;
// Until the server's logger exists, a dropped connection is reported on stderr.
let warn = (error: Error) => console.warn("database connection dropped:", error.message);

if (env.DATABASE_URL !== undefined) {
  pool = createPool(env.DATABASE_URL, { ...poolOptionsFrom(env), statementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS }, (error) => warn(error));
  // Rule 28 (Render 2026-11-05: 57P03 while the database restarted): wait up to ~2 min for it, then migrate.
  await waitForDatabase(pool, { log: (data, message) => console.warn(message, JSON.stringify(data)) });
  if (env.MIGRATE_ON_START) await migrate(pool);
  db = createDb(pool);
  hub = new NotificationHub(env.DATABASE_LISTEN_URL ?? env.DATABASE_URL, [TRIP_EVENTS_CHANNEL, CONFIG_CHANNEL, OFFER_EVENTS_CHANNEL, INCIDENT_EVENTS_CHANNEL, DISPATCH_EVENTS_CHANNEL, ADMIN_EVENTS_CHANNEL], { warn: (data, message) => warn(Object.assign(new Error(message), data)) });
  await hub.start();
  // Job 1 (fix plan R23): settings are kept in memory; any config_published (from any instance) empties the cache.
  hub.subscribe(CONFIG_CHANNEL, () => forgetLiveDocuments());
  cacheLiveDocuments(15_000);
  // Stress T-A part 3 (RESULT-3.md): zone and airport-area geometry in memory, dropped on every config_published
  // (zone saves send doc "zones") and after 60 s at most (an airport area save on another copy sends no notification).
  hub.subscribe(CONFIG_CHANNEL, () => forgetGeometry());
  cacheGeometry(60_000);
}

let log: (message: string) => void = (message) => console.warn(message);
const push = pushServicesFrom(env, { warn: (message) => log(message) });
const app = await buildApp({ env, db, push, ...(hub ? { hub } : {}) });
log = (message) => app.log.warn(message);
fatalLog = app.log;
// v0.18.56 §78 (G9-2.4): a missing TURN relay is visible in the start-up log.
for (const message of startupWarnings(env)) app.log.warn(message);
warn = (error) => app.log.warn({ err: error }, "database connection dropped");

if (db !== undefined) {
  // S05 A1: a recurring job parked after repeated failures runs again at every start (one warning each).
  await rearmParkedRecurringTimers(db, [SWEEP_IDEMPOTENCY_KEYS, NIGHTLY, NO_FIX_OFFLINE, SMART_SURGE_CHECK, ALERT_SWEEP], app.log);
  await ensureMaintenanceTimers(db);
  await ensurePricingTimers(db);
  // v0.18.23 (contract.json#alertDesk.serverDetection): the server finds the admin alerts every 30 s.
  await ensureAlertSweep(db);
  // Test numbers exist only outside production (contract §8); production never reads them.
  if (env.MOVERA_ENV !== "production") await seedTestPhones(db, testPhonesFor(env));
  await prepareTestWeek(db, env, app.log);
  // Owner (v0.18.19 leaveOnTime): booked rides start from the same live road-route ETA as normal rides.
  setLeaveRouter((app as unknown as { router: Router }).router);
  // Job 1 (fast dispatch): one lane only for dispatch rounds and withdrawals, the others for any timer (TIMER_LANES).
  // Stress H1: trip GPS work (ETA, ride check, near drop-off) has its own lane and never takes the other lanes, so it
  // can never starve dispatch; general lanes take everything else (dispatch too, when it is busy).
  const tripKinds = [TRIP_ETA, RIDE_CHECK_SCAN, "near_dropoff"];
  const lanes = timerLanes({ dispatchKinds: [ROUND, WITHDRAW], tripKinds, timerLanes: env.TIMER_LANES, dispatchLanes: env.DISPATCH_LANES });
  worker = new TimerWorker(db, { handlers: { ...maintenanceHandlers, ...dispatchHandlers, [RADAR_ZONE_REPEAT]: radarZoneRepeatHandler, ...rideHandlers, ...callHandlers, ...pricingHandlers, [ALERT_SWEEP]: alertSweepHandler, [TRIP_ETA]: etaHandler((app as unknown as { router: Router }).router), [RIDE_CHECK_SCAN]: rideCheckScanHandler((app as unknown as { router: Router }).router) }, logger: app.log, pollMs: 200, lanes });
  worker.start();
  // Push (contract v0.18.3 R7): every bell notice also goes to the phone, after its command committed.
  if (push.sender !== undefined) {
    pusher = new PushDispatcher(db, push.sender, { logger: app.log });
    onNotify(() => pusher?.kick());
    pusher.start();
    app.log.info("push sending is on");
  } else {
    app.log.info({ push: push.status }, "push sending is off (no usable FIREBASE_SERVICE_ACCOUNT)");
  }
} else {
  app.log.warn("DATABASE_URL is not set: running without a database (development only)");
}

const close = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await worker?.stop();
  await pusher?.stop();
  await hub?.stop();
  await db?.destroy();
  process.exit(0);
};
process.once("SIGINT", () => void close("SIGINT"));
process.once("SIGTERM", () => void close("SIGTERM"));

// Job 1 (stress H3): load shedding while the pool queue or the event loop is over its limit (SHED_* settings).
if (pool !== undefined) registerLoadShedding(app, { maxPoolWaiting: env.SHED_POOL_WAITING, maxLoopDelayMs: env.SHED_LOOP_DELAY_MS, poolWaiting: () => pool!.waitingCount });
await app.listen({ host: env.HOST, port: env.PORT });
