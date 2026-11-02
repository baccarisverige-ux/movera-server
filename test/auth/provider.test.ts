import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { JwksVerifier, splitName, type ProviderVerifier } from "../../src/auth/provider.js";
import { TEST_PHONES, seedTestPhones } from "../../src/auth/testPhones.js";
import { readEnv } from "../../src/env.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";

/** contract §8 (v0.5.3): Apple / Google sign-in with the phone confirmed once, and the token check itself. */

let database: TestDatabase;
let app: FastifyInstance;
let bare: FastifyInstance;
const clock = { now: new Date("2026-10-26T10:00:00Z") };
const SECRET = "test-secret-".padEnd(48, "x");

/** A verifier that trusts tokens of the form `ok:<subject>:<email>:<given>:<family>` and refuses the rest. */
const fake = (provider: "apple" | "google"): ProviderVerifier => ({
  provider,
  verify: async (idToken) => {
    const [tag, subject, email, given, family] = idToken.split(":");
    if (tag !== "ok" || !subject) throw Object.assign(new Error("bad"), { status: 400 });
    return { subject, email: email || undefined, firstName: given || undefined, lastName: family || undefined };
  },
});

const post = (server: FastifyInstance, url: string, payload: unknown) => server.inject({ method: "POST", url: `/api/v1${url}`, payload: payload as object });
const profile = (token: string) => app.inject({ method: "GET", url: "/api/v1/driver/profile", headers: { authorization: `Bearer ${token}` } });

beforeAll(async () => {
  database = await freshDatabase();
  await seedTestPhones(database.db);
  const env = readEnv({ MOVERA_ENV: "staging", DATABASE_URL: database.url, JWT_SECRET: SECRET });
  app = await buildApp({ env, logger: false, db: database.db, clock: () => clock.now, providers: { google: fake("google") } });
  bare = await buildApp({ env, logger: false, db: database.db, clock: () => clock.now });
});
afterAll(async () => {
  await app.close();
  await bare.close();
  await database.drop();
});

describe("POST /auth/provider", () => {
  it("answers 503 provider_not_configured without the provider's client ids", async () => {
    const res = await post(bare, "/auth/provider", { provider: "apple", idToken: "ok:abc", app: "driver" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: "unavailable", reason: "provider_not_configured" });
    expect((await post(app, "/auth/provider", { provider: "apple", idToken: "ok:abc", app: "driver" })).statusCode).toBe(503);
  });

  it("a new identity: PHONE_REQUIRED with the names and e-mail, then the phone once, then the account is linked", async () => {
    const first = await post(app, "/auth/provider", { provider: "google", idToken: "ok:g-1:anna@gmail.com:Anna:Lind", app: "driver" });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ code: "PHONE_REQUIRED", firstName: "Anna", lastName: "Lind", email: "anna@gmail.com", name: "Anna Lind" });
    const linkToken = first.json().linkToken as string;
    // A wrong token is refused at once, on the request already.
    expect((await post(app, "/auth/otp/request", { phone: TEST_PHONES[1], app: "driver", linkToken: "lt_nope" })).json()).toMatchObject({ code: "invalid_request", reason: "invalid_link_token" });
    // The rider app may not use a driver link.
    expect((await post(app, "/auth/otp/request", { phone: TEST_PHONES[1], app: "rider", linkToken })).json()).toMatchObject({ reason: "invalid_link_token" });
    const challenge = await post(app, "/auth/otp/request", { phone: TEST_PHONES[1], app: "driver", linkToken });
    expect(challenge.statusCode).toBe(200);
    const verified = await post(app, "/auth/otp/verify", { phone: TEST_PHONES[1], sessionId: challenge.json().sessionId, code: "123456", linkToken });
    expect(verified.statusCode).toBe(200);
    expect(verified.json()).toMatchObject({ actor: "driver", isNewDriver: true });
    // The new account carries the provider's names and e-mail for the details step.
    expect((await profile(verified.json().accessToken)).json()).toMatchObject({ accountStatus: "pending", firstName: "Anna", lastName: "Lind", email: "anna@gmail.com" });
    // The token is spent.
    expect((await post(app, "/auth/otp/request", { phone: TEST_PHONES[1], app: "driver", linkToken })).json()).toMatchObject({ reason: "invalid_link_token" });
    // From now on Google alone signs in.
    const again = await post(app, "/auth/provider", { provider: "google", idToken: "ok:g-1", app: "driver" });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ actor: "driver", isNewDriver: false });
    expect(again.json().accessToken).toBeDefined();
    const firstId = (await profile(verified.json().accessToken)).json().driverId;
    void firstId;
    // v0.18.14 (one phone at a time): the first sign-in's token is ended by the new one; the account is the same.
    expect((await profile(verified.json().accessToken)).json()).toMatchObject({ reason: "signed_in_elsewhere" });
    expect((await profile(again.json().accessToken)).json()).toMatchObject({ firstName: "Anna", lastName: "Lind" });
    // The same Google identity in the rider app is a separate link.
    expect((await post(app, "/auth/provider", { provider: "google", idToken: "ok:g-1:anna@gmail.com:Anna:Lind", app: "rider" })).json()).toMatchObject({ code: "PHONE_REQUIRED" });
  });

  it("an existing phone account gets linked without losing its name; Apple's name comes from the app", async () => {
    clock.now = new Date(clock.now.getTime() + 3600_000);
    const first = await post(app, "/auth/provider", { provider: "google", idToken: "ok:g-2::", app: "driver", name: "Bo Ek" });
    expect(first.json()).toMatchObject({ code: "PHONE_REQUIRED", firstName: "Bo", lastName: "Ek" });
    expect(first.json()).not.toHaveProperty("email");
    // TEST_PHONES[1] already has an account (Anna): linking g-2 to it keeps her name.
    const challenge = await post(app, "/auth/otp/request", { phone: TEST_PHONES[1], app: "driver", linkToken: first.json().linkToken });
    const verified = await post(app, "/auth/otp/verify", { phone: TEST_PHONES[1], sessionId: challenge.json().sessionId, code: "123456", linkToken: first.json().linkToken });
    expect(verified.json()).toMatchObject({ isNewDriver: false });
    expect((await profile(verified.json().accessToken)).json()).toMatchObject({ firstName: "Anna", lastName: "Lind" });
    expect((await post(app, "/auth/provider", { provider: "google", idToken: "ok:g-2", app: "driver" })).json().accessToken).toBeDefined();
  });

  it("a token the provider does not vouch for is refused", async () => {
    const res = await post(app, "/auth/provider", { provider: "google", idToken: "garbage", app: "driver" });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe("JwksVerifier", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...(publicKey.export({ format: "jwk" }) as Record<string, string>), kid: "k1", alg: "RS256", use: "sig" };
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const token = (claims: Record<string, unknown>, key: KeyObject = privateKey, kid = "k1") => {
    const head = `${b64({ alg: "RS256", kid, typ: "JWT" })}.${b64(claims)}`;
    return `${head}.${sign("sha256", Buffer.from(head), key).toString("base64url")}`;
  };
  const now = new Date("2026-10-26T10:00:00Z");
  const exp = Math.floor(now.getTime() / 1000) + 600;
  let fetches = 0;
  const verifier = new JwksVerifier("google", ["movera-ios", "movera-android"], async () => {
    fetches++;
    return { keys: [jwk] };
  });

  it("accepts a token signed by a published key for one of the client ids", async () => {
    const who = await verifier.verify(token({ iss: "https://accounts.google.com", aud: "movera-ios", sub: "123", exp, email: "a@b.se", email_verified: true, given_name: "Anna", family_name: "Lind" }), now);
    expect(who).toEqual({ subject: "123", email: "a@b.se", emailVerified: true, firstName: "Anna", lastName: "Lind" });
    expect(fetches).toBe(1);
    await verifier.verify(token({ iss: "accounts.google.com", aud: ["movera-android"], sub: "9", exp }), now);
    expect(fetches).toBe(1); // keys kept
  });

  it("refuses another issuer, another audience, an expired token, an unknown key and a bad signature", async () => {
    await expect(verifier.verify(token({ iss: "https://appleid.apple.com", aud: "movera-ios", sub: "1", exp }), now)).rejects.toMatchObject({ options: { reason: "invalid_provider_issuer" } });
    await expect(verifier.verify(token({ iss: "https://accounts.google.com", aud: "someone-else", sub: "1", exp }), now)).rejects.toMatchObject({ options: { reason: "invalid_provider_audience" } });
    await expect(verifier.verify(token({ iss: "https://accounts.google.com", aud: "movera-ios", sub: "1", exp: exp - 1200 }), now)).rejects.toMatchObject({ options: { reason: "provider_token_expired" } });
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
    await expect(verifier.verify(token({ iss: "https://accounts.google.com", aud: "movera-ios", sub: "1", exp }, other.privateKey), now)).rejects.toMatchObject({ options: { reason: "invalid_provider_token" } });
    await expect(verifier.verify(token({ iss: "https://accounts.google.com", aud: "movera-ios", sub: "1", exp }, privateKey, "k2"), now)).rejects.toMatchObject({ options: { reason: "unknown_provider_key" } });
    await expect(verifier.verify("not.a.jwt", now)).rejects.toMatchObject({ options: { reason: "invalid_provider_token" } });
  });

  it("splits a display name into first and last", () => {
    expect(splitName("Anna Lind")).toEqual({ firstName: "Anna", lastName: "Lind" });
    expect(splitName("Jean Pierre Dupont")).toEqual({ firstName: "Jean Pierre", lastName: "Dupont" });
    expect(splitName("Cher")).toEqual({ firstName: "Cher" });
    expect(splitName("  ")).toEqual({});
  });
});
