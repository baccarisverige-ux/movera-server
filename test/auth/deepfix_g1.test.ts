import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { REFRESH_RETRY_WINDOW_MS } from "../../src/auth/service.js";
import { contract } from "../../src/contract/contract.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { call, signIn, testWorld } from "../support/world.js";

/**
 * Contract v0.18.5 §30, deep second audit of driver group 1 (Rules decisions/driver-g1.md): G1-B3 the 5th wrong code,
 * G1-D3 why the app was signed out, G1-B6 the refresh retry window, G1-B2 the legal texts per country (SE and FR).
 */

type Auth = {
  otp: { maxAttempts: number };
  tokens: { refreshRetryWindowSeconds: number; refreshExpiresDays: number };
  signedOut: { reasons: Record<string, "expired" | "revoked">; texts: Record<string, Record<string, string>> };
  beforeSignIn: { allowed: string[] };
};
const AUTH = (contract as unknown as { auth: Auth }).auth;
type LegalDoc = { title: Record<string, string>; text: Record<string, string> };
const LEGAL = (contract as unknown as { legal: { countries: string[]; defaults: Record<string, { terms: LegalDoc; privacy: LegalDoc }> } }).legal;

let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-11-05T09:00:00Z") };
const advance = (seconds: number) => (clock.now = new Date(clock.now.getTime() + seconds * 1000));

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
});
afterAll(async () => {
  await app.close();
  await database.drop();
});
beforeEach(() => advance(3600));

const post = (url: string, payload: unknown, headers: Record<string, string> = {}) => app.inject({ method: "POST", url: `/api/v1${url}`, headers: { "content-type": "application/json", ...headers }, payload: payload as object });

describe("G1-B3: the 5th wrong code itself answers 'too many wrong tries'", () => {
  for (const [label, phone, appName] of [["rider (SE number)", TEST_PHONES[3]!, "rider"], ["driver", TEST_PHONES[4]!, "driver"]] as const) {
    it(`${label}: wrong codes 1–4 are 400, the 5th is 429 otp_too_many_attempts, and the right code after it too`, async () => {
      const challenge = (await post("/auth/otp/request", { phone, app: appName })).json();
      for (let i = 1; i < AUTH.otp.maxAttempts; i++) {
        const wrong = await post("/auth/otp/verify", { phone, sessionId: challenge.sessionId, code: "000000" });
        expect(wrong.statusCode, `wrong code ${i}`).toBe(400);
        expect(wrong.json()).toMatchObject({ reason: "invalid_otp_code" });
      }
      const fifth = await post("/auth/otp/verify", { phone, sessionId: challenge.sessionId, code: "000000" });
      expect(fifth.statusCode).toBe(429);
      expect(fifth.json()).toMatchObject({ code: "rate_limited", reason: "otp_too_many_attempts" });
      const right = await post("/auth/otp/verify", { phone, sessionId: challenge.sessionId, code: "123456" });
      expect(right.statusCode).toBe(429);
      expect(right.json()).toMatchObject({ reason: "otp_too_many_attempts" });
      // A new code starts a new session that works.
      advance(60);
      const again = (await post("/auth/otp/request", { phone, app: appName })).json();
      expect((await post("/auth/otp/verify", { phone, sessionId: again.sessionId, code: "123456" })).statusCode).toBe(200);
    });
  }

  it("the 4th wrong code is still a normal 'wrong code' (no early lock)", async () => {
    const phone = TEST_PHONES[5]!;
    const challenge = (await post("/auth/otp/request", { phone, app: "rider" })).json();
    for (let i = 0; i < 4; i++) await post("/auth/otp/verify", { phone, sessionId: challenge.sessionId, code: "000000" });
    expect((await post("/auth/otp/verify", { phone, sessionId: challenge.sessionId, code: "123456" })).statusCode).toBe(200);
  });
});

describe("G1-D3 / G1-B6: why the app was signed out, and the retry window", () => {
  it("every reason a refused refresh answers is named in auth.signedOut (expired vs revoked), with sv/fr/en texts", async () => {
    expect(AUTH.signedOut.reasons).toEqual({ session_expired: "expired", session_ended: "revoked", refresh_token_reused: "revoked", refresh_token_unknown: "revoked", signed_in_elsewhere: "revoked" });
    for (const kind of ["expired", "revoked"]) expect(Object.keys(AUTH.signedOut.texts[kind]!).sort()).toEqual(["en", "fr", "sv"]);
    const seen = new Set<string>();
    seen.add((await post("/auth/refresh", { refreshToken: "rt_unknown" })).json().reason);
    const phone = TEST_PHONES[0]!;
    const challenge = (await post("/auth/otp/request", { phone, app: "rider" })).json();
    const tokens = (await post("/auth/otp/verify", { phone, sessionId: challenge.sessionId, code: "123456" })).json();
    const next = (await post("/auth/refresh", { refreshToken: tokens.refreshToken })).json();
    advance(REFRESH_RETRY_WINDOW_MS / 1000 + 1);
    seen.add((await post("/auth/refresh", { refreshToken: tokens.refreshToken })).json().reason);
    seen.add((await post("/auth/refresh", { refreshToken: next.refreshToken })).json().reason);
    const other = (await post("/auth/otp/verify", { phone, sessionId: (await post("/auth/otp/request", { phone, app: "rider" })).json().sessionId, code: "123456" })).json();
    advance((AUTH.tokens.refreshExpiresDays + 1) * 86400);
    seen.add((await post("/auth/refresh", { refreshToken: other.refreshToken })).json().reason);
    // v0.18.14: a driver's second phone ends the first one's session.
    const dPhone = TEST_PHONES[1]!;
    const d1 = (await post("/auth/otp/verify", { phone: dPhone, sessionId: (await post("/auth/otp/request", { phone: dPhone, app: "driver" })).json().sessionId, code: "123456" })).json();
    advance(60);
    await post("/auth/otp/verify", { phone: dPhone, sessionId: (await post("/auth/otp/request", { phone: dPhone, app: "driver" })).json().sessionId, code: "123456" });
    seen.add((await post("/auth/refresh", { refreshToken: d1.refreshToken })).json().reason);
    expect([...seen].sort()).toEqual(Object.keys(AUTH.signedOut.reasons).sort());
  });

  it("the contract's retry window is the server's", () => {
    expect(AUTH.tokens.refreshRetryWindowSeconds * 1000).toBe(REFRESH_RETRY_WINDOW_MS);
  });
});

describe("G1-B2: terms and privacy per country (SE and FR), sv/fr/en, from the admin, readable before sign-in", () => {
  it("GET /legal/{country} needs no token and is on the before-sign-in list", async () => {
    expect(AUTH.beforeSignIn.allowed).toContain("GET /legal/{country}");
    for (const country of ["SE", "FR"]) {
      const res = await app.inject({ method: "GET", url: `/api/v1/legal/${country}` });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({ country, version: 0, source: "default", reaccept: false });
      for (const doc of ["terms", "privacy"] as const) {
        for (const lang of ["sv", "fr", "en"]) {
          expect(body[doc].title[lang]).toBe(LEGAL.defaults[country]![doc].title[lang]);
          // Draft texts say so; no company placeholder is shown while the admin has not filled it.
          expect(body[doc].text[lang]).toMatch(/Utkast|Projet|Draft/);
          expect(body[doc].text[lang]).not.toMatch(/\{\w+\}|\[Raison sociale\]|Demo builds/);
        }
      }
    }
    expect((await app.inject({ method: "GET", url: "/api/v1/legal/TN" })).statusCode).toBe(404);
  });

  it("the drafts differ per country (Swedish taxi law vs French VTC rules)", async () => {
    const se = (await app.inject({ method: "GET", url: "/api/v1/legal/SE" })).json();
    const fr = (await app.inject({ method: "GET", url: "/api/v1/legal/FR" })).json();
    expect(se.terms.text.fr).toMatch(/Suède|suédois/);
    expect(fr.terms.text.fr).toMatch(/VTC/);
    expect(fr.privacy.text.fr).toMatch(/CNIL/);
    expect(se.privacy.text.sv).toMatch(/IMY/);
  });

  it("the admin publishes a new version with company details; filled placeholders show, empty ones are left out; re-accept blocks until accepted (SE)", async () => {
    const sup = await adminSession(app, database.db, "super", { now: clock.now });
    const draft = (await call(app, "GET", "/admin/legal/SE", sup.headers)).json();
    expect(draft.live).toMatchObject({ country: "SE", version: 0, source: "default" });
    expect(draft.live.terms.text.en).toContain("{companyName}");
    const publish = await call(app, "POST", "/admin/legal/SE/publish", sup.headers, {
      terms: draft.live.terms, privacy: draft.live.privacy, company: { companyName: "Movera Sverige AB", supportPhone: "+46812345678" }, reaccept: true,
    });
    expect(publish.statusCode, publish.body).toBe(200);
    expect(publish.json()).toMatchObject({ country: "SE", version: 1, source: "admin", reaccept: true, company: { companyName: "Movera Sverige AB" } });
    const read = (await app.inject({ method: "GET", url: "/api/v1/legal/SE" })).json();
    expect(read).toMatchObject({ version: 1, source: "admin", reaccept: true });
    // v0.18.14 (g1-g3 M3): the public read carries the company / support details for "Need help?" (fail-before: absent).
    expect(read.company).toEqual({ companyName: "Movera Sverige AB", supportPhone: "+46812345678" });
    expect(read.terms.text.sv).toContain("Movera drivs av Movera Sverige AB.");
    expect(read.terms.text.en).toContain("Phone: +46812345678.");
    expect(read.terms.text.en).not.toMatch(/\{|Company number|E-mail:/);
    // France is not touched.
    expect((await app.inject({ method: "GET", url: "/api/v1/legal/FR" })).json().version).toBe(0);
    // The rider of a Swedish zone must accept before booking; a wrong version is refused.
    const rider = await signIn(app, TEST_PHONES[1]!, "rider");
    expect((await call(app, "POST", "/account/legal/accept", rider.headers, { country: "SE", version: 2 })).json()).toMatchObject({ reason: "terms_version_not_current" });
    const { termsAccepted } = await import("../../src/content/routes.js");
    const riderId = (await database.db.selectFrom("riders").select("rider_id").where("phone", "=", TEST_PHONES[1]!).executeTakeFirstOrThrow()).rider_id;
    expect(await termsAccepted(database.db, "rider", riderId, ["Z001"])).toBe(false);
    expect(await termsAccepted(database.db, "rider", riderId, ["FR-PC"])).toBe(true);
    expect((await call(app, "POST", "/account/legal/accept", rider.headers, { country: "SE", version: 1 })).statusCode).toBe(204);
    expect(await termsAccepted(database.db, "rider", riderId, ["Z001"])).toBe(true);
    const history = (await call(app, "GET", "/admin/legal/SE", sup.headers)).json();
    expect(history.history.map((v: { version: number }) => v.version)).toEqual([1]);
  });

  it("France: every title and text needs sv, fr and en; a company e-mail must be an e-mail", async () => {
    const sup = await adminSession(app, database.db, "super", { now: clock.now });
    const draft = (await call(app, "GET", "/admin/legal/FR", sup.headers)).json();
    const missing = await call(app, "POST", "/admin/legal/FR/publish", sup.headers, { terms: { title: draft.live.terms.title, text: { sv: "x", fr: "y" } }, privacy: draft.live.privacy });
    expect(missing.statusCode).toBe(400);
    const badMail = await call(app, "POST", "/admin/legal/FR/publish", sup.headers, { terms: draft.live.terms, privacy: draft.live.privacy, company: { supportEmail: "nope" } });
    expect(badMail.statusCode).toBe(400);
    const ok = await call(app, "POST", "/admin/legal/FR/publish", sup.headers, { terms: draft.live.terms, privacy: draft.live.privacy, company: { companyName: "Movera France SAS", orgNumber: "123 456 789" } });
    expect(ok.statusCode, ok.body).toBe(200);
    const read = (await app.inject({ method: "GET", url: "/api/v1/legal/FR" })).json();
    expect(read).toMatchObject({ version: 1, reaccept: false });
    expect(read.terms.text.fr).toContain("Numéro d’immatriculation : 123 456 789.");
  });

  it("checker finding 6: a later version without re-accept never unblocks someone who did not accept the re-accept version; accepting the newer one counts (FR)", async () => {
    const sup = await adminSession(app, database.db, "super", { now: clock.now });
    const draft = (await call(app, "GET", "/admin/legal/FR", sup.headers)).json();
    const texts = { terms: draft.live.terms, privacy: draft.live.privacy };
    const v2 = await call(app, "POST", "/admin/legal/FR/publish", sup.headers, { ...texts, reaccept: true });
    expect(v2.statusCode, v2.body).toBe(200);
    const required = v2.json().version as number;
    const v3 = await call(app, "POST", "/admin/legal/FR/publish", sup.headers, { ...texts, reaccept: false });
    expect(v3.json().version).toBe(required + 1);
    const read = (await app.inject({ method: "GET", url: "/api/v1/legal/FR" })).json();
    expect(read).toMatchObject({ version: required + 1, reaccept: false, reacceptFrom: required });
    const { termsAccepted } = await import("../../src/content/routes.js");
    const rider = await signIn(app, TEST_PHONES[2]!, "rider");
    const riderId = (await database.db.selectFrom("riders").select("rider_id").where("phone", "=", TEST_PHONES[2]!).executeTakeFirstOrThrow()).rider_id;
    // Never accepted the re-accept version: still blocked although the live one asks nothing.
    expect(await termsAccepted(database.db, "rider", riderId, ["FR-PC"])).toBe(false);
    // Accepting the live (newer) version also satisfies the older re-accept one.
    expect((await call(app, "POST", "/account/legal/accept", rider.headers, { country: "FR", version: required + 1 })).statusCode).toBe(204);
    expect(await termsAccepted(database.db, "rider", riderId, ["FR-PC"])).toBe(true);
  });

  it("an admin limited to Swedish zones cannot publish France's texts", async () => {
    const se = await adminSession(app, database.db, "ops", { zoneIds: ["Z001"], now: clock.now });
    const draft = (await call(app, "GET", "/admin/legal/SE", se.headers)).json();
    const res = await call(app, "POST", "/admin/legal/FR/publish", se.headers, { terms: draft.live.terms, privacy: draft.live.privacy });
    expect(res.statusCode).toBe(403);
  });
});
