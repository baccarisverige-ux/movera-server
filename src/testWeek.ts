import { createHash } from "node:crypto";
import { createAdmin, createSetupLink } from "./admin/auth.js";
import { seedSampleConfig } from "./config/seedConfig.js";
import type { Db } from "./db/db.js";
import { DEFAULT_TEST_ACCOUNTS, TEST_FLEET_CODE, seedTestAccounts, type TestAccounts } from "./drivers/seedTest.js";
import type { Env } from "./env.js";
import { documentKeyFrom } from "./documents/files.js";

type Log = { info: (data: Record<string, unknown>, message: string) => void };

/** Drivers seeded by an earlier server may lack an open zone or a category every test driver has now. */
async function testDriversMissSomething(db: Db | Parameters<typeof seedTestAccounts>[0], accounts: TestAccounts): Promise<boolean> {
  const open = (await db.selectFrom("zones").select("zone_id").where("open", "=", true).execute()).map((z) => z.zone_id);
  const drivers = await db.selectFrom("drivers").select(["zone_ids", "category_ids", "phone"]).where("phone", "in", accounts.drivers.map((d) => d.phone)).execute();
  return drivers.some((d) => {
    const wanted = accounts.drivers.find((a) => a.phone === d.phone)?.car.categoryIds ?? [];
    return open.some((z) => !d.zone_ids.includes(z)) || wanted.some((c) => !d.category_ids.includes(c));
  });
}

/**
 * What `seed-test` and `admin create` do, run at start instead, for a host without a shell (Render's free plan).
 * Staging and development only (env.ts refuses these settings in production). Safe on every start, so a server
 * that sleeps and wakes changes nothing: the test accounts are made once (a tester's later changes stay), the
 * sample settings fill only zones that have none, and the admin gets a password link only while it has neither a
 * password nor an unused link.
 */
export async function prepareTestWeek(
  db: Db,
  env: Pick<Env, "MOVERA_ENV" | "SEED_TEST_ON_START" | "ADMIN_BOOTSTRAP_EMAIL" | "ADMIN_BOOTSTRAP_NAME" | "ADMIN_PANEL_URL"> &
    Partial<Pick<Env, "ADMIN_PASSWORD_RESET" | "ADMIN_TEST_EMAIL" | "ADMIN_TEST_NAME" | "ADMIN_TEST_PASSWORD_RESET" | "DOCUMENT_FILES_KEY" | "JWT_SECRET">>,
  log: Log,
  { accounts = DEFAULT_TEST_ACCOUNTS, now = new Date() }: { accounts?: TestAccounts; now?: Date } = {},
): Promise<void> {
  if (env.MOVERA_ENV === "production") return;
  // v0.18.164: seeded file documents get a placeholder file sealed with the server's own key (only a fixed key: a random dev key would not open after a restart).
  const documentKey = env.DOCUMENT_FILES_KEY !== undefined || env.JWT_SECRET !== undefined ? documentKeyFrom(env, env.JWT_SECRET ?? "") : undefined;
  if (env.SEED_TEST_ON_START) {
    await db.transaction().execute(async (trx) => {
      const fleet = await trx.selectFrom("fleets").select("fleet_id").where("code", "=", TEST_FLEET_CODE).executeTakeFirst();
      if (fleet === undefined) {
        const made = await seedTestAccounts(trx, accounts, now, documentKey);
        log.info({ fleetId: made.fleetId, drivers: made.drivers.length, riders: made.riders.length }, "test accounts made (sign in with the fixed code of contract.json#auth.testSignIn)");
      } else if (await testDriversMissSomething(trx, accounts)) {
        // Accounts seeded by an earlier server worked one zone or a few categories only: give them every open zone
        // and every category (names, cars and documents are set again to the same values).
        const made = await seedTestAccounts(trx, accounts, now, documentKey);
        log.info({ drivers: made.drivers.length }, "test drivers registered in every open zone and category");
      }
      const settings = await seedSampleConfig(trx, now);
      if (settings.length > 0) log.info({ published: settings.map((s) => `${s.doc}@${s.zoneId}`) }, "sample settings published");
    });
  }
  if (env.ADMIN_BOOTSTRAP_EMAIL !== undefined) {
    await prepareSuperAdmin(db, env, log, now, { email: env.ADMIN_BOOTSTRAP_EMAIL, name: env.ADMIN_BOOTSTRAP_NAME, reset: env.ADMIN_PASSWORD_RESET });
  }
  if (env.ADMIN_TEST_EMAIL !== undefined) {
    // A second Super admin for automated checks on staging (owner decision 2026-10-29), made the same way.
    await prepareSuperAdmin(db, env, log, now, { email: env.ADMIN_TEST_EMAIL, name: env.ADMIN_TEST_NAME, reset: env.ADMIN_TEST_PASSWORD_RESET, which: "test" });
  }
}

/**
 * Makes this Super admin if it does not exist (an existing one is kept as it is) and writes its password link to the
 * log while it has neither a password nor an unused link; `reset` asks for one new link even though a password exists.
 */
async function prepareSuperAdmin(
  db: Db,
  env: Pick<Env, "ADMIN_PANEL_URL">,
  log: Log,
  now: Date,
  { email, name, reset, which }: { email: string; name: string | undefined; reset: string | undefined; which?: "test" },
): Promise<void> {
  const label = which === undefined ? {} : { admin: which };
  const { adminId, created } = await createAdmin(db, { email, name: name ?? email, role: "super" }, now);
  const admin = await db.selectFrom("admins").select("password_hash").where("admin_id", "=", adminId).executeTakeFirstOrThrow();
  const openLink = await db
    .selectFrom("admin_setup_links")
    .select("admin_id")
    .where("admin_id", "=", adminId)
    .where("used_at", "is", null)
    .where("expires_at", ">", now)
    .executeTakeFirst();
  if (admin.password_hash === null && openLink === undefined) {
    const link = await createSetupLink({ db, jwtSecret: "unused-by-links", panelUrl: env.ADMIN_PANEL_URL, clock: () => now }, adminId, "bootstrap");
    log.info({ ...label, adminId, created, expiresAt: link.expiresAt, setupLink: link.url }, "admin password link (open it to choose the password)");
  } else if (reset !== undefined && admin.password_hash !== null) {
    // Forgot password: one link per reset value (the value's hash marks the link that answered it).
    const by = `reset:${createHash("sha256").update(reset).digest("hex").slice(0, 32)}`;
    const answered = await db.selectFrom("admin_setup_links").select("admin_id").where("admin_id", "=", adminId).where("created_by", "=", by).executeTakeFirst();
    if (answered === undefined) {
      const link = await createSetupLink({ db, jwtSecret: "unused-by-links", panelUrl: env.ADMIN_PANEL_URL, clock: () => now }, adminId, by);
      log.info({ ...label, adminId, expiresAt: link.expiresAt, setupLink: link.url }, "admin password reset link (open it to choose a new password)");
    }
  }
}
