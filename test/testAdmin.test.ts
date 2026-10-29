import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readEnv } from "../src/env.js";
import { prepareTestWeek } from "../src/testWeek.js";
import { freshDatabase, type TestDatabase } from "./support/db.js";

/** Owner decision 2026-10-29: a second Super admin (ADMIN_TEST_EMAIL) for automated checks on staging. */

let database: TestDatabase;
const now = new Date("2026-10-29T08:00:00Z");
const envInput = {
  MOVERA_ENV: "staging",
  DATABASE_URL: "postgres://unused@localhost/x",
  JWT_SECRET: "test-admin-secret".padEnd(48, "t"),
  ADMIN_BOOTSTRAP_EMAIL: "owner@example.com",
  ADMIN_TEST_EMAIL: "Checks@Example.com",
  ADMIN_TEST_NAME: "Staging checks",
  ADMIN_PANEL_URL: "https://owner.example.com/admin/",
};
const env = readEnv(envInput);
const testAdmin = () => database.db.selectFrom("admins").select(["admin_id", "email", "name", "role", "password_hash"]).where("email", "=", "checks@example.com");

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

describe("test admin at start", () => {
  it("makes a second Super admin and writes its password link to the log", async () => {
    const log = logger();
    await prepareTestWeek(database.db, env, log, { now });
    const testLines = log.lines.filter((l) => l.data["admin"] === "test");
    expect(testLines.map((l) => l.message)).toEqual(["admin password link (open it to choose the password)"]);
    expect(String(testLines[0]!.data["setupLink"])).toMatch(/^https:\/\/owner\.example\.com\/admin\/setup-password#token=/);
    expect(await testAdmin().executeTakeFirstOrThrow()).toMatchObject({ email: "checks@example.com", name: "Staging checks", role: "super" });
    expect((await database.db.selectFrom("admins").select("email").execute()).length).toBe(2);
  });

  it("keeps the existing admin and writes nothing on the next start, nor once a password is set", async () => {
    const before = await testAdmin().executeTakeFirstOrThrow();
    const log = logger();
    await prepareTestWeek(database.db, env, log, { now: new Date(now.getTime() + 3600_000) });
    expect(log.lines).toEqual([]);
    expect((await testAdmin().executeTakeFirstOrThrow()).admin_id).toBe(before.admin_id);
    await database.db.updateTable("admins").set({ password_hash: "$argon2id$v=19$m=19456,t=2,p=1$placeholder$placeholder" }).where("admin_id", "=", before.admin_id).execute();
    const later = logger();
    await prepareTestWeek(database.db, env, later, { now: new Date(now.getTime() + 100 * 3600_000) });
    expect(later.lines.filter((l) => l.data["admin"] === "test")).toEqual([]);
  });

  it("ADMIN_TEST_PASSWORD_RESET writes one new link for the test admin only, once per value", async () => {
    const at = new Date(now.getTime() + 101 * 3600_000);
    const reset = readEnv({ ...envInput, ADMIN_TEST_PASSWORD_RESET: "2026-10-29" });
    const log = logger();
    await prepareTestWeek(database.db, reset, log, { now: at });
    expect(log.lines.map((l) => [l.data["admin"], l.message])).toEqual([["test", "admin password reset link (open it to choose a new password)"]]);
    const again = logger();
    await prepareTestWeek(database.db, reset, again, { now: at });
    expect(again.lines).toEqual([]);
  });

  it("is refused in production", () => {
    const base = { MOVERA_ENV: "production", DATABASE_URL: "postgres://x@y/z", JWT_SECRET: "p".repeat(40), DOCUMENT_FILES_KEY: Buffer.alloc(32).toString("base64") };
    expect(() => readEnv({ ...base, ADMIN_TEST_EMAIL: "checks@example.com" })).toThrow(/ADMIN_TEST_EMAIL/);
  });
});
