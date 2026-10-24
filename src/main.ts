import { buildApp } from "./app.js";
import { createDb, createPool, type Db } from "./db/db.js";
import { migrate } from "./db/migrate.js";
import { readEnv } from "./env.js";
import { seedTestPhones } from "./auth/testPhones.js";
import { ensureMaintenanceTimers, maintenanceHandlers } from "./jobs/maintenance.js";
import { TimerWorker } from "./jobs/timers.js";
import { NotificationHub } from "./realtime/hub.js";
import { TRIP_EVENTS_CHANNEL } from "./db/tripLog.js";
import { CONFIG_CHANNEL } from "./config/service.js";

const env = readEnv();

let db: Db | undefined;
let hub: NotificationHub | undefined;
let worker: TimerWorker | undefined;
// Until the server's logger exists, a dropped connection is reported on stderr.
let warn = (error: Error) => console.warn("database connection dropped:", error.message);

if (env.DATABASE_URL !== undefined) {
  const pool = createPool(env.DATABASE_URL, env.DATABASE_POOL_MAX, (error) => warn(error));
  if (env.MIGRATE_ON_START) await migrate(pool);
  db = createDb(pool);
  hub = new NotificationHub(env.DATABASE_URL, [TRIP_EVENTS_CHANNEL, CONFIG_CHANNEL], { warn: (data, message) => warn(Object.assign(new Error(message), data)) });
  await hub.start();
}

const app = await buildApp({ env, db, ...(hub ? { hub } : {}) });
warn = (error) => app.log.warn({ err: error }, "database connection dropped");

if (db !== undefined) {
  await ensureMaintenanceTimers(db);
  // Test numbers exist only outside production (contract §8); production never reads them.
  if (env.MOVERA_ENV !== "production") await seedTestPhones(db);
  worker = new TimerWorker(db, { handlers: { ...maintenanceHandlers }, logger: app.log });
  worker.start();
} else {
  app.log.warn("DATABASE_URL is not set: running without a database (development only)");
}

const close = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await worker?.stop();
  await hub?.stop();
  await db?.destroy();
  process.exit(0);
};
process.once("SIGINT", () => void close("SIGINT"));
process.once("SIGTERM", () => void close("SIGTERM"));

await app.listen({ host: env.HOST, port: env.PORT });
