import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { maskPersonalNumber } from "../../src/admin/masking.js";
import { personalNumberOk } from "../../src/drivers/onboarding.js";
import { settingsProblems, signUpFieldsOf, twoSidedTypesOf, defaultSettings } from "../../src/drivers/onboardingSettings.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { call, signIn, testWorld } from "../support/world.js";

/**
 * Contract v0.18.166 (contract.json#signupV2; owner 2026-11-26 "Oui, tout construire", "Peut pas", "Oui, ajouter
 * l'adresse (Recommandé)"): PUT /driver/country cityId, the Swedish personnummer and taxi licence number, the home
 * address, signUpFields / twoSidedTypes, the admin address change, masking, and the locked approved profile photo.
 */
let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-11-26T10:00:00Z") };
let admin: { headers: Record<string, string>; adminId: string };
const db = () => database.db;
const ADDRESS = { street: "Storgatan 1", postalCode: "111 22", city: "Stockholm" };
// 19850312-1231: Luhn over 8503121231 -> valid.
const PN = "19850312-1231";
const se = (extra: Record<string, unknown> = {}) => ({
  firstName: "Ana", lastName: "Berg", dateOfBirth: "1985-03-12", email: "ana@example.se", country: "SE", cityId: "stockholm_lan", language: "sv",
  accountType: "driver", termsAccepted: true, personalNumber: PN, taxiLicenseNumber: "TX 12345", address: ADDRESS, ...extra,
});
const fr = (extra: Record<string, unknown> = {}) => ({
  firstName: "Luc", lastName: "Martin", dateOfBirth: "1988-04-01", email: "luc@example.fr", country: "FR", cityId: "paris", language: "fr",
  accountType: "driver", termsAccepted: true, address: { street: "1 rue de Rivoli", postalCode: "75001", city: "Paris" }, ...extra,
});
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 3)]);
function upload(headers: Record<string, string>, type: string, key: string) {
  const boundary = "----movera-166";
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="type"\r\n\r\n${type}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="me.png"\r\nContent-Type: image/png\r\n\r\n`),
    PNG,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return app.inject({ method: "POST", url: "/api/v1/driver/documents", headers: { ...headers, "content-type": `multipart/form-data; boundary=${boundary}`, "idempotency-key": key }, payload });
}

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  admin = await adminSession(app, database.db, "super", { now: clock.now });
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

describe("v0.18.166 sign-up v2", () => {
  it("personnummer Luhn and mask; defaults per country; settings checks", () => {
    expect(personalNumberOk(PN)).toBe(true);
    expect(personalNumberOk("19850312-1232")).toBe(false);
    expect(maskPersonalNumber(PN)).toBe("1985••••-••••");
    expect(signUpFieldsOf(defaultSettings("SE"))).toMatchObject({ personalNumber: { on: true, required: true }, dateOfBirth: { on: false }, address: { on: true, required: true } });
    expect(signUpFieldsOf(defaultSettings("FR"))).toMatchObject({ personalNumber: { on: false }, dateOfBirth: { on: true, required: true }, address: { on: true, required: true } });
    expect(twoSidedTypesOf(defaultSettings("FR"))).toEqual(["national_id", "driving_license", "vtc_card"]);
    const bad = { ...defaultSettings("SE"), signUpFields: { address: { on: false, required: true }, nickname: { on: true, required: false } }, twoSidedTypes: ["driving_license", "driving_license", "info_session"] };
    const problems = settingsProblems(bad);
    expect(problems).toEqual(expect.arrayContaining(["signUpFields.address: a required field must be on", "signUpFields: unknown field nickname", "twoSidedTypes: a type is listed twice", "twoSidedTypes: info_session is not a file"]));
  });

  it("PUT /driver/country takes the Région; an unknown one is invalid_city", async () => {
    const me = (await signIn(app, TEST_PHONES[0]!, "driver")).headers;
    expect((await call(app, "PUT", "/driver/country", me, { country: "SE", cityId: "paris" })).json()).toMatchObject({ reason: "invalid_city" });
    const ok = await call(app, "PUT", "/driver/country", me, { country: "SE", cityId: "stockholm_lan" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ country: "SE", cityId: "stockholm_lan" });
  });

  it("Sweden: personnummer and address required and checked; saved and returned; masked for an admin without viewSensitive", async () => {
    const me = (await signIn(app, TEST_PHONES[1]!, "driver")).headers;
    await call(app, "PUT", "/driver/country", me, { country: "SE" });
    const missing = await call(app, "POST", "/driver/onboarding", me, se({ personalNumber: undefined }));
    expect(missing.json()).toMatchObject({ reason: "field_required", details: ["personalNumber"] });
    const noAddress = await call(app, "POST", "/driver/onboarding", me, se({ address: undefined }));
    expect(noAddress.json()).toMatchObject({ reason: "field_required", details: ["address"] });
    expect((await call(app, "POST", "/driver/onboarding", me, se({ personalNumber: "19850312-1232" }))).json()).toMatchObject({ reason: "invalid_personal_number" });
    expect((await call(app, "POST", "/driver/onboarding", me, se({ dateOfBirth: "1985-03-13" }))).json()).toMatchObject({ reason: "invalid_personal_number" });
    expect((await call(app, "POST", "/driver/onboarding", me, se({ address: { ...ADDRESS, city: " " } }))).json()).toMatchObject({ reason: "invalid_address" });
    expect((await call(app, "POST", "/driver/onboarding", me, se({ taxiLicenseNumber: "!!" }))).json()).toMatchObject({ reason: "invalid_taxi_license_number" });
    const ok = await call(app, "POST", "/driver/onboarding", me, se({ personalNumber: "198503121231" }));
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ personalNumber: PN, taxiLicenseNumber: "TX 12345", address: ADDRESS });
    const id = ok.json().driverId as string;
    const full = (await call(app, "GET", `/admin/drivers/${id}`, admin.headers)).json();
    expect(full).toMatchObject({ personalNumber: PN, address: ADDRESS });
    const viewer = await adminSession(app, db(), "viewer", { now: clock.now });
    const masked = (await call(app, "GET", `/admin/drivers/${id}`, viewer.headers)).json();
    expect(masked).toMatchObject({ personalNumber: "1985••••-••••", address: { street: "S•••", postalCode: "111 22", city: "Stockholm" }, sensitiveMasked: true });
  });

  it("France: address required, no personnummer asked (sent anyway: ignored)", async () => {
    const me = (await signIn(app, TEST_PHONES[2]!, "driver")).headers;
    await call(app, "PUT", "/driver/country", me, { country: "FR" });
    expect((await call(app, "POST", "/driver/onboarding", me, fr({ address: undefined }))).json()).toMatchObject({ reason: "field_required", details: ["address"] });
    const ok = await call(app, "POST", "/driver/onboarding", me, fr({ personalNumber: PN }));
    expect(ok.statusCode).toBe(200);
    expect(ok.json().personalNumber).toBeUndefined();
    expect(ok.json().address).toEqual({ street: "1 rue de Rivoli", postalCode: "75001", city: "Paris" });
  });

  it("admin changes the address: reason, version, audit without the address text", async () => {
    const me = (await signIn(app, TEST_PHONES[3]!, "driver")).headers;
    await call(app, "PUT", "/driver/country", me, { country: "FR" });
    const d = (await call(app, "POST", "/driver/onboarding", me, fr({ email: "x@example.fr" }))).json();
    const url = `/admin/drivers/${d.driverId}/address`;
    const next = { street: "2 rue de Rivoli", postalCode: "75004", city: "Paris" };
    expect((await call(app, "POST", url, admin.headers, { expectedVersion: d.version, address: next, reason: " " })).json()).toMatchObject({ reason: "reason_required" });
    expect((await call(app, "POST", url, admin.headers, { expectedVersion: d.version + 9, address: next, reason: "Moved" })).json()).toMatchObject({ code: "version_mismatch" });
    const ok = await call(app, "POST", url, admin.headers, { expectedVersion: d.version, address: next, reason: "Moved" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().address).toEqual(next);
    const entry = await db().selectFrom("admin_audit").selectAll().where("action", "=", "driver.address").where("target_id", "=", d.driverId).executeTakeFirstOrThrow();
    expect(JSON.stringify(entry.detail)).not.toContain("Rivoli");
  });

  it("profile photo: retake before approval; locked once approved (409 profile_photo_locked, nothing saved)", async () => {
    const me = (await signIn(app, TEST_PHONES[4]!, "driver")).headers;
    await call(app, "PUT", "/driver/country", me, { country: "SE" });
    const first = await upload(me, "profile_photo", "sv2-photo-key-0001");
    expect(first.statusCode, first.body).toBe(201);
    expect((await upload(me, "profile_photo", "sv2-photo-key-0002")).statusCode).toBe(201);
    await db().updateTable("documents").set({ status: "approved" }).where("document_id", "=", first.json().documentId).execute();
    const locked = await upload(me, "profile_photo", "sv2-photo-key-0003");
    expect(locked.statusCode).toBe(409);
    expect(locked.json()).toMatchObject({ code: "invalid_transition", reason: "profile_photo_locked" });
    expect(await db().selectFrom("document_renewals").select("renewal_id").where("document_id", "=", first.json().documentId).execute()).toEqual([]);
    // Other documents still renew as before.
    const lic = await upload(me, "driving_license", "sv2-licence-key-0001");
    expect(lic.statusCode, lic.body).toBe(201);
  });
});
