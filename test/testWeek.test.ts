import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readEnv } from "../src/env.js";
import { prepareTestWeek } from "../src/testWeek.js";
import { freshDatabase, type TestDatabase } from "./support/db.js";

/** Render's free plan has no shell: the test week's accounts, settings and first admin come at start instead. */

let database: TestDatabase;
const now = new Date("2026-10-26T08:00:00Z");
const env = readEnv({
  MOVERA_ENV: "staging",
  DATABASE_URL: "postgres://unused@localhost/x",
  JWT_SECRET: "test-week-secret".padEnd(48, "t"),
  SEED_TEST_ON_START: "true",
  ADMIN_BOOTSTRAP_EMAIL: "Owner@Movera.test",
  ADMIN_BOOTSTRAP_NAME: "Owner",
  ADMIN_PANEL_URL: "https://owner.github.io/Admin-panel/live/",
});

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

  it("writes a new link once the old one has expired and no password was chosen", async () => {
    const log = logger();
    await prepareTestWeek(database.db, env, log, { now: new Date(now.getTime() + 73 * 3600_000) });
    expect(log.lines.map((l) => l.message)).toEqual(["admin password link (open it to choose the password)"]);
  });

  it("is refused in production", () => {
    const base = { MOVERA_ENV: "production", DATABASE_URL: "postgres://x@y/z", JWT_SECRET: "p".repeat(40), DOCUMENT_FILES_KEY: Buffer.alloc(32).toString("base64") };
    expect(() => readEnv({ ...base, SEED_TEST_ON_START: "true" })).toThrow(/SEED_TEST_ON_START/);
    expect(() => readEnv({ ...base, ADMIN_BOOTSTRAP_EMAIL: "a@b.se" })).toThrow(/ADMIN_BOOTSTRAP_EMAIL/);
  });
});
