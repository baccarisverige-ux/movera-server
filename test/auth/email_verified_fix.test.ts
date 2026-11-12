import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { EMAIL_LIMITS } from "../../src/auth/accountChange.js";
import type { ProviderVerifier } from "../../src/auth/provider.js";
import { TEST_CODE } from "../../src/auth/service.js";
import { seedTestPhones } from "../../src/auth/testPhones.js";
import { readEnv } from "../../src/env.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";

/**
 * G30 fix round (supervisor NO-GO on a16f4af, audits/impact/server-g30.md "Supervisor check"): the silent answer to an
 * address VERIFIED on another account of the same app must not be told apart from a real start, neither by its time (F2)
 * nor by what a wrong code answers (F4); at most 10 starts per hour count every try (F3, owner answer
 * 2026-11-12, contract line follows as v0.18.77); the Apple / Google path takes the same per-address lock as the code verify (nit c).
 */

let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-11-12T15:00:00Z") };
const advance = (seconds: number) => (clock.now = new Date(clock.now.getTime() + seconds * 1000));
const PHONES = Array.from({ length: 20 }, (_, i) => `+467017409${String(i).padStart(2, "0")}`);
let nextPhone = 0;
const freshPhone = () => PHONES[nextPhone++]!;

/** A fake e-mail service with a real round trip (no outbound call). */
const SEND_MS = 300;
const outbox: string[] = [];
const service = { accept: true };
const email = {
  name: "slow-fake",
  send: async (message: { to: string }) => {
    outbox.push(message.to);
    await new Promise((resolve) => setTimeout(resolve, SEND_MS));
    return { accepted: service.accept, status: service.accept ? 200 : 403 };
  },
};
const google: ProviderVerifier = {
  provider: "google",
  verify: async (idToken) => {
    const [tag, subject, mail] = idToken.split(":");
    if (tag !== "ok" || !subject) throw Object.assign(new Error("bad"), { status: 400 });
    return { subject, email: mail, emailVerified: true, firstName: "Gia" };
  },
};

beforeAll(async () => {
  database = await freshDatabase();
  await seedTestPhones(database.db, PHONES);
  const env = readEnv({ MOVERA_ENV: "staging", DATABASE_URL: database.url, JWT_SECRET: "g30-fix-round".padEnd(48, "f") });
  app = await buildApp({ env, logger: false, db: database.db, clock: () => clock.now, email, providers: { google } } as Parameters<typeof buildApp>[0]);
});
afterAll(async () => {
  await app.close();
  await database.drop();
});
beforeEach(() => {
  advance(2 * 3600);
  outbox.length = 0;
  service.accept = true;
});

const json = (t?: string) => ({ "content-type": "application/json", ...(t ? { authorization: `Bearer ${t}` } : {}) });
const post = (url: string, payload: object, t?: string) => app.inject({ method: "POST", url: `/api/v1${url}`, headers: json(t), payload });
async function signIn(phone: string, appName: "rider" | "driver" = "rider"): Promise<string> {
  advance(60);
  const c = (await post("/auth/otp/request", { phone, app: appName })).json();
  return (await post("/auth/otp/verify", { phone, sessionId: c.sessionId, code: TEST_CODE })).json().accessToken as string;
}
async function holdAddress(address: string): Promise<void> {
  const holder = await signIn(freshPhone());
  const s = (await post("/account/email/change", { email: address }, holder)).json();
  await database.db.updateTable("email_changes").set({ code_sha256: createHash("sha256").update(`${s.challengeId}:4242`).digest("hex") }).where("challenge_id", "=", s.challengeId).execute();
  expect((await post("/account/email/verify", { challengeId: s.challengeId, code: "4242" }, holder)).statusCode).toBe(200);
}
async function timed<T>(run: () => Promise<T>): Promise<[T, number]> {
  const t = performance.now();
  const out = await run();
  return [out, performance.now() - t];
}

describe("G30 fix round: the silent answer looks like a real start", () => {
  it("F2: a start for a taken address takes about as long as a real send", async () => {
    await holdAddress("victim@example.se");
    const attacker = await signIn(freshPhone());
    const [free, freeMs] = await timed(() => post("/account/email/change", { email: "free@example.se" }, attacker));
    const [taken, takenMs] = await timed(() => post("/account/email/change", { email: "victim@example.se" }, attacker));
    expect(free.json().delivery).toBe("sent");
    expect(taken.json().delivery).toBe("sent");
    expect(outbox).toEqual(["victim@example.se", "free@example.se"]);
    expect(takenMs).toBeGreaterThanOrEqual(SEND_MS - 20);
    expect(Math.abs(takenMs - freeMs)).toBeLessThan(100);
  });

  it("F4: a wrong code answers invalid_otp_code for a taken address too; the silent start is a stored challenge that closes the older one", async () => {
    await holdAddress("held@example.se");
    const attacker = await signIn(freshPhone());
    const real = (await post("/account/email/change", { email: "mine@example.se" }, attacker)).json();
    const silent = (await post("/account/email/change", { email: "held@example.se" }, attacker)).json();
    const rows = await database.db.selectFrom("email_changes").select(["challenge_id", "email", "expires_at"]).where("challenge_id", "in", [real.challengeId, silent.challengeId]).execute();
    expect(rows.find((r) => r.challenge_id === silent.challengeId)).toMatchObject({ email: "held@example.se", expires_at: new Date(silent.expiresAt) });
    // Like a real start, the new challenge closes the open one.
    expect(rows.find((r) => r.challenge_id === real.challengeId)!.expires_at.getTime()).toBe(clock.now.getTime());
    const wrong = await post("/account/email/verify", { challengeId: silent.challengeId, code: "000000" }, attacker);
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toMatchObject({ reason: "invalid_otp_code" });
    // A real challenge answers the same.
    const other = (await post("/account/email/change", { email: "mine2@example.se" }, attacker)).json();
    expect((await post("/account/email/verify", { challengeId: other.challengeId, code: "000000" }, attacker)).json()).toMatchObject({ reason: "invalid_otp_code" });
    // Even the right code of the silent challenge never saves the taken address.
    await database.db.updateTable("email_changes").set({ code_sha256: createHash("sha256").update(`${silent.challengeId}:4242`).digest("hex"), expires_at: new Date(clock.now.getTime() + 60_000) }).where("challenge_id", "=", silent.challengeId).execute();
    expect((await post("/account/email/verify", { challengeId: silent.challengeId, code: "4242" }, attacker)).json()).toMatchObject({ reason: "invalid_email_challenge" });
  });

  it("F3 (owner 2026-11-12): at most 10 starts per hour count every try (sent, refused or silent), besides 3 accepted", async () => {
    expect(EMAIL_LIMITS).toEqual({ acceptedPerHour: 3, allTriesPerHour: 10 });
    service.accept = false;
    const mine = freshPhone();
    const me = await signIn(mine);
    for (let i = 0; i < 10; i++) expect((await post("/account/email/change", { email: `r${i}@example.se` }, me)).json()).toMatchObject({ delivery: "pending_provider" });
    const before = outbox.length;
    const over = await post("/account/email/change", { email: "r10@example.se" }, me);
    expect(over.statusCode).toBe(429);
    expect(over.json()).toMatchObject({ reason: "change_too_many" });
    expect(outbox.length).toBe(before);
    // The silent answer counts too: 9 refused + 1 silent = 10, the next is refused.
    await holdAddress("cap@example.se");
    service.accept = false;
    const other = await signIn(freshPhone());
    for (let i = 0; i < 9; i++) expect((await post("/account/email/change", { email: `s${i}@example.se` }, other)).statusCode).toBe(200);
    expect((await post("/account/email/change", { email: "cap@example.se" }, other)).statusCode).toBe(200);
    expect((await post("/account/email/change", { email: "s9@example.se" }, other)).json()).toMatchObject({ reason: "change_too_many" });
    // An hour later he may try again.
    advance(3601);
    expect((await post("/account/email/change", { email: "later@example.se" }, await signIn(mine))).statusCode).toBe(200);
  }, 30_000);

  it("nit c: the Apple / Google path waits for the same per-address lock as the code verify", async () => {
    const phone = freshPhone();
    const first = (await post("/auth/provider", { provider: "google", idToken: `ok:g-${phone}:Lock@Gmail.com`, app: "rider" })).json();
    advance(60);
    const c = (await post("/auth/otp/request", { phone, app: "rider", linkToken: first.linkToken })).json();
    const holder = await database.pool.connect();
    try {
      await holder.query("SELECT pg_advisory_lock(hashtext($1))", ["email_verified:rider:lock@gmail.com"]);
      let done = false;
      const verify = post("/auth/otp/verify", { phone, sessionId: c.sessionId, code: TEST_CODE, linkToken: first.linkToken }).then((r) => ((done = true), r));
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(done).toBe(false);
      await holder.query("SELECT pg_advisory_unlock(hashtext($1))", ["email_verified:rider:lock@gmail.com"]);
      expect((await verify).statusCode).toBe(200);
    } finally {
      holder.release();
    }
  });
});
