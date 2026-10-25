import { createAdmin, createSetupLink } from "./admin/auth.js";
import { seedSampleConfig } from "./config/seedConfig.js";
import type { Db } from "./db/db.js";
import { DEFAULT_TEST_ACCOUNTS, TEST_FLEET_CODE, seedTestAccounts, type TestAccounts } from "./drivers/seedTest.js";
import type { Env } from "./env.js";

type Log = { info: (data: Record<string, unknown>, message: string) => void };

/**
 * What `seed-test` and `admin create` do, run at start instead, for a host without a shell (Render's free plan).
 * Staging and development only (env.ts refuses these settings in production). Safe on every start, so a server
 * that sleeps and wakes changes nothing: the test accounts are made once (a tester's later changes stay), the
 * sample settings fill only zones that have none, and the admin gets a password link only while it has neither a
 * password nor an unused link.
 */
export async function prepareTestWeek(
  db: Db,
  env: Pick<Env, "MOVERA_ENV" | "SEED_TEST_ON_START" | "ADMIN_BOOTSTRAP_EMAIL" | "ADMIN_BOOTSTRAP_NAME" | "ADMIN_PANEL_URL">,
  log: Log,
  { accounts = DEFAULT_TEST_ACCOUNTS, now = new Date() }: { accounts?: TestAccounts; now?: Date } = {},
): Promise<void> {
  if (env.MOVERA_ENV === "production") return;
  if (env.SEED_TEST_ON_START) {
    await db.transaction().execute(async (trx) => {
      const fleet = await trx.selectFrom("fleets").select("fleet_id").where("code", "=", TEST_FLEET_CODE).executeTakeFirst();
      if (fleet === undefined) {
        const made = await seedTestAccounts(trx, accounts, now);
        log.info({ fleetId: made.fleetId, drivers: made.drivers.length, riders: made.riders.length }, "test accounts made (sign in with code 1234)");
      }
      const settings = await seedSampleConfig(trx, now);
      if (settings.length > 0) log.info({ published: settings.map((s) => `${s.doc}@${s.zoneId}`) }, "sample settings published");
    });
  }
  if (env.ADMIN_BOOTSTRAP_EMAIL !== undefined) {
    const { adminId, created } = await createAdmin(db, { email: env.ADMIN_BOOTSTRAP_EMAIL, name: env.ADMIN_BOOTSTRAP_NAME ?? env.ADMIN_BOOTSTRAP_EMAIL, role: "super" }, now);
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
      log.info({ adminId, created, expiresAt: link.expiresAt, setupLink: link.url }, "admin password link (open it to choose the password)");
    }
  }
}
