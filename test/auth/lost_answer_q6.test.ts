import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAdmin, createSetupLink } from "../../src/admin/auth.js";
import { buildApp } from "../../src/app.js";
import { REFRESH_RETRY_WINDOW_MS, TEST_CODE } from "../../src/auth/service.js";
import { seedTestPhones, TEST_PHONES } from "../../src/auth/testPhones.js";
import { contract } from "../../src/contract/contract.js";
import { readEnv } from "../../src/env.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";

/**
 * Contract v0.18.49 §71, owner Q6 "Accept lost answer" (Rules decisions/session-2026-11-06.md; findings
 * plan/finders-2026-11-07/D.md D9 + D8): an old refresh token whose replacement was never used is a lost answer, not
 * theft. Before v0.18.49 the server ended the session when it came back more than 60 s later (refresh_token_reused).
 */

const LOST = (contract as unknown as { auth: { tokens: { lostAnswer: { rule: string } } } }).auth.tokens.lostAnswer;

let database: TestDatabase;
let app: FastifyInstance;
let copy2: FastifyInstance;
const clock = { now: new Date("2026-11-07T09:00:00Z") };
const advance = (seconds: number) => (clock.now = new Date(clock.now.getTime() + seconds * 1000));
const SECRET = "test-secret-".padEnd(48, "x");
const LATE = REFRESH_RETRY_WINDOW_MS / 1000 + 1; // 61 s: outside the retry window

beforeAll(async () => {
  database = await freshDatabase();
  await seedTestPhones(database.db);
  const env = readEnv({ MOVERA_ENV: "development", DATABASE_URL: database.url, JWT_SECRET: SECRET });
  app = await buildApp({ env, logger: false, db: database.db, clock: () => clock.now });
  // Rule 33: a second server copy on the same database.
  copy2 = await buildApp({ env, logger: false, db: database.db, clock: () => clock.now });
});
afterAll(async () => {
  await app.close();
  await copy2.close();
  await database.drop();
});
beforeEach(() => advance(3600));

const post = (url: string, payload: unknown, server: FastifyInstance = app) =>
  server.inject({ method: "POST", url: `/api/v1${url}`, headers: { "content-type": "application/json" }, payload: payload as object });
const refresh = (refreshToken: string, server: FastifyInstance = app) => post("/auth/refresh", { refreshToken }, server);

async function signIn(phone: string, appName: "rider" | "driver") {
  const challenge = (await post("/auth/otp/request", { phone, app: appName })).json();
  const verify = await post("/auth/otp/verify", { phone, sessionId: challenge.sessionId, code: TEST_CODE });
  expect(verify.statusCode, verify.body).toBe(200);
  return verify.json() as { accessToken: string; refreshToken: string };
}

describe("owner Q6: a lost refresh answer is accepted once, also after 60 s", () => {
  it("the contract says so (auth.tokens.lostAnswer)", () => {
    expect(LOST.rule).toContain("lost answer");
  });

  for (const [label, phone, appName] of [["driver", TEST_PHONES[1]!, "driver"], ["rider", TEST_PHONES[0]!, "rider"]] as const) {
    it(`${label}: answer lost, retry more than 60 s later → a fresh pair, not signed out (fail-before: 401 refresh_token_reused)`, async () => {
      const first = await signIn(phone, appName);
      // R0 → R1, but the answer never reaches the phone (tunnel). The phone keeps R0.
      const lost = await refresh(first.refreshToken);
      expect(lost.statusCode).toBe(200);
      advance(LATE + 120);
      const late = await refresh(first.refreshToken);
      expect(late.statusCode, late.body).toBe(200);
      const fresh = late.json();
      expect(fresh.refreshToken).not.toBe(lost.json().refreshToken);
      // The lost replacement can no longer be used.
      expect((await refresh(lost.json().refreshToken)).json()).toMatchObject({ code: "unauthenticated", reason: "refresh_token_reused" });
    });
  }

  it("after the late answer the 60 s retry window starts again; the new pair works on", async () => {
    const first = await signIn(TEST_PHONES[2]!, "rider");
    await refresh(first.refreshToken); // lost
    advance(LATE + 300);
    expect((await refresh(first.refreshToken)).statusCode).toBe(200); // lost again (accepted once, late)
    advance(10);
    const retry = await refresh(first.refreshToken); // a retry inside the new window
    expect(retry.statusCode, retry.body).toBe(200);
    advance(900);
    const next = await refresh(retry.json().refreshToken);
    expect(next.statusCode, next.body).toBe(200);
  });

  it("ONCE: the same old token late a second time ends the session", async () => {
    const first = await signIn(TEST_PHONES[3]!, "rider");
    await refresh(first.refreshToken); // lost
    advance(LATE + 60);
    const late = await refresh(first.refreshToken);
    expect(late.statusCode).toBe(200);
    advance(LATE + 60);
    const again = await refresh(first.refreshToken);
    expect(again.json()).toMatchObject({ code: "unauthenticated", reason: "refresh_token_reused" });
    expect((await refresh(late.json().refreshToken)).json()).toMatchObject({ code: "unauthenticated", reason: "session_ended" });
  });

  it("theft is still theft: once the replacement WAS used, the old token ends the session (late or not)", async () => {
    const first = await signIn(TEST_PHONES[4]!, "driver");
    const r1 = (await refresh(first.refreshToken)).json();
    advance(5);
    const r2 = (await refresh(r1.refreshToken)).json(); // the replacement is used
    advance(LATE + 60);
    expect((await refresh(first.refreshToken)).json()).toMatchObject({ code: "unauthenticated", reason: "refresh_token_reused" });
    expect((await refresh(r2.refreshToken)).json()).toMatchObject({ code: "unauthenticated", reason: "session_ended" });
  });

  it("Rule 33: the same old token at two server copies at once never leaves two live tokens", async () => {
    const first = await signIn(TEST_PHONES[5]!, "rider");
    await refresh(first.refreshToken); // lost
    advance(LATE + 60);
    const [a, b] = await Promise.all([refresh(first.refreshToken, app), refresh(first.refreshToken, copy2)]);
    expect([a.statusCode, b.statusCode].filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
    const owner = (await database.db.selectFrom("auth_sessions").selectAll().where("actor", "=", "rider").orderBy("created_at", "desc").executeTakeFirstOrThrow());
    expect(owner.revoked_at).toBeNull();
    const live = await database.db.selectFrom("refresh_tokens").select("token_sha256").where("session_id", "=", owner.session_id).where("used_at", "is", null).execute();
    expect(live).toHaveLength(1);
  });

  it("admin (D8, duplicated tab): the second tab's first refresh with the copied token no longer signs both out", async () => {
    const now = clock.now;
    const { adminId } = await createAdmin(database.db, { email: "q6tab@movera.test", name: "Q6 tab", role: "super", zoneIds: null }, now);
    const link = await createSetupLink({ db: database.db, jwtSecret: "unused", panelUrl: "https://admin.example.test", clock: () => now }, adminId, "test");
    const setup = await post("/admin/auth/setup-password", { setupToken: new URL(link.url).hash.replace("#token=", ""), password: "a long test password" });
    expect(setup.statusCode, setup.body).toBe(200);
    const copied = setup.json().refreshToken as string; // both tabs hold it
    advance(880);
    const tabA = await post("/admin/auth/refresh", { refreshToken: copied });
    expect(tabA.statusCode, tabA.body).toBe(200);
    advance(120); // the other tab, two minutes later
    const tabB = await post("/admin/auth/refresh", { refreshToken: copied });
    expect(tabB.statusCode, tabB.body).toBe(200);
  });
});
