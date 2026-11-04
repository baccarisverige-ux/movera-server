import { RIDE_CHECK_SCAN, rideCheckScanHandler } from "./safety/rideCheckServer.js";
import { ensurePricingTimers, pricingHandlers } from "./pricing/surge.js";
import { buildApp } from "./app.js";
import { createDb, createPool, type Db } from "./db/db.js";
import { migrate } from "./db/migrate.js";
import { readEnv } from "./env.js";
import { seedTestPhones, testPhonesFor } from "./auth/testPhones.js";
import { ensureMaintenanceTimers, maintenanceHandlers } from "./jobs/maintenance.js";
import { TimerWorker } from "./jobs/timers.js";
import { ALERT_SWEEP, alertSweepHandler, ensureAlertSweep } from "./alerts/detector.js";
import { NotificationHub } from "./realtime/hub.js";
import { OFFER_EVENTS_CHANNEL, TRIP_EVENTS_CHANNEL } from "./db/tripLog.js";
import { dispatchHandlers } from "./dispatch/runtime.js";
import { RADAR_ZONE_REPEAT, radarZoneRepeatHandler } from "./dispatch/tools.js";
import { rideHandlers } from "./trips/ride.js";
import { etaHandler, TRIP_ETA } from "./trips/eta.js";
import { setLeaveRouter } from "./reservations/service.js";
import type { Router } from "./maps/routing.js";
import { CONFIG_CHANNEL } from "./config/service.js";
import { INCIDENT_EVENTS_CHANNEL } from "./safety/incidents.js";
import { DISPATCH_EVENTS_CHANNEL } from "./dispatch/feed.js";
import { prepareTestWeek } from "./testWeek.js";
import { pushServicesFrom } from "./push/config.js";
import { PushDispatcher } from "./push/dispatcher.js";
import { onNotify } from "./notifications/service.js";

const env = readEnv();

let db: Db | undefined;
let hub: NotificationHub | undefined;
let worker: TimerWorker | undefined;
let pusher: PushDispatcher | undefined;
// Until the server's logger exists, a dropped connection is reported on stderr.
let warn = (error: Error) => console.warn("database connection dropped:", error.message);

if (env.DATABASE_URL !== undefined) {
  const pool = createPool(env.DATABASE_URL, env.DATABASE_POOL_MAX, (error) => warn(error));
  if (env.MIGRATE_ON_START) await migrate(pool);
  db = createDb(pool);
  hub = new NotificationHub(env.DATABASE_URL, [TRIP_EVENTS_CHANNEL, CONFIG_CHANNEL, OFFER_EVENTS_CHANNEL, INCIDENT_EVENTS_CHANNEL, DISPATCH_EVENTS_CHANNEL], { warn: (data, message) => warn(Object.assign(new Error(message), data)) });
  await hub.start();
}

let log: (message: string) => void = (message) => console.warn(message);
const push = pushServicesFrom(env, { warn: (message) => log(message) });
const app = await buildApp({ env, db, push, ...(hub ? { hub } : {}) });
log = (message) => app.log.warn(message);
warn = (error) => app.log.warn({ err: error }, "database connection dropped");

if (db !== undefined) {
  await ensureMaintenanceTimers(db);
  await ensurePricingTimers(db);
  // v0.18.23 (contract.json#alertDesk.serverDetection): the server finds the admin alerts every 30 s.
  await ensureAlertSweep(db);
  // Test numbers exist only outside production (contract §8); production never reads them.
  if (env.MOVERA_ENV !== "production") await seedTestPhones(db, testPhonesFor(env));
  await prepareTestWeek(db, env, app.log);
  // Owner (v0.18.19 leaveOnTime): booked rides start from the same live road-route ETA as normal rides.
  setLeaveRouter((app as unknown as { router: Router }).router);
  worker = new TimerWorker(db, { handlers: { ...maintenanceHandlers, ...dispatchHandlers, [RADAR_ZONE_REPEAT]: radarZoneRepeatHandler, ...rideHandlers, ...pricingHandlers, [TRIP_ETA]: etaHandler((app as unknown as { router: Router }).router), [RIDE_CHECK_SCAN]: rideCheckScanHandler((app as unknown as { router: Router }).router), [ALERT_SWEEP]: alertSweepHandler }, logger: app.log });
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

await app.listen({ host: env.HOST, port: env.PORT });
