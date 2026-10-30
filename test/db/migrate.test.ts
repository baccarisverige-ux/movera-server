import { cpSync, mkdtempSync, appendFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, migrate } from "../../src/db/migrate.js";
import { createPool } from "../../src/db/db.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver, insertRider, insertTrip } from "../support/seed.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function emptyDb(): Promise<TestDatabase> {
  const database = await freshDatabase({ migrated: false });
  cleanups.push(database.drop);
  return database;
}

function copyOfMigrations(): string {
  const dir = mkdtempSync(join(tmpdir(), "movera-migrations-"));
  cpSync(MIGRATIONS_DIR, dir, { recursive: true });
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function tables(database: TestDatabase): Promise<string[]> {
  const result = await database.pool.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename");
  return result.rows.map((row) => row.tablename);
}

describe("migrate", () => {
  it("applies every migration once; a second run applies nothing", async () => {
    const database = await emptyDb();
    expect(await migrate(database.pool)).toEqual(["0001_foundation.sql", "0002_auth.sql", "0003_admin.sql", "0004_config.sql", "0005_quotes.sql", "0006_trips.sql", "0007_drivers.sql", "0008_dispatch.sql", "0009_ride.sql", "0010_admin.sql", "0011_onboarding.sql", "0012_invitations.sql", "0013_trip_messages.sql", "0014_zones_stockholm_paris.sql", "0015_stockholm_south.sql", "0016_driver_silent_alert.sql", "0017_paris_ile_de_france.sql", "0018_document_upload_attempts.sql", "0019_telemetry.sql", "0020_earnings_trip_index.sql", "0021_incidents.sql", "0021_price_extras.sql", "0022_settings_flow.sql", "0023_pricing_v071.sql", "0024_surge_samples.sql", "0025_realdata.sql", "0026_content.sql", "0027_kpi_money.sql", "0028_zones.sql", "0029_ride_checks.sql", "0030_chat.sql", "0031_sign_in_waitlist.sql", "0032_error_groups.sql", "0033_onboarding_settings.sql", "0034_complete_previews.sql", "0035_car_base_year.sql", "0036_push_sent.sql", "0037_driver_home.sql"]);
    expect(await migrate(database.pool)).toEqual([]);
    expect(await tables(database)).toEqual(
      ["admin_audit", "admin_setup_links", "admin_sign_in_failures", "admins", "approvals", "auth_link_tokens", "auth_provider_links", "auth_sessions", "categories", "complete_previews", "config_drafts", "config_history", "config_live", "content_items", "dispatch_controls", "dispatch_events", "document_files", "document_notices", "document_upload_attempts", "documents", "driver_cancels", "driver_locations", "drivers", "earnings_entries", "error_group_devices", "error_groups", "fleet_invitations", "fleet_join_attempts", "fleets", "idempotency_keys", "incident_events", "incidents", "kpi_days", "notifications", "offer_events", "offers", "otp_sessions", "payouts", "push_devices", "quotes", "ratings", "refresh_tokens", "refunds", "ride_checks", "rider_fees", "riders", "schema_migrations", "searches", "sign_in_waitlist", "sign_in_waitlist_asks", "sign_up_reminders", "smart_surge_state", "sms_outbox", "support_tickets", "surge_samples", "surge_schedules", "telemetry", "terms_acceptances", "test_phones", "ticket_messages", "timers", "trip_events", "trip_locations", "trip_messages", "trips", "vehicles", "wallet_entries", "zones"],
    );
  });

  it("two servers starting together apply it once (advisory lock)", async () => {
    const database = await emptyDb();
    const other = createPool(database.url, 2);
    cleanups.push(() => other.end());
    const [a, b] = await Promise.all([migrate(database.pool), migrate(other)]);
    expect([...a, ...b].sort()).toEqual(["0001_foundation.sql", "0002_auth.sql", "0003_admin.sql", "0004_config.sql", "0005_quotes.sql", "0006_trips.sql", "0007_drivers.sql", "0008_dispatch.sql", "0009_ride.sql", "0010_admin.sql", "0011_onboarding.sql", "0012_invitations.sql", "0013_trip_messages.sql", "0014_zones_stockholm_paris.sql", "0015_stockholm_south.sql", "0016_driver_silent_alert.sql", "0017_paris_ile_de_france.sql", "0018_document_upload_attempts.sql", "0019_telemetry.sql", "0020_earnings_trip_index.sql", "0021_incidents.sql", "0021_price_extras.sql", "0022_settings_flow.sql", "0023_pricing_v071.sql", "0024_surge_samples.sql", "0025_realdata.sql", "0026_content.sql", "0027_kpi_money.sql", "0028_zones.sql", "0029_ride_checks.sql", "0030_chat.sql", "0031_sign_in_waitlist.sql", "0032_error_groups.sql", "0033_onboarding_settings.sql", "0034_complete_previews.sql", "0035_car_base_year.sql", "0036_push_sent.sql", "0037_driver_home.sql"]);
  });

  it("refuses to start when an applied migration was edited", async () => {
    const database = await emptyDb();
    const dir = copyOfMigrations();
    await migrate(database.pool, dir);
    appendFileSync(join(dir, "0001_foundation.sql"), "\n-- edited later\n");
    await expect(migrate(database.pool, dir)).rejects.toThrow(/0001_foundation\.sql changed after it was applied/);
  });

  it("a failing migration leaves nothing half-done", async () => {
    const database = await emptyDb();
    const dir = copyOfMigrations();
    writeFileSync(join(dir, "0099_broken.sql"), "CREATE TABLE half_done (id int);\nSELECT * FROM no_such_table;\n");
    await expect(migrate(database.pool, dir)).rejects.toThrow(/Migration 0099_broken\.sql failed/);
    expect(await tables(database)).not.toContain("half_done");
    const applied = await database.pool.query("SELECT name FROM schema_migrations ORDER BY name");
    expect(applied.rows).toEqual([{ name: "0001_foundation.sql" }, { name: "0002_auth.sql" }, { name: "0003_admin.sql" }, { name: "0004_config.sql" }, { name: "0005_quotes.sql" }, { name: "0006_trips.sql" }, { name: "0007_drivers.sql" }, { name: "0008_dispatch.sql" }, { name: "0009_ride.sql" }, { name: "0010_admin.sql" }, { name: "0011_onboarding.sql" }, { name: "0012_invitations.sql" }, { name: "0013_trip_messages.sql" }, { name: "0014_zones_stockholm_paris.sql" }, { name: "0015_stockholm_south.sql" }, { name: "0016_driver_silent_alert.sql" }, { name: "0017_paris_ile_de_france.sql" }, { name: "0018_document_upload_attempts.sql" }, { name: "0019_telemetry.sql" }, { name: "0020_earnings_trip_index.sql" }, { name: "0021_incidents.sql" }, { name: "0021_price_extras.sql" }, { name: "0022_settings_flow.sql" }, { name: "0023_pricing_v071.sql" }, { name: "0024_surge_samples.sql" }, { name: "0025_realdata.sql" }, { name: "0026_content.sql" }, { name: "0027_kpi_money.sql" }, { name: "0028_zones.sql" }, { name: "0029_ride_checks.sql" }, { name: "0030_chat.sql" }, { name: "0031_sign_in_waitlist.sql" }, { name: "0032_error_groups.sql" }, { name: "0033_onboarding_settings.sql" }, { name: "0034_complete_previews.sql" }, { name: "0035_car_base_year.sql" }, { name: "0036_push_sent.sql" }, { name: "0037_driver_home.sql" }]);
  });
});

describe("schema rules", () => {
  it("a rider has at most one live trip that is not over", async () => {
    const database = await freshDatabase();
    cleanups.push(database.drop);
    const rider = await insertRider(database.db);
    await insertTrip(database.db, rider, { status: "completed" });
    await insertTrip(database.db, rider, { status: "searching" });
    await insertTrip(database.db, rider, { kind: "scheduled", status: "requested" });
    await expect(insertTrip(database.db, rider, { status: "requested" })).rejects.toThrow(/trips_one_live_per_rider/);
  });

  it("a driver has at most one active trip", async () => {
    const database = await freshDatabase();
    cleanups.push(database.drop);
    const driver = await insertDriver(database.db);
    await insertTrip(database.db, await insertRider(database.db), { status: "in_trip", driverId: driver });
    await expect(
      insertTrip(database.db, await insertRider(database.db), { status: "accepted", driverId: driver }),
    ).rejects.toThrow(/trips_one_active_per_driver/);
  });

  it("statuses outside the contract are refused", async () => {
    const database = await freshDatabase();
    cleanups.push(database.drop);
    await expect(insertTrip(database.db, await insertRider(database.db), { status: "teleporting" })).rejects.toThrow(/check constraint/);
  });
});
