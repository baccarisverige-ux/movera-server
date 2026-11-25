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
 * 2026-11-12, contract v0.18.77), also for parallel starts (F5); the Apple / Google path takes the same per-address lock as the code verify (nit c).
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
    // Three pairs, each from a new account (the hourly limits stay out of it); the fastest of each kind is
    // compared, because a busy machine only ever adds delay (one sample flaked at 199 ms under load).
    const freeTimes: number[] = [];
    const takenTimes: number[] = [];
    for (let i = 0; i < 3; i++) {
      const attacker = await signIn(freshPhone());
      const [free, freeMs] = await timed(() => post("/account/email/change", { email: `free${i}@example.se` }, attacker));
      const [taken, takenMs] = await timed(() => post("/account/email/change", { email: "victim@example.se" }, attacker));
      expect(free.json().delivery).toBe("sent");
      expect(taken.json().delivery).toBe("sent");
      expect(takenMs).toBeGreaterThanOrEqual(SEND_MS - 20);
      freeTimes.push(freeMs);
      takenTimes.push(takenMs);
    }
    // The held address never gets a mail; only the free ones do.
    expect(outbox).toEqual(["victim@example.se", "free0@example.se", "free1@example.se", "free2@example.se"]);
    expect(Math.abs(Math.min(...takenTimes) - Math.min(...freeTimes))).toBeLessThan(100);
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

  it("v0.18.77: the own-address start counts; a start refused before it begins (400, 403 reauth_required, 429) does not", async () => {
    service.accept = false;
    const mine = freshPhone();
    const me = await signIn(mine);
    await database.db.updateTable("riders").set({ email: "Own@Example.se" }).where("phone", "=", mine).execute();
    // Refused before they begin: never counted.
    for (let i = 0; i < 5; i++) expect((await post("/account/email/change", { email: "not-an-e-mail" }, me)).json()).toMatchObject({ reason: "invalid_email" });
    advance(11 * 60);
    for (let i = 0; i < 5; i++) expect((await post("/account/email/change", { email: `n${i}@example.se` }, me)).json()).toMatchObject({ reason: "reauth_required" });
    // Checking his own current address needs no recent sign-in, but each start counts: 5 now + 5 half an hour later.
    const fresh = await signIn(mine); // v0.18.165: the 91 s steps outlive the 15-minute token; signing in again changes no count
    for (let i = 0; i < 5; i++) expect((advance(91), await post("/account/email/change", { email: "own@example.se" }, fresh)).statusCode).toBe(200);
    advance(30 * 60);
    let again = await signIn(mine); // the access token outlives neither half hour; signing in again changes no count
    for (let i = 0; i < 5; i++) expect((advance(91), await post("/account/email/change", { email: "own@example.se" }, again)).statusCode).toBe(200);
    for (let i = 0; i < 3; i++) {
      advance(91); // v0.18.165: past the 90 s resend wait for the same address, so the hourly limit answers
      const over = await post("/account/email/change", { email: "own@example.se" }, again);
      expect(over.statusCode).toBe(429);
      expect(over.headers["retry-after"]).toBe("3600");
      expect(over.json()).toMatchObject({ reason: "change_too_many" });
    }
    // The first 5 leave the rolling hour; the three 429s did not count, so exactly 5 more are allowed.
    advance(31 * 60);
    again = await signIn(mine);
    for (let i = 0; i < 5; i++) expect((advance(91), await post("/account/email/change", { email: "own@example.se" }, again)).statusCode).toBe(200);
    expect((advance(91), await post("/account/email/change", { email: "own@example.se" }, again)).json()).toMatchObject({ reason: "change_too_many" });
  }, 30_000);

  it("F5: 25 parallel starts from one account keep both limits (at most 10 tries, at most 3 accepted, the rest 429)", async () => {
    const burst = async (accept: boolean) => {
      service.accept = accept;
      outbox.length = 0;
      const me = await signIn(freshPhone());
      const res = await Promise.all(Array.from({ length: 25 }, (_, i) => post("/account/email/change", { email: `p${i}@example.se` }, me)));
      const ok = res.filter((r) => r.statusCode === 200);
      for (const r of res.filter((x) => x.statusCode !== 200)) {
        expect(r.statusCode).toBe(429);
        expect(r.json()).toMatchObject({ reason: "change_too_many" });
      }
      return { ok: ok.length, sent: ok.filter((r) => r.json().delivery === "sent").length, calls: outbox.length };
    };
    // An accepting e-mail service: at most 3 code e-mails go out, however many starts arrive at once.
    const accepted = await burst(true);
    expect(accepted.ok).toBeGreaterThanOrEqual(1);
    expect(accepted.ok).toBeLessThanOrEqual(10);
    expect(accepted.sent).toBeLessThanOrEqual(3);
    expect(accepted.calls).toBeLessThanOrEqual(3);
    // A refusing one: at most 10 tries (and at most 10 calls to the service), none counted as sent.
    const refused = await burst(false);
    expect(refused.ok).toBeGreaterThanOrEqual(1);
    expect(refused.ok).toBeLessThanOrEqual(10);
    expect(refused.sent).toBe(0);
    expect(refused.calls).toBeLessThanOrEqual(10);
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
