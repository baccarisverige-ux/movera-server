import { parseArgs } from "node:util";
import { readEnv } from "../env.js";
import { createDb, createPool } from "../db/db.js";
import { migrate } from "../db/migrate.js";
import { createAdmin, createSetupLink } from "./auth.js";
import { isAdminRole } from "./permissions.js";
import { seedDriver } from "../drivers/service.js";
import { seedTestAccounts } from "../drivers/seedTest.js";

/**
 * npm run admin -- create --email you@example.com --name "Your Name" [--role super]
 * npm run admin -- link --email you@example.com
 * Creates an admin (or finds the existing one) and prints a one-time link (72 h) to choose the password.
 */
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    email: { type: "string" },
    name: { type: "string" },
    role: { type: "string", default: "super" },
    phone: { type: "string" },
    make: { type: "string" },
    model: { type: "string" },
    year: { type: "string", default: "2020" },
    color: { type: "string" },
    plate: { type: "string" },
    categories: { type: "string", default: "economy" },
    zones: { type: "string" },
  },
});
const command = positionals[0];
const env = readEnv();
if (env.DATABASE_URL === undefined) throw new Error("Set DATABASE_URL first.");
const usage = [
  'npm run admin -- create --email <e-mail> --name "<name>" [--role super]',
  "npm run admin -- link --email <e-mail>",
  'npm run admin -- driver --phone +46701740605 --name Sara --make Volvo --model V60 --color Black --plate ABC123 [--year 2020] [--categories economy,comfort] [--zones Z001,Z002]',
  "npm run admin -- seed-test   (the test week's activated drivers, fleet and riders on the test numbers; not for production)",
].join("\n  ");
const pool = createPool(env.DATABASE_URL, 2);
const db = createDb(pool);
if (command === "seed-test") {
  if (env.MOVERA_ENV === "production") throw new Error("seed-test is for staging and development only.");
  try {
    await migrate(pool);
    const made = await db.transaction().execute((trx) => seedTestAccounts(trx));
    console.log(`test fleet ${made.fleetId} approved, code ${made.code}`);
    for (const d of made.drivers) console.log(`driver ${d.phone} active: ${d.driverId} (car ${d.vehicleId})`);
    for (const r of made.riders) console.log(`rider ${r.phone} active: ${r.riderId}`);
    console.log("sign in with the fixed code from contract.json#auth.testSignIn (1234)");
  } finally {
    await db.destroy();
  }
  process.exit(0);
}
if (command === "driver") {
  const v = values;
  if (!v.phone || !v.name || !v.make || !v.model || !v.color || !v.plate) {
    console.error(`usage:\n  ${usage}`);
    process.exit(1);
  }
  try {
    await migrate(pool);
    const zones = v.zones ? v.zones.split(",") : (await db.selectFrom("zones").select("zone_id").where("open", "=", true).execute()).map((z) => z.zone_id);
    const made = await db.transaction().execute((trx) =>
      seedDriver(trx, { phone: v.phone!, firstName: v.name!, make: v.make!, model: v.model!, year: Number(v.year), color: v.color!, plate: v.plate!, categoryIds: v.categories!.split(","), zoneIds: zones }),
    );
    console.log(`driver ${made.driverId} ready (car ${made.vehicleId}), zones ${zones.join(", ")}`);
  } finally {
    await db.destroy();
  }
  process.exit(0);
}
if ((command !== "create" && command !== "link") || values.email === undefined) {
  console.error(`usage:\n  ${usage}`);
  process.exit(1);
}
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
