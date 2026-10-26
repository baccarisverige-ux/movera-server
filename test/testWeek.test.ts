import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readEnv } from "../src/env.js";
import { prepareTestWeek } from "../src/testWeek.js";
import { freshDatabase, type TestDatabase } from "./support/db.js";

/** Render's free plan has no shell: the test week's accounts, settings and first admin come at start instead. */

let database: TestDatabase;
const now = new Date("2026-10-26T08:00:00Z");
const envInput = {
  MOVERA_ENV: "staging",
  DATABASE_URL: "postgres://unused@localhost/x",
  JWT_SECRET: "test-week-secret".padEnd(48, "t"),
  SEED_TEST_ON_START: "true",
  ADMIN_BOOTSTRAP_EMAIL: "Owner@Movera.test",
  ADMIN_BOOTSTRAP_NAME: "Owner",
  ADMIN_PANEL_URL: "https://owner.github.io/Admin-panel/live/",
};
const env = readEnv(envInput);

function logger() {
  const lines: { data: Record<string, unknown>; message: string }[] = [];
  return { lines, info: (data: Record<string, unknown>, message: string) => void lines.push({ data, message }) };
}

beforeAll(async () => {
  database = await freshDatabase();
});
afterAll(async () => {
  await database.drop();
});

describe("test week at start", () => {
  it("makes the accounts, the sample settings and the admin's password link on the first start", async () => {
    const log = logger();
    await prepareTestWeek(database.db, env, log, { now });
    expect(log.lines.map((l) => l.message)).toEqual([
      "test accounts made (sign in with code 1234)",
      "sample settings published",
      "admin password link (open it to choose the password)",
    ]);
    expect(String(log.lines[2]!.data["setupLink"])).toMatch(/^https:\/\/owner\.github\.io\/Admin-panel\/live\/setup-password#token=/);
    const admin = await database.db.selectFrom("admins").select(["email", "role"]).executeTakeFirstOrThrow();
    expect(admin).toEqual({ email: "owner@movera.test", role: "super" });
    expect((await database.db.selectFrom("config_live").select("doc").where("doc", "=", "pricing").execute()).length).toBeGreaterThan(0);
  });

  it("changes nothing when the server wakes again: a tester's change stays and the open link is not replaced", async () => {
    await database.db.updateTable("drivers").set({ first_name: "Renamed" }).where("phone", "=", "+46701740606").execute();
    const log = logger();
    await prepareTestWeek(database.db, env, log, { now: new Date(now.getTime() + 3600_000) });
    expect(log.lines).toEqual([]);
    const driver = await database.db.selectFrom("drivers").select("first_name").where("phone", "=", "+46701740606").executeTakeFirstOrThrow();
    expect(driver.first_name).toBe("Renamed");
    expect((await database.db.selectFrom("admin_setup_links").selectAll().execute()).length).toBe(1);
  });

  it("gives drivers seeded by an earlier server every open zone, once", async () => {
    await database.db.updateTable("drivers").set({ zone_ids: ["Z001"] }).where("phone", "=", "+46701740606").execute();
    const log = logger();
    await prepareTestWeek(database.db, env, log, { now });
    expect(log.lines.map((l) => l.message)).toEqual(["test drivers registered in every open zone and category"]);
    const zones = (await database.db.selectFrom("drivers").select("zone_ids").where("phone", "=", "+46701740606").executeTakeFirstOrThrow()).zone_ids;
    expect(zones).toContain("FR-PC");
    const again = logger();
    await prepareTestWeek(database.db, env, again, { now });
    expect(again.lines).toEqual([]);
  });

  it("gives drivers seeded by an earlier server every category, once", async () => {
    await database.db.updateTable("drivers").set({ category_ids: ["economy"] }).where("phone", "=", "+46701740606").execute();
    const log = logger();
    await prepareTestWeek(database.db, env, log, { now });
    expect(log.lines.map((l) => l.message)).toEqual(["test drivers registered in every open zone and category"]);
    const categories = (await database.db.selectFrom("drivers").select("category_ids").where("phone", "=", "+46701740606").executeTakeFirstOrThrow()).category_ids;
    expect(categories).toEqual(expect.arrayContaining(["economy", "comfort", "premium", "priority", "xl", "electric", "pet", "child_seat"]));
    const again = logger();
    await prepareTestWeek(database.db, env, again, { now });
    expect(again.lines).toEqual([]);
  });

  it("writes a new link once the old one has expired and no password was chosen", async () => {
    const log = logger();
    await prepareTestWeek(database.db, env, log, { now: new Date(now.getTime() + 73 * 3600_000) });
    expect(log.lines.map((l) => l.message)).toEqual(["admin password link (open it to choose the password)"]);
  });

  it("forgot password (audit Phase 4, P4-4): ADMIN_PASSWORD_RESET writes one new link even though a password exists, once per value", async () => {
    await database.db.updateTable("admins").set({ password_hash: "$argon2id$v=19$m=19456,t=2,p=1$placeholder$placeholder" }).execute();
    const later = new Date(now.getTime() + 100 * 3600_000);
    const quiet = logger();
    await prepareTestWeek(database.db, env, quiet, { now: later });
    expect(quiet.lines).toEqual([]);
    const reset = readEnv({ ...envInput, ADMIN_PASSWORD_RESET: "2026-10-26 forgot" });
    const log = logger();
    await prepareTestWeek(database.db, reset, log, { now: later });
    expect(log.lines.map((l) => l.message)).toEqual(["admin password reset link (open it to choose a new password)"]);
    expect(String(log.lines[0]!.data["setupLink"])).toMatch(/^https:\/\/owner\.github\.io\/Admin-panel\/live\/setup-password#token=/);
    // The server sleeps and wakes, or the link is used: the same value never makes another link.
    await database.db.updateTable("admin_setup_links").set({ used_at: later }).execute();
    const again = logger();
    await prepareTestWeek(database.db, reset, again, { now: new Date(later.getTime() + 80 * 3600_000) });
    expect(again.lines).toEqual([]);
    // A new value is a new request.
    const next = logger();
    await prepareTestWeek(database.db, readEnv({ ...envInput, ADMIN_PASSWORD_RESET: "second" }), next, { now: later });
    expect(next.lines.map((l) => l.message)).toEqual(["admin password reset link (open it to choose a new password)"]);
  });

  it("is refused in production", () => {
    const base = { MOVERA_ENV: "production", DATABASE_URL: "postgres://x@y/z", JWT_SECRET: "p".repeat(40), DOCUMENT_FILES_KEY: Buffer.alloc(32).toString("base64") };
    expect(() => readEnv({ ...base, SEED_TEST_ON_START: "true" })).toThrow(/SEED_TEST_ON_START/);
    expect(() => readEnv({ ...base, ADMIN_BOOTSTRAP_EMAIL: "a@b.se" })).toThrow(/ADMIN_BOOTSTRAP_EMAIL/);
  });
});
