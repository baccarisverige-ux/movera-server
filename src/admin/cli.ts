import { parseArgs } from "node:util";
import { readEnv } from "../env.js";
import { createDb, createPool } from "../db/db.js";
import { migrate } from "../db/migrate.js";
import { createAdmin, createSetupLink } from "./auth.js";
import { isAdminRole } from "./permissions.js";

/**
 * npm run admin -- create --email you@example.com --name "Your Name" [--role super]
 * npm run admin -- link --email you@example.com
 * Creates an admin (or finds the existing one) and prints a one-time link (72 h) to choose the password.
 */
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { email: { type: "string" }, name: { type: "string" }, role: { type: "string", default: "super" } },
});
const command = positionals[0];
const env = readEnv();
if (env.DATABASE_URL === undefined) throw new Error("Set DATABASE_URL first.");
if ((command !== "create" && command !== "link") || values.email === undefined) {
  console.error('usage: npm run admin -- create --email <e-mail> --name "<name>" [--role super] | link --email <e-mail>');
  process.exit(1);
}
const pool = createPool(env.DATABASE_URL, 2);
const db = createDb(pool);
try {
  await migrate(pool);
  let adminId: string;
  if (command === "create") {
    if (!isAdminRole(values.role!)) throw new Error(`Unknown role ${values.role}`);
    const made = await createAdmin(db, { email: values.email, name: values.name ?? values.email, role: values.role });
    adminId = made.adminId;
    console.log(made.created ? `created admin ${adminId}` : `admin already exists: ${adminId}`);
  } else {
    const row = await db.selectFrom("admins").select("admin_id").where("email", "=", values.email.trim().toLowerCase()).executeTakeFirst();
    if (row === undefined) throw new Error(`No admin with e-mail ${values.email}`);
    adminId = row.admin_id;
  }
  const link = await createSetupLink({ db, jwtSecret: "unused-by-links", panelUrl: env.ADMIN_PANEL_URL }, adminId, "cli");
  console.log(`setup link (one use, until ${link.expiresAt}):\n${link.url}`);
} finally {
  await db.destroy();
}
