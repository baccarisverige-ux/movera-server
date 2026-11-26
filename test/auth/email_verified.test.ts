import { signup } from "../support/seed.js";
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import type { ProviderVerifier } from "../../src/auth/provider.js";
import { TEST_CODE } from "../../src/auth/service.js";
import { seedTestPhones } from "../../src/auth/testPhones.js";
import { readEnv } from "../../src/env.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";

/**
 * G30 + G30b (contract v0.18.76, contract.json#emailVerified; owner 2026-11-12 Q1–Q6 and the ~14:10 supervisor
 * answers): an e-mail is saved only after a code check, the server records when (emailVerifiedAt), the code goes out
 * through the e-mail service (Resend) and `delivery` is 'sent' only when the service accepted it.
 */

let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-11-12T15:00:00Z") };
const advance = (seconds: number) => (clock.now = new Date(clock.now.getTime() + seconds * 1000));
const PHONES = Array.from({ length: 60 }, (_, i) => `+467017407${String(i).padStart(2, "0")}`);
let nextPhone = 0;
const freshPhone = () => PHONES[nextPhone++]!;

/** The fake e-mail service: records every message; `accept` says whether it takes the next ones (no outbound call). */
const outbox: Array<{ to: string; subject: string; text: string }> = [];
const service = { accept: true as boolean | "throw" };
const email = {
  name: "fake",
  send: async (message: { to: string; subject: string; text: string }) => {
    outbox.push(message);
    if (service.accept === "throw") throw new Error("network down");
    return { accepted: service.accept, status: service.accept ? 200 : 403 };
  },
};
/** Google tokens `ok:<subject>:<email>:<verified>` (verified "true" / "false"). */
const google: ProviderVerifier = {
  provider: "google",
  verify: async (idToken) => {
    const [tag, subject, mail, verified] = idToken.split(":");
    if (tag !== "ok" || !subject) throw Object.assign(new Error("bad"), { status: 400 });
    return { subject, email: mail || undefined, emailVerified: mail ? verified === "true" : undefined, firstName: "Gia" };
  },
};

beforeAll(async () => {
  database = await freshDatabase();
  await seedTestPhones(database.db, PHONES);
  const env = readEnv({ MOVERA_ENV: "staging", DATABASE_URL: database.url, JWT_SECRET: "g30-email-verified".padEnd(48, "e") });
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
const post = (url: string, payload: unknown, t?: string) => app.inject({ method: "POST", url: `/api/v1${url}`, headers: json(t), payload: payload as object });
const get = (url: string, t: string) => app.inject({ method: "GET", url: `/api/v1${url}`, headers: { authorization: `Bearer ${t}` } });
let keys = 0;
const patch = (url: string, payload: unknown, t: string) => app.inject({ method: "PATCH", url: `/api/v1${url}`, headers: { ...json(t), "idempotency-key": `g30-key-${String(++keys).padStart(8, "0")}` }, payload: payload as object });
async function signIn(phone: string, appName: "rider" | "driver"): Promise<{ accessToken: string; id: string }> {
  advance(60);
  const c = (await post("/auth/otp/request", { phone, app: appName })).json();
  const tokens = (await post("/auth/otp/verify", { phone, sessionId: c.sessionId, code: TEST_CODE })).json();
  const me = (await get(`/${appName}/profile`, tokens.accessToken)).json();
  return { accessToken: tokens.accessToken, id: appName === "rider" ? me.riderId : me.driverId };
}
/** Plants code 4242 on a challenge (the real code went to the fake outbox or nowhere). */
async function plant(challengeId: string) {
  await database.db.updateTable("email_changes").set({ code_sha256: createHash("sha256").update(`${challengeId}:4242`).digest("hex") }).where("challenge_id", "=", challengeId).execute();
}
async function changeAndVerify(token: string, address: string) {
  const start = await post("/account/email/change", { email: address }, token);
  expect(start.statusCode, start.body).toBe(200);
  await plant(start.json().challengeId);
  return post("/account/email/verify", { challengeId: start.json().challengeId, code: "4242" }, token);
}
const challengesOf = (actor: "rider" | "driver", id: string) => database.db.selectFrom("email_changes").select(["email"]).where("actor", "=", actor).where("subject_id", "=", id).execute();
const onboarding = (token: string, address: string) =>
  app.inject({
    method: "POST",
    url: "/api/v1/driver/onboarding",
    headers: { ...json(token), "idempotency-key": `g30-key-${String(++keys).padStart(8, "0")}` },
    payload: signup({ firstName: "Nils", lastName: "Ny", dateOfBirth: "1988-04-01", email: address, country: "SE", cityId: "stockholm_lan", language: "sv", accountType: "driver", termsAccepted: true }),
  });

describe("G30: e-mail saved only after a code check", () => {
  it("G30: PATCH /rider/profile with an e-mail is refused (email_needs_code) and nothing is saved", async () => {
    const me = await signIn(freshPhone(), "rider");
    const before = (await get("/rider/profile", me.accessToken)).json();
    // Refused before the version check: a stale version gets the same answer.
    const stale = await patch("/rider/profile", { expectedVersion: before.version + 7, email: "p@example.se" }, me.accessToken);
    expect(stale.statusCode, stale.body).toBe(400);
    expect(stale.json()).toMatchObject({ code: "invalid_request", reason: "email_needs_code" });
    const res = await patch("/rider/profile", { expectedVersion: before.version, firstName: "Pia", email: "p@example.se" }, me.accessToken);
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json()).toMatchObject({ code: "invalid_request", reason: "email_needs_code" });
    const row = await database.db.selectFrom("riders").select(["email", "first_name", "version"]).where("rider_id", "=", me.id).executeTakeFirstOrThrow();
    expect(row).toEqual({ email: null, first_name: before.firstName, version: before.version });
    // A body without e-mail still works.
    expect((await patch("/rider/profile", { expectedVersion: before.version, firstName: "Pia" }, me.accessToken)).statusCode).toBe(200);
  });

  it("G30: after the code, GET /rider/profile and GET /driver/profile carry emailVerifiedAt; verify answers { email, emailVerifiedAt }", async () => {
    const rider = await signIn(freshPhone(), "rider");
    const ok = await changeAndVerify(rider.accessToken, "Ann@Example.se");
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toEqual({ email: "ann@example.se", emailVerifiedAt: clock.now.toISOString() });
    expect((await get("/rider/profile", rider.accessToken)).json()).toMatchObject({ email: "ann@example.se", emailVerifiedAt: clock.now.toISOString() });

    const driver = await signIn(freshPhone(), "driver");
    expect((await get("/driver/profile", driver.accessToken)).json().emailVerifiedAt).toBeUndefined();
    const okDriver = await changeAndVerify(driver.accessToken, "Dan@Example.se");
    expect(okDriver.json()).toEqual({ email: "dan@example.se", emailVerifiedAt: clock.now.toISOString() });
    expect((await get("/driver/profile", driver.accessToken)).json()).toMatchObject({ email: "dan@example.se", emailVerifiedAt: clock.now.toISOString() });
  });

  it("G30: a driver verifies the sign-up e-mail he already has (no 10-minute rule, no change notice, no email_changed)", async () => {
    const me = await signIn(freshPhone(), "driver");
    const signUp = await onboarding(me.accessToken, "Ny@Example.se");
    expect(signUp.statusCode, signUp.body).toBe(200);
    expect(signUp.json().email).toBe("ny@example.se");
    expect(signUp.json().emailVerifiedAt).toBeUndefined();
    advance(11 * 60); // past the 10-minute sign-in rule: verifying his own address does not need it
    const start = await post("/account/email/change", { email: "NY@example.se" }, me.accessToken);
    expect(start.statusCode, start.body).toBe(200);
    expect(await challengesOf("driver", me.id)).toEqual([{ email: "ny@example.se" }]);
    await plant(start.json().challengeId);
    const ok = await post("/account/email/verify", { challengeId: start.json().challengeId, code: "4242" }, me.accessToken);
    expect(ok.json()).toEqual({ email: "ny@example.se", emailVerifiedAt: clock.now.toISOString() });
    expect(await database.db.selectFrom("outbound_notices").select("to_address").where("kind", "=", "email_changed").where("to_address", "=", "ny@example.se").execute()).toEqual([]);
    expect(await database.db.selectFrom("notifications").select("kind").where("audience", "=", "driver").where("subject_id", "=", me.id).where("kind", "=", "email_changed").execute()).toEqual([]);
    expect((await get("/driver/profile", me.accessToken)).json().emailVerifiedAt).toBe(clock.now.toISOString());
  });

  it("G30: verifying a rider's own current address ends no other session; a NEW address still needs the 10-minute rule", async () => {
    const phone = freshPhone();
    const other = await signIn(phone, "rider");
    const me = await signIn(phone, "rider");
    await database.db.updateTable("riders").set({ email: "Mia@Example.se" }).where("rider_id", "=", me.id).execute();
    advance(11 * 60);
    expect((await post("/account/email/change", { email: "new@example.se" }, me.accessToken)).json()).toMatchObject({ reason: "reauth_required" });
    const ok = await changeAndVerify(me.accessToken, "mia@example.se");
    expect(ok.json()).toEqual({ email: "mia@example.se", emailVerifiedAt: clock.now.toISOString() });
    expect((await get("/rider/profile", other.accessToken)).statusCode).toBe(200);
  });

  it("G30: an unchecked copy on another account never blocks the real owner", async () => {
    const squatter = await signIn(freshPhone(), "rider");
    await database.db.updateTable("riders").set({ email: "X@Y.se" }).where("rider_id", "=", squatter.id).execute();
    const squattingDriver = await signIn(freshPhone(), "driver");
    await database.db.updateTable("drivers").set({ email: "x@y.se" }).where("driver_id", "=", squattingDriver.id).execute();
    const owner = await signIn(freshPhone(), "rider");
    const ok = await changeAndVerify(owner.accessToken, "x@y.se");
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().emailVerifiedAt).toBe(clock.now.toISOString());
    // The squatter keeps his (unverified) copy: nothing is deleted (Rule 21).
    expect(await database.db.selectFrom("riders").select(["email", "email_verified_at" as never]).where("rider_id", "=", squatter.id).executeTakeFirstOrThrow()).toEqual({ email: "X@Y.se", email_verified_at: null });
  });

  it("G30: a VERIFIED address on another account of the same app still gets the silent answer; the same person's other app does not block (Q5)", async () => {
    const holder = await signIn(freshPhone(), "rider");
    expect((await changeAndVerify(holder.accessToken, "taken@example.se")).statusCode).toBe(200);
    const other = await signIn(freshPhone(), "rider");
    outbox.length = 0;
    const start = await post("/account/email/change", { email: "Taken@Example.se" }, other.accessToken);
    expect(start.statusCode).toBe(200);
    expect(Object.keys(start.json()).sort()).toEqual(["challengeId", "delivery", "expiresAt"]);
    // Fix round F4: a stored challenge whose random code is never sent (a wrong code answers like a real one).
    expect(await challengesOf("rider", other.id)).toEqual([{ email: "taken@example.se" }]);
    expect(outbox).toEqual([]);
    expect((await post("/account/email/verify", { challengeId: start.json().challengeId, code: "4242" }, other.accessToken)).json()).toMatchObject({ reason: "invalid_otp_code" });

    // Q5: the same address verified on a DRIVER account does not block a rider account.
    const phone = freshPhone();
    const asDriver = await signIn(phone, "driver");
    expect((await changeAndVerify(asDriver.accessToken, "both@example.se")).statusCode).toBe(200);
    const asRider = await signIn(phone, "rider");
    const mine = await changeAndVerify(asRider.accessToken, "both@example.se");
    expect(mine.statusCode, mine.body).toBe(200);
    expect(mine.json().email).toBe("both@example.se");
  });

  it("G30: two accounts verifying the same address: the first verify wins, the other fails like a wrong challenge", async () => {
    const a = await signIn(freshPhone(), "driver");
    const b = await signIn(freshPhone(), "driver");
    const startA = (await post("/account/email/change", { email: "race@example.se" }, a.accessToken)).json();
    const startB = (await post("/account/email/change", { email: "race@example.se" }, b.accessToken)).json();
    await plant(startA.challengeId);
    await plant(startB.challengeId);
    const [ra, rb] = await Promise.all([
      post("/account/email/verify", { challengeId: startA.challengeId, code: "4242" }, a.accessToken),
      post("/account/email/verify", { challengeId: startB.challengeId, code: "4242" }, b.accessToken),
    ]);
    expect([ra.statusCode, rb.statusCode].sort()).toEqual([200, 400]);
    expect([ra, rb].find((r) => r.statusCode === 400)!.json()).toMatchObject({ reason: "invalid_email_challenge" });
    const verified = await database.db.selectFrom("drivers").select("driver_id").where("email", "=", "race@example.se").where("email_verified_at" as never, "is not", null).execute();
    expect(verified).toHaveLength(1);
  });

  it("G30: a new address by code is verified; the sign-up resend keeps 'verified' only for the same address", async () => {
    const me = await signIn(freshPhone(), "driver");
    expect((await onboarding(me.accessToken, "first@example.se")).statusCode).toBe(200);
    const ok = await changeAndVerify(me.accessToken, "Second@Example.se");
    expect(ok.json().email).toBe("second@example.se");
    const at = ok.json().emailVerifiedAt;
    const same = await onboarding(me.accessToken, "SECOND@example.se");
    expect(same.statusCode, same.body).toBe(200);
    expect(same.json()).toMatchObject({ email: "second@example.se", emailVerifiedAt: at });
    const other = await onboarding(me.accessToken, "third@example.se");
    expect(other.json().email).toBe("third@example.se");
    expect(other.json().emailVerifiedAt).toBeUndefined();
  });

  it("G30: admin GET /admin/riders?q= and /admin/drivers/{id} show emailVerifiedAt, also when the e-mail is masked", async () => {
    const rider = await signIn(freshPhone(), "rider");
    const r = await changeAndVerify(rider.accessToken, "adm.rider@example.se");
    const driver = await signIn(freshPhone(), "driver");
    const d = await changeAndVerify(driver.accessToken, "adm.driver@example.se");
    await database.db.updateTable("drivers").set({ zone_ids: ["Z001"] }).where("driver_id", "=", driver.id).execute();
    const unverified = await signIn(freshPhone(), "rider");
    await database.db.updateTable("riders").set({ email: "plain@example.se" }).where("rider_id", "=", unverified.id).execute();
    const sup = await adminSession(app, database.db, "super", { now: clock.now });
    const viewer = await adminSession(app, database.db, "viewer", { now: clock.now });
    const full = (await get(`/admin/riders?q=${rider.id}`, sup.token)).json();
    expect(JSON.stringify(full)).toContain(`"emailVerifiedAt":"${r.json().emailVerifiedAt}"`);
    const masked = (await get(`/admin/riders?q=${rider.id}`, viewer.token)).json();
    expect(JSON.stringify(masked)).toContain(`"emailVerifiedAt":"${r.json().emailVerifiedAt}"`);
    expect(JSON.stringify(masked)).not.toContain("adm.rider@example.se");
    expect(JSON.stringify((await get(`/admin/riders?q=${unverified.id}`, sup.token)).json())).not.toContain("emailVerifiedAt");
    const driverFull = (await get(`/admin/drivers/${driver.id}`, sup.token)).json();
    expect(JSON.stringify(driverFull)).toContain(`"emailVerifiedAt":"${d.json().emailVerifiedAt}"`);
    const driverMasked = await get(`/admin/drivers/${driver.id}`, viewer.token);
    expect(driverMasked.statusCode, driverMasked.body).toBe(200);
    expect(JSON.stringify(driverMasked.json())).toContain(`"emailVerifiedAt":"${d.json().emailVerifiedAt}"`);
    expect(JSON.stringify(driverMasked.json())).not.toContain("adm.driver@example.se");
  });

  it("G30: a Google e-mail with email_verified true is Verified on the new account; false is not (Q4)", async () => {
    for (const [verified, appName] of [["true", "rider"], ["false", "rider"], ["true", "driver"], ["false", "driver"]] as const) {
      const phone = freshPhone();
      const first = (await post("/auth/provider", { provider: "google", idToken: `ok:g-${phone}:Gia.${verified}@Gmail.com:${verified}`, app: appName })).json();
      expect(first.code).toBe("PHONE_REQUIRED");
      advance(60);
      const c = (await post("/auth/otp/request", { phone, app: appName, linkToken: first.linkToken })).json();
      const tokens = (await post("/auth/otp/verify", { phone, sessionId: c.sessionId, code: TEST_CODE, linkToken: first.linkToken })).json();
      const me = (await get(`/${appName}/profile`, tokens.accessToken)).json();
      expect(me.email).toBe(`gia.${verified}@gmail.com`);
      if (verified === "true") expect(me.emailVerifiedAt).toBe(clock.now.toISOString());
      else expect(me.emailVerifiedAt).toBeUndefined();
    }
  });
});

describe("G30b: the code goes out through the e-mail service; 'sent' only when it accepted the e-mail", () => {
  it("G30b: an accepted send answers 'sent' and the e-mail carries the code that verifies", async () => {
    const me = await signIn(freshPhone(), "rider");
    const start = await post("/account/email/change", { email: "Code@Example.se" }, me.accessToken);
    expect(start.json()).toMatchObject({ delivery: "sent" });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.to).toBe("code@example.se");
    const code = /\b(\d{4})\b/.exec(outbox[0]!.text)?.[1];
    expect(code).toBeDefined();
    const ok = await post("/account/email/verify", { challengeId: start.json().challengeId, code }, me.accessToken);
    expect(ok.json()).toEqual({ email: "code@example.se", emailVerifiedAt: clock.now.toISOString() });
  });

  it("G30b: a refused or failed send answers 'pending_provider' and does not count toward the 3 starts per hour; accepted sends do", async () => {
    const me = await signIn(freshPhone(), "rider");
    service.accept = false;
    for (let i = 0; i < 3; i++) expect((await post("/account/email/change", { email: `r${i}@example.se` }, me.accessToken)).json()).toMatchObject({ delivery: "pending_provider" });
    service.accept = "throw";
    expect((await post("/account/email/change", { email: "t@example.se" }, me.accessToken)).json()).toMatchObject({ delivery: "pending_provider" });
    service.accept = true;
    for (let i = 0; i < 3; i++) expect((await post("/account/email/change", { email: `a${i}@example.se` }, me.accessToken)).json()).toMatchObject({ delivery: "sent" });
    expect((await post("/account/email/change", { email: "a9@example.se" }, me.accessToken)).json()).toMatchObject({ reason: "change_too_many" });
  });

  it("G30b: the e-mail is in the account's language", async () => {
    const me = await signIn(freshPhone(), "driver");
    await database.db.updateTable("drivers").set({ language: "fr" }).where("driver_id", "=", me.id).execute();
    await post("/account/email/change", { email: "fr@example.fr" }, me.accessToken);
    expect(outbox[0]!.subject).toMatch(/code/i);
    expect(outbox[0]!.text).toMatch(/Votre code/);
  });
});
