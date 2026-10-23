import { buildApp } from "./app.js";
import { createDb, createPool, type Db } from "./db/db.js";
import { migrate } from "./db/migrate.js";
import { readEnv } from "./env.js";
import { ensureMaintenanceTimers, maintenanceHandlers } from "./jobs/maintenance.js";
import { TimerWorker } from "./jobs/timers.js";

const env = readEnv();

let db: Db | undefined;
let worker: TimerWorker | undefined;
// Until the server's logger exists, a dropped connection is reported on stderr.
let warn = (error: Error) => console.warn("database connection dropped:", error.message);

if (env.DATABASE_URL !== undefined) {
  const pool = createPool(env.DATABASE_URL, env.DATABASE_POOL_MAX, (error) => warn(error));
  if (env.MIGRATE_ON_START) await migrate(pool);
  db = createDb(pool);
}

const app = await buildApp({ env, db });
warn = (error) => app.log.warn({ err: error }, "database connection dropped");

if (db !== undefined) {
  await ensureMaintenanceTimers(db);
  worker = new TimerWorker(db, { handlers: { ...maintenanceHandlers }, logger: app.log });
  worker.start();
} else {
  app.log.warn("DATABASE_URL is not set: running without a database (development only)");
}

const close = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await worker?.stop();
  await db?.destroy();
  process.exit(0);
};
process.once("SIGINT", () => void close("SIGINT"));
process.once("SIGTERM", () => void close("SIGTERM"));

await app.listen({ host: env.HOST, port: env.PORT });
