import { buildWorkerConfig, RESTART_ONCE_KINDS } from "./jobs/workerConfig.js";
import { cacheGeometry, forgetGeometry, GEOMETRY_TTL_MS } from "./config/geometryCache.js";
import type pg from "pg";
import { registerLoadShedding } from "./http/shed.js";
import { configureReadRetry } from "./realtime/retry.js";
import { SMART_SURGE_CHECK, ensurePricingTimers } from "./pricing/surge.js";
import { buildApp } from "./app.js";
import { createDb, createHealthPool, createPool, poolOptionsFrom, type Db } from "./db/db.js";
import { migrate } from "./db/migrate.js";
import { guardProcess, waitForDatabase } from "./db/ready.js";
import { readEnv, startupWarnings } from "./env.js";
import { seedTestPhones, testPhonesFor } from "./auth/testPhones.js";
import { NIGHTLY, SWEEP_IDEMPOTENCY_KEYS, ensureMaintenanceTimers } from "./jobs/maintenance.js";
import { HOUSEKEEPING_KINDS } from "./jobs/housekeeping.js";
import { PAYOUT_CLOSE, PAYOUT_DRIVER } from "./jobs/payouts.js";
import { NO_FIX_OFFLINE, NO_FIX_SWEEP } from "./drivers/presence.js";
import { TimerWorker, rearmParkedRecurringTimers, restartParkedOnce } from "./jobs/timers.js";
import { ALERT_SWEEP, ensureAlertSweep } from "./alerts/detector.js";
import { NotificationHub } from "./realtime/hub.js";
import { OFFER_EVENTS_CHANNEL, TRIP_EVENTS_CHANNEL } from "./db/tripLog.js";
import { setLeaveRouter } from "./reservations/service.js";
import type { Router } from "./maps/routing.js";
import { CONFIG_CHANNEL, cacheLiveDocumentsOn } from "./config/service.js";
import { INCIDENT_EVENTS_CHANNEL } from "./safety/incidents.js";
import { ADMIN_EVENTS_CHANNEL } from "./realtime/adminEvents.js";
import { DISPATCH_EVENTS_CHANNEL } from "./dispatch/feed.js";
import { prepareTestWeek } from "./testWeek.js";
import { pushServicesFrom } from "./push/config.js";
import { PushDispatcher } from "./push/dispatcher.js";
import { onNotify } from "./notifications/service.js";
import { scrubText } from "./telemetry/scrub.js";

const env = readEnv();

// Rule 28: a database error escaping a background promise is logged, never fatal; the logger is the app's once it exists.
let fatalLog: { error: (data: object, message: string) => void } = { error: (data, message) => console.error(message, scrubText((data as { err?: Error }).err?.message ?? "")) };
guardProcess({ error: (data, message) => fatalLog.error(data, message) });

let db: Db | undefined;
// G34 P2: /readyz, /healthz and /healthz/jobs ask the database on their own 2-connection pool, never in the app pool's queue.
let healthDb: Db | undefined;
let pool: pg.Pool | undefined;
let hub: NotificationHub | undefined;
let worker: TimerWorker | undefined;
let pusher: PushDispatcher | undefined;
// Until the server's logger exists, a dropped connection is reported on stderr.
let warn = (error: Error) => console.warn("database connection dropped:", scrubText(error.message));

if (env.DATABASE_URL !== undefined) {
  pool = createPool(env.DATABASE_URL, { ...poolOptionsFrom(env), statementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS }, (error) => warn(error));
  // Rule 28 (Render 2026-11-05: 57P03 while the database restarted): wait up to ~2 min for it, then migrate.
  await waitForDatabase(pool, { log: (data, message) => console.warn(message, JSON.stringify(data)) });
  // B1.4: the migration connection drops the statement limit and uses DATABASE_MIGRATION_LOCK_TIMEOUT_MS instead.
  if (env.MIGRATE_ON_START) await migrate(pool, undefined, { lockTimeoutMs: env.DATABASE_MIGRATION_LOCK_TIMEOUT_MS });
  db = createDb(pool);
  healthDb = createDb(createHealthPool(env.DATABASE_URL));
  hub = new NotificationHub(env.DATABASE_LISTEN_URL ?? env.DATABASE_URL, [TRIP_EVENTS_CHANNEL, CONFIG_CHANNEL, OFFER_EVENTS_CHANNEL, INCIDENT_EVENTS_CHANNEL, DISPATCH_EVENTS_CHANNEL, ADMIN_EVENTS_CHANNEL], { warn: (data, message) => warn(Object.assign(new Error(message), data)) });
  await hub.start();
  // Job 1 (fix plan R23): settings are kept in memory; any config_published (from any instance) empties the cache.
  // B1.8: subscribed before any stream, so one config_published makes one shared read per (doc, zone).
  cacheLiveDocumentsOn(hub);
  // Stress T-A part 3 (RESULT-3.md): zone and airport-area geometry in memory, dropped on every config_published
  // (zone saves send doc "zones") and after 60 s at most (an airport area save on another copy sends no notification).
  hub.subscribe(CONFIG_CHANNEL, () => forgetGeometry());
  cacheGeometry(GEOMETRY_TTL_MS);
}

let log: (message: string) => void = (message) => console.warn(message);
const push = pushServicesFrom(env, { warn: (message) => log(message) });
const app = await buildApp({ env, db, push, ...(hub ? { hub } : {}), ...(healthDb ? { healthDb } : {}) });
log = (message) => app.log.warn(message);
fatalLog = app.log;
// v0.18.56 §78 (G9-2.4): a missing TURN relay is visible in the start-up log.
for (const message of startupWarnings(env)) app.log.warn(message);
// G34 5k item 8: each online driver holds ~2 open streams, so the open-files cap limits drivers per copy. Node raises
// its soft limit to the hard one at start; the hard one is the host's (Render documents none), so it is logged here.
try {
  const line = (await import("node:fs")).readFileSync("/proc/self/limits", "utf8").split("\n").find((l) => l.startsWith("Max open files"));
  const [soft, hard] = (line?.match(/\d+|unlimited/g) ?? []).slice(0, 2);
  if (soft !== undefined) app.log.info({ openFiles: { soft, hard } }, "open files limit");
} catch {
  // Not Linux: nothing to log.
}
warn = (error) => app.log.warn({ err: error }, "database connection dropped");

if (db !== undefined) {
  // S05 A1: a recurring job parked after repeated failures runs again at every start (one warning each).
  // S4 0.14b: every housekeeping job (one timer per clean-up) too.
  // S4 0.14a: the payout timer too, and a driver's payout step parked after repeated failures (tried again after a fix).
  await rearmParkedRecurringTimers(db, [SWEEP_IDEMPOTENCY_KEYS, NIGHTLY, NO_FIX_OFFLINE, NO_FIX_SWEEP, SMART_SURGE_CHECK, ALERT_SWEEP, ...HOUSEKEEPING_KINDS, PAYOUT_CLOSE, PAYOUT_DRIVER], app.log);
  // B1.6b (owner W1 Q70): a trip or safety timer parked before restart-once existed runs once more (once in all).
  await restartParkedOnce(db, RESTART_ONCE_KINDS, app.log);
  await ensureMaintenanceTimers(db);
  await ensurePricingTimers(db);
  // v0.18.23 (contract.json#alertDesk.serverDetection): the server finds the admin alerts every 30 s.
  await ensureAlertSweep(db);
  // Test numbers exist only outside production (contract §8); production never reads them.
  if (env.MOVERA_ENV !== "production") await seedTestPhones(db, testPhonesFor(env));
  await prepareTestWeek(db, env, app.log);
  // Owner (v0.18.19 leaveOnTime): booked rides start from the same live road-route ETA as normal rides.
  setLeaveRouter((app as unknown as { router: Router }).router);
  // Job 1 / stress H1 / B1.7: handlers and lanes (dispatch, trip GPS, general, housekeeping lanes) in jobs/workerConfig.ts.
  const { handlers, lanes, parked } = buildWorkerConfig((app as unknown as { router: Router }).router, { timerLanes: env.TIMER_LANES, dispatchLanes: env.DISPATCH_LANES, housekeepingLanes: env.HOUSEKEEPING_LANES });
  worker = new TimerWorker(db, { ...parked, handlers, logger: app.log, pollMs: 200, lanes });
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
  await healthDb?.destroy();
  process.exit(0);
};
process.once("SIGINT", () => void close("SIGINT"));
process.once("SIGTERM", () => void close("SIGTERM"));

// Job 1 (stress H3): load shedding while the pool queue or the event loop is over its limit (SHED_* settings).
if (pool !== undefined) registerLoadShedding(app, { maxPoolWaiting: env.SHED_POOL_WAITING, maxLoopDelayMs: env.SHED_LOOP_DELAY_MS, poolWaiting: () => pool!.waitingCount });
// B1.9 (Q73): a stream that gave up on its reads is not closed while the pool queue is over SHED_POOL_WAITING (its app would
// reconnect into the busy pool); it draws a new random delay instead.
if (pool !== undefined && env.SHED_POOL_WAITING > 0) configureReadRetry({ holdClose: () => pool!.waitingCount > env.SHED_POOL_WAITING });
await app.listen({ host: env.HOST, port: env.PORT });
