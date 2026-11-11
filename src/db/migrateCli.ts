import { readEnv } from "../env.js";
import { createPool } from "./db.js";
import { migrate } from "./migrate.js";

/** npm run migrate: apply new migrations to DATABASE_URL without starting the server. */
const env = readEnv();
if (env.DATABASE_URL === undefined) {
  console.error("Set DATABASE_URL first.");
  process.exit(1);
}
const pool = createPool(env.DATABASE_URL, 1);
try {
  const applied = await migrate(pool, undefined, { lockTimeoutMs: env.DATABASE_MIGRATION_LOCK_TIMEOUT_MS });
  console.log(applied.length ? `applied: ${applied.join(", ")}` : "nothing to apply");
} finally {
  await pool.end();
}
