import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, migrate } from "../../src/db/migrate.js";
import { splitSql } from "../../src/db/splitSql.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver, insertRider, insertTrip } from "../support/seed.js";

/**
 * G30 migrations 0099 (email_verified_at + drivers.first_activated_at, backfilled) and 0100 (lower(email) indexes,
 * CONCURRENTLY). contract.json#emailVerified.existing (owner Q2: every e-mail kept, only a recorded code check stays
 * Verified) and .neverActive (+ supervisor round 3: an audit row from active, or a trip, also counts).
 */

const FILES = ["0099_email_verified.sql", "0100_email_lower_indexes.sql"];
let database: TestDatabase;
let dir: string;

beforeAll(async () => {
  database = await freshDatabase({ migrated: false });
  dir = mkdtempSync(join(tmpdir(), "movera-g30-"));
  cpSync(MIGRATIONS_DIR, dir, { recursive: true });
});
afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  await database.drop();
});

const q = (text: string, values: unknown[] = []) => database.pool.query(text, values);
const T = (s: string) => new Date(s);

describe("G30 migrations 0099 + 0100", () => {
  it("G30: backfill keeps every e-mail and row; only a proven code check is Verified; first_activated_at from status, audit and trips", async () => {
    const kept = FILES.map((f) => readFileSync(join(MIGRATIONS_DIR, f)));
    for (const f of FILES) rmSync(join(dir, f));
    await migrate(database.pool, dir);

    // Riders.
    const proven = await insertRider(database.db);
    await q("UPDATE riders SET email = 'Ver@Example.se' WHERE rider_id = $1", [proven]);
    await q("INSERT INTO email_changes (challenge_id, actor, subject_id, email, code_sha256, attempts, expires_at, created_at) VALUES ('emc_a', 'rider', $1, 'ver@example.se', 'x', 0, $2, $3)", [proven, T("2026-11-01T10:05:00Z"), T("2026-11-01T10:00:00Z")]);
    await q("INSERT INTO notifications (notification_id, audience, subject_id, kind, title, body, created_at) VALUES ('ntf_a', 'rider', $1, 'email_changed', 't', 'b', $2)", [proven, T("2026-11-01T10:05:00Z")]);
    const plain = await insertRider(database.db);
    await q("UPDATE riders SET email = 'plain@x.se' WHERE rider_id = $1", [plain]);
    // Verified once, then changed by the old code-less PATCH: the current address has no proof.
    const changed = await insertRider(database.db);
    await q("UPDATE riders SET email = 'patched@x.se' WHERE rider_id = $1", [changed]);
    await q("INSERT INTO email_changes (challenge_id, actor, subject_id, email, code_sha256, attempts, expires_at, created_at) VALUES ('emc_b', 'rider', $1, 'proven@x.se', 'x', 0, $2, $2)", [changed, T("2026-11-02T10:00:00Z")]);
    await q("INSERT INTO notifications (notification_id, audience, subject_id, kind, title, body, created_at) VALUES ('ntf_b', 'rider', $1, 'email_changed', 't', 'b', $2)", [changed, T("2026-11-02T10:00:00Z")]);
    // A challenge closed by a newer start (no bell at that instant): no proof.
    const superseded = await insertRider(database.db);
    await q("UPDATE riders SET email = 'sup@x.se' WHERE rider_id = $1", [superseded]);
    await q("INSERT INTO email_changes (challenge_id, actor, subject_id, email, code_sha256, attempts, expires_at, created_at) VALUES ('emc_c', 'rider', $1, 'sup@x.se', 'x', 0, $2, $2)", [superseded, T("2026-11-03T10:00:00Z")]);
    await q("INSERT INTO notifications (notification_id, audience, subject_id, kind, title, body, created_at) VALUES ('ntf_c', 'rider', $1, 'phone_changed', 't', 'b', $2)", [superseded, T("2026-11-03T10:00:00Z")]);
    const noEmail = await insertRider(database.db);

    // Drivers.
    const activeNoAudit = await insertDriver(database.db);
    await q("UPDATE drivers SET account_status = 'active', email = 'Dr@X.se', created_at = $2 WHERE driver_id = $1", [activeNoAudit, T("2026-09-01T00:00:00Z")]);
    const provenDriver = await insertDriver(database.db);
    await q("UPDATE drivers SET email = 'pd@x.se' WHERE driver_id = $1", [provenDriver]);
    await q("INSERT INTO email_changes (challenge_id, actor, subject_id, email, code_sha256, attempts, expires_at, created_at) VALUES ('emc_d', 'driver', $1, 'pd@x.se', 'x', 0, $2, $2)", [provenDriver, T("2026-11-04T10:00:00Z")]);
    await q("INSERT INTO notifications (notification_id, audience, subject_id, kind, title, body, created_at) VALUES ('ntf_d', 'driver', $1, 'email_changed', 't', 'b', $2)", [provenDriver, T("2026-11-04T10:00:00Z")]);
    // The same address proven for a RIDER account does not make this driver verified.
    await q("INSERT INTO email_changes (challenge_id, actor, subject_id, email, code_sha256, attempts, expires_at, created_at) VALUES ('emc_e', 'rider', $1, 'dr@x.se', 'x', 0, $2, $2)", [activeNoAudit, T("2026-11-05T10:00:00Z")]);
    await q("INSERT INTO notifications (notification_id, audience, subject_id, kind, title, body, created_at) VALUES ('ntf_e', 'rider', $1, 'email_changed', 't', 'b', $2)", [activeNoAudit, T("2026-11-05T10:00:00Z")]);
    const onHoldOnce = await insertDriver(database.db);
    await q("UPDATE drivers SET account_status = 'on_hold' WHERE driver_id = $1", [onHoldOnce]);
    await q("INSERT INTO admin_audit (admin_id, action, target_type, target_id, detail, at) VALUES ('adm_1', 'driver.status', 'driver', $1, '{\"from\":\"on_hold\",\"to\":\"active\"}', $2), ('adm_1', 'driver.status', 'driver', $1, '{\"from\":\"active\",\"to\":\"on_hold\"}', $3)", [onHoldOnce, T("2026-10-01T00:00:00Z"), T("2026-10-05T00:00:00Z")]);
    const suspendedFromActive = await insertDriver(database.db);
    await q("UPDATE drivers SET account_status = 'suspended' WHERE driver_id = $1", [suspendedFromActive]);
    await q("INSERT INTO admin_audit (admin_id, action, target_type, target_id, detail, at) VALUES ('adm_1', 'driver.status', 'driver', $1, '{\"from\":\"active\",\"to\":\"suspended\"}', $2)", [suspendedFromActive, T("2026-10-07T00:00:00Z")]);
    const drove = await insertDriver(database.db);
    await q("UPDATE drivers SET account_status = 'suspended' WHERE driver_id = $1", [drove]);
    const someRider = await insertRider(database.db);
    const trip = await insertTrip(database.db, someRider, { status: "completed", driverId: drove });
    await q("UPDATE trips SET created_at = $2 WHERE trip_id = $1", [trip, T("2026-08-15T00:00:00Z")]);
    const neverActive = await insertDriver(database.db);
    await q("UPDATE drivers SET account_status = 'suspended', email = 'na@x.se' WHERE driver_id = $1", [neverActive]);
    await q("INSERT INTO admin_audit (admin_id, action, target_type, target_id, detail, at) VALUES ('adm_1', 'driver.status', 'driver', $1, '{\"from\":\"pending\",\"to\":\"suspended\"}', $2)", [neverActive, T("2026-10-09T00:00:00Z")]);

    const before = {
      riders: (await q("SELECT rider_id, email FROM riders ORDER BY rider_id")).rows,
      drivers: (await q("SELECT driver_id, email FROM drivers ORDER BY driver_id")).rows,
    };
    FILES.forEach((f, i) => writeFileSync(join(dir, f), kept[i]!));
    expect(await migrate(database.pool, dir)).toEqual(FILES);

    // Nothing deleted, no e-mail changed (Rule 21, owner Q2).
    expect((await q("SELECT rider_id, email FROM riders ORDER BY rider_id")).rows).toEqual(before.riders);
    expect((await q("SELECT driver_id, email FROM drivers ORDER BY driver_id")).rows).toEqual(before.drivers);

    const riderVerified = async (id: string) => (await q("SELECT email_verified_at FROM riders WHERE rider_id = $1", [id])).rows[0].email_verified_at as Date | null;
    expect((await riderVerified(proven))?.toISOString()).toBe("2026-11-01T10:05:00.000Z");
    for (const id of [plain, changed, superseded, noEmail]) expect(await riderVerified(id)).toBeNull();

    const driverRow = async (id: string) => (await q("SELECT email_verified_at, first_activated_at FROM drivers WHERE driver_id = $1", [id])).rows[0] as { email_verified_at: Date | null; first_activated_at: Date | null };
    expect((await driverRow(provenDriver)).email_verified_at?.toISOString()).toBe("2026-11-04T10:00:00.000Z");
    expect((await driverRow(provenDriver)).first_activated_at).toBeNull();
    expect(await driverRow(activeNoAudit)).toEqual({ email_verified_at: null, first_activated_at: T("2026-09-01T00:00:00Z") });
    expect((await driverRow(onHoldOnce)).first_activated_at?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect((await driverRow(suspendedFromActive)).first_activated_at?.toISOString()).toBe("2026-10-07T00:00:00.000Z");
    expect((await driverRow(drove)).first_activated_at?.toISOString()).toBe("2026-08-15T00:00:00.000Z");
    expect(await driverRow(neverActive)).toEqual({ email_verified_at: null, first_activated_at: null });

    // 0100: the case-insensitive e-mail indexes exist and are valid; a second run changes nothing.
    const indexes = await q("SELECT c.relname AS name, i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname IN ('riders_email_lower', 'drivers_email_lower') ORDER BY 1");
    expect(indexes.rows).toEqual([{ name: "drivers_email_lower", valid: true }, { name: "riders_email_lower", valid: true }]);
    expect(await migrate(database.pool, dir)).toEqual([]);
  });
  it("G30 fix F1 (Rule 46): 0099 is ALTERs only; the backfill runs in no-transaction 0100, so readers never wait behind it; re-runnable", async () => {
    // 0099: no UPDATE (its ADD COLUMNs hold ACCESS EXCLUSIVE until the file's transaction ends).
    const f99 = readFileSync(join(MIGRATIONS_DIR, FILES[0]!), "utf8");
    const f100 = readFileSync(join(MIGRATIONS_DIR, FILES[1]!), "utf8");
    const code = (sql: string) => splitSql(sql).map((st) => st.replace(/--[^\n]*/g, "").trim()).filter(Boolean);
    expect(code(f99).every((st) => /^ALTER TABLE\b/i.test(st))).toBe(true);
    expect(f100.startsWith("-- movera: no-transaction\n")).toBe(true);
    const kinds = code(f100).map((st) => (/^UPDATE\b/i.test(st) ? "update" : /^CREATE INDEX CONCURRENTLY\b/i.test(st) ? "index" : "other"));
    expect(kinds).toEqual(["update", "update", "update", "update", "index", "index"]);

    // Measured: a backfill made slow (a 1.5 s trigger on the drivers it touches) never blocks a plain read of drivers.
    const slow = await freshDatabase({ migrated: false });
    const slowDir = mkdtempSync(join(tmpdir(), "movera-g30-f1-"));
    let running: Promise<string[]> | undefined;
    try {
      cpSync(MIGRATIONS_DIR, slowDir, { recursive: true });
      for (const f of FILES) rmSync(join(slowDir, f));
      await migrate(slow.pool, slowDir);
      const active = await insertDriver(slow.db);
      await slow.pool.query("UPDATE drivers SET account_status = 'active' WHERE driver_id = $1", [active]);
      await slow.pool.query("CREATE FUNCTION g30_slow() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1.5); RETURN NEW; END $$");
      await slow.pool.query("CREATE TRIGGER g30_slow BEFORE UPDATE ON drivers FOR EACH ROW EXECUTE FUNCTION g30_slow()");
      for (const f of FILES) cpSync(join(MIGRATIONS_DIR, f), join(slowDir, f));
      running = migrate(slow.pool, slowDir);
      let sleeping = false;
      for (let i = 0; i < 200 && !sleeping; i++) {
        sleeping = (await slow.pool.query("SELECT 1 FROM pg_stat_activity WHERE wait_event = 'PgSleep' AND datname = current_database()")).rowCount! > 0;
        if (!sleeping) await new Promise((r) => setTimeout(r, 10));
      }
      expect(sleeping).toBe(true);
      const reader = await slow.pool.connect();
      let readMs = Number.NaN;
      let readError: unknown = null;
      try {
        await reader.query("SET lock_timeout = '300ms'");
        const t = Date.now();
        await reader.query("SELECT count(*) FROM drivers").catch((e: unknown) => (readError = e));
        readMs = Date.now() - t;
      } finally {
        reader.release();
      }
      expect(readError).toBeNull();
      expect(readMs).toBeLessThan(300);
      expect(await running).toEqual(FILES);
      await slow.pool.query("DROP TRIGGER g30_slow ON drivers");
      const row = (await slow.pool.query("SELECT first_activated_at, created_at FROM drivers WHERE driver_id = $1", [active])).rows[0];
      expect(row.first_activated_at).toEqual(row.created_at);

      // Re-runnable (a no-transaction file runs again whole after a failure): every statement again, nothing changes.
      await slow.pool.query("UPDATE drivers SET email = 'again@x.se' WHERE driver_id = $1", [active]);
      for (const st of splitSql(f100)) await slow.pool.query(st);
      expect((await slow.pool.query("SELECT first_activated_at FROM drivers WHERE driver_id = $1", [active])).rows[0].first_activated_at).toEqual(row.first_activated_at);
    } finally {
      await running?.catch(() => undefined);
      rmSync(slowDir, { recursive: true, force: true });
      await slow.drop();
    }
  }, 20_000);
});
