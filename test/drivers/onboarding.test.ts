import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { approveDriverDocuments } from "../support/seed.js";
import { call, signIn, testWorld } from "../support/world.js";

/** contract v0.5.3 §14: the details screen, fleets with a join code (an invitation the owner accepts), fleet cars, documents, the admin side. */

let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-10-26T09:00:00Z") };
let owner: Record<string, string>;
let member: Record<string, string>;
let second: Record<string, string>;
let admin: { headers: Record<string, string>; adminId: string };
let fleetId: string;
let fleetCode: string;
let ownerId: string;
let memberId: string;
let carId: string;

const details = (extra: Record<string, unknown> = {}) => ({
  firstName: "Fredrik",
  lastName: "Åkesson",
  dateOfBirth: "1985-03-12",
  email: "fredrik@example.se",
  country: "SE",
  cityId: "stockholm_lan",
  language: "sv",
  accountType: "fleet",
  termsAccepted: true,
  company: { name: "Åkessons Taxi AB", orgNumber: "556677-8899", address: "Storgatan 1, Södertälje" },
  ...extra,
});
const me = async (headers: Record<string, string>) => (await call(app, "GET", "/driver/profile", headers)).json();
/** v0.5.3: joining is a request the owner accepts (invitations.test.ts covers the invitation itself). */
async function joinAndAccept(driver: Record<string, string>) {
  const request = await call(app, "POST", "/driver/fleet/join", driver, { code: fleetCode, ownerName: "Fredrik Åkesson", ownerEmail: "fredrik@example.se" });
  expect(request.statusCode).toBe(201);
  const accepted = await call(app, "POST", `/driver/fleet/invitations/${request.json().invitationId}/accept`, owner);
  expect(accepted.statusCode).toBe(200);
}

/** A multipart body with the fields and one file, as the app sends it. */
function multipart(fields: Record<string, string>, file: { name: string; type: string; bytes: Buffer }) {
  const boundary = "----movera-test-boundary";
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`), file.bytes, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}
async function upload(headers: Record<string, string>, fields: Record<string, string>, file = { name: "licence.jpg", type: "image/jpeg", bytes: Buffer.from("jpeg-bytes-".repeat(100)) }) {
  const body = multipart(fields, file);
  return app.inject({ method: "POST", url: "/api/v1/driver/documents", headers: { ...headers, ...body.headers, "idempotency-key": `up-${Math.random()}` }, payload: body.payload });
}

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  owner = (await signIn(app, TEST_PHONES[2]!, "driver")).headers;
  member = (await signIn(app, TEST_PHONES[3]!, "driver")).headers;
  second = (await signIn(app, TEST_PHONES[4]!, "driver")).headers;
  admin = await adminSession(app, database.db, "ops", { zoneIds: ["Z001", "Z009"], now: clock.now });
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

describe("the details screen", () => {
  it("a new driver is pending with the open countries' documents still to come", async () => {
    const fresh = await me(owner);
    expect(fresh).toMatchObject({ accountStatus: "pending", documents: [], requiredDocuments: [] });
    expect(fresh).not.toHaveProperty("accountType");
  });

  it("refuses a closed country, a too young driver, a fleet without a company, missing terms", async () => {
    const closed = await call(app, "POST", "/driver/onboarding", owner, details({ country: "TN", cityId: "tunis" }));
    expect(closed.json()).toMatchObject({ code: "invalid_request", reason: "country_not_open" });
    const young = await call(app, "POST", "/driver/onboarding", owner, details({ dateOfBirth: "2006-01-01" }));
    expect(young.json()).toMatchObject({ reason: "under_age" });
    const noCompany = await call(app, "POST", "/driver/onboarding", owner, details({ company: undefined }));
    expect(noCompany.json()).toMatchObject({ reason: "company_required" });
    const noTerms = await call(app, "POST", "/driver/onboarding", owner, details({ termsAccepted: false }));
    expect(noTerms.statusCode).toBe(400);
    const badCity = await call(app, "POST", "/driver/onboarding", owner, details({ cityId: "paris" }));
    expect(badCity.json()).toMatchObject({ reason: "invalid_city" });
  });

  it("a fleet account: details saved, on hold, the company pending, the terms approved, the documents listed", async () => {
    const res = await call(app, "POST", "/driver/onboarding", owner, details());
    expect(res.statusCode).toBe(200);
    const d = res.json();
    ownerId = d.driverId;
    expect(d).toMatchObject({
      accountStatus: "on_hold",
      accountType: "fleet",
      firstName: "Fredrik",
      lastName: "Åkesson",
      dateOfBirth: "1985-03-12",
      email: "fredrik@example.se",
      country: "SE",
      cityId: "stockholm_lan",
      language: "sv",
      zoneIds: ["Z001"],
      payoutTo: "self",
      fleet: { name: "Åkessons Taxi AB", role: "owner", status: "pending" },
      requiredDocuments: ["terms", "info_session", "driving_license", "profile_photo", "taxi_driver_license"],
      requiredFleetDocuments: ["company_registration", "taxi_traffic_permit", "tax_settings", "bank_statement"],
    });
    expect(d.termsAcceptedAt).toBeDefined();
    expect(d.documents).toEqual([expect.objectContaining({ type: "terms", status: "approved" })]);
    fleetId = d.fleet.fleetId;
    // The owner sees the company, no code yet.
    const view = (await call(app, "GET", "/driver/fleet", owner)).json();
    expect(view.fleet).toMatchObject({ fleetId, status: "pending", ownerName: "Fredrik Åkesson", ownerEmail: "fredrik@example.se", driverCount: 1, vehicleCount: 0 });
    expect(view.fleet).not.toHaveProperty("code");
  });

  it("cannot go online while on hold", async () => {
    const d = await me(owner);
    const res = await call(app, "POST", "/driver/availability", owner, { expectedVersion: d.version, onlineStatus: "online" });
    expect(res.json()).toMatchObject({ code: "invalid_transition", reason: "account_not_active" });
  });

  it("a driver account in France: its own documents; no fleet yet, no cars", async () => {
    const res = await call(app, "POST", "/driver/onboarding", member, details({ firstName: "Karim", lastName: "Ben Ali", email: "karim@example.fr", country: "FR", cityId: "paris", language: "fr", accountType: "driver", company: undefined }));
    expect(res.statusCode).toBe(200);
    memberId = res.json().driverId;
    expect(res.json()).toMatchObject({ accountStatus: "on_hold", accountType: "driver", zoneIds: ["FR-PC"], requiredDocuments: ["terms", "vtc_card", "driving_license", "national_id", "profile_photo"] });
    expect(res.json()).not.toHaveProperty("fleet");
    expect(res.json()).not.toHaveProperty("payoutTo");
    expect((await call(app, "GET", "/driver/fleet", member)).statusCode).toBe(404);
    expect((await call(app, "GET", "/driver/vehicles", member)).json()).toEqual({ items: [], nextCursor: null });
    const car = await call(app, "POST", "/driver/vehicles", member, { make: "Peugeot", model: "508", year: 2022, color: "Grey", plate: "AB-123-CD", seats: 4 });
    expect(car.json()).toMatchObject({ code: "forbidden", reason: "fleet_vehicles_only" });
  });
});

describe("the admin approves the fleet and gets the code", () => {
  it("lists the pending fleet in its zones and approves it; the code appears for the owner", async () => {
    const list = (await call(app, "GET", "/admin/fleets?status=pending", admin.headers)).json();
    expect(list.items).toEqual([expect.objectContaining({ fleetId, name: "Åkessons Taxi AB", status: "pending" })]);
    const review = await call(app, "POST", `/admin/fleets/${fleetId}/review`, admin.headers, { expectedVersion: list.items[0].version, decision: "approved", note: "Papers checked" });
    expect(review.statusCode).toBe(200);
    expect(review.json()).toMatchObject({ status: "approved" });
    expect(review.json().code).toMatch(/^MV-[A-Z2-9]{5}$/);
    fleetCode = review.json().code;
    const view = (await call(app, "GET", "/driver/fleet", owner)).json();
    expect(view.fleet.code).toBe(fleetCode);
    const detail = (await call(app, "GET", `/admin/fleets/${fleetId}`, admin.headers)).json();
    expect(detail.fleet.code).toBe(fleetCode);
    expect(detail.drivers).toEqual([expect.objectContaining({ driverId: ownerId, accountStatus: "on_hold" })]);
  });

  it("a zone-scoped admin outside the fleet's zone sees nothing and may not review it", async () => {
    const paris = await adminSession(app, database.db, "ops", { zoneIds: ["FR-PC"], now: clock.now });
    expect((await call(app, "GET", "/admin/fleets", paris.headers)).json().items).toEqual([]);
    expect((await call(app, "GET", `/admin/fleets/${fleetId}`, paris.headers)).statusCode).toBe(403);
    // ...but sees the Paris driver.
    expect((await call(app, "GET", `/admin/drivers/${memberId}`, paris.headers)).json()).toMatchObject({ driverId: memberId, country: "FR" });
    expect((await call(app, "GET", `/admin/drivers/${memberId}`, admin.headers)).statusCode).toBe(403);
  });
});

describe("joining the fleet", () => {
  it("needs the code, the owner's name and e-mail together; one mismatch message", async () => {
    const wrongName = await call(app, "POST", "/driver/fleet/join", member, { code: fleetCode, ownerName: "Someone Else", ownerEmail: "fredrik@example.se" });
    expect(wrongName.json()).toMatchObject({ code: "invalid_request", reason: "fleet_join_mismatch" });
    const wrongMail = await call(app, "POST", "/driver/fleet/join", member, { code: fleetCode, ownerName: "Fredrik Åkesson", ownerEmail: "other@example.se" });
    expect(wrongMail.json()).toMatchObject({ reason: "fleet_join_mismatch" });
    const wrongCode = await call(app, "POST", "/driver/fleet/join", member, { code: "MV-AAAAA", ownerName: "Fredrik Åkesson", ownerEmail: "fredrik@example.se" });
    expect(wrongCode.json()).toMatchObject({ reason: "fleet_join_mismatch" });
  });

  it("a matching request waits for the owner, who accepts it; then the driver is linked", async () => {
    const res = await call(app, "POST", "/driver/fleet/join", member, { code: fleetCode.toLowerCase().replace("mv-", "mv "), ownerName: "  åkesson   FREDRIK ", ownerEmail: "Fredrik@Example.SE" });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ fleetId, direction: "driver_request", status: "pending", driverId: memberId, driverName: "Karim Ben Ali" });
    const invitationId = res.json().invitationId;
    expect(await me(member)).not.toHaveProperty("fleet");
    expect((await call(app, "GET", "/driver/fleet/invitations", member)).json().items).toEqual([expect.objectContaining({ invitationId })]);
    // The owner is told and sees it on his fleet.
    expect((await me(owner)).pendingFleetInvitations).toBe(1);
    const ownerFleet = (await call(app, "GET", "/driver/fleet", owner)).json();
    expect(ownerFleet.invitations).toEqual([expect.objectContaining({ invitationId, direction: "driver_request" })]);
    const twice = await call(app, "POST", "/driver/fleet/join", member, { code: fleetCode, ownerName: "Fredrik Åkesson", ownerEmail: "fredrik@example.se" });
    expect(twice.json()).toMatchObject({ code: "conflict", reason: "request_pending" });
    const accepted = await call(app, "POST", `/driver/fleet/invitations/${invitationId}/accept`, owner);
    expect(accepted.json()).toMatchObject({ invitationId, status: "accepted" });
    expect(await me(member)).toMatchObject({ fleet: { fleetId, role: "member", status: "approved" }, payoutTo: "fleet" });
    const view = (await call(app, "GET", "/driver/fleet", member)).json();
    expect(view.fleet).not.toHaveProperty("code");
    expect(view.fleet).not.toHaveProperty("ownerEmail");
    expect(view.drivers).toEqual([]);
    expect(view).not.toHaveProperty("invitations");
    const ownerView = (await call(app, "GET", "/driver/fleet", owner)).json();
    expect(ownerView.drivers.map((d: { driverId: string }) => d.driverId)).toEqual([ownerId, memberId]);
    expect(ownerView.invitations).toEqual([]);
    const again = await call(app, "POST", "/driver/fleet/join", member, { code: fleetCode, ownerName: "Fredrik Åkesson", ownerEmail: "fredrik@example.se" });
    expect(again.json()).toMatchObject({ code: "invalid_transition", reason: "already_in_fleet" });
    const asOwner = await call(app, "POST", "/driver/fleet/join", owner, { code: fleetCode, ownerName: "Fredrik Åkesson", ownerEmail: "fredrik@example.se" });
    expect(asOwner.json()).toMatchObject({ reason: "fleet_account" });
  });

  it("stops after ten tries in an hour", async () => {
    await call(app, "POST", "/driver/onboarding", second, details({ firstName: "Lina", lastName: "Berg", email: "lina@example.se", accountType: "driver", company: undefined }));
    let last;
    for (let i = 0; i < 11; i++) last = await call(app, "POST", "/driver/fleet/join", second, { code: "MV-BBBBB", ownerName: "x", ownerEmail: "x@example.se" });
    expect(last!.statusCode).toBe(429);
    expect(last!.headers["retry-after"]).toBe("3600");
  });
});

describe("the fleet's cars", () => {
  it("the owner adds a car; the admin lists and approves it; the member sees it and picks it", async () => {
    const car = await call(app, "POST", "/driver/vehicles", owner, { make: "Volvo", model: "V90", year: 2023, color: "Black", plate: "FLT 001", seats: 4, categoryIds: ["economy", "comfort"] });
    expect(car.statusCode).toBe(201);
    expect(car.json()).toMatchObject({ fleetId, status: "pending", inUse: false, documents: [], requiredDocuments: ["vehicle_registration", "insurance"] });
    carId = car.json().vehicleId;
    // Pending: not in the member's list yet.
    expect((await call(app, "GET", "/driver/vehicles", member)).json().items).toEqual([]);
    const list = (await call(app, "GET", `/admin/vehicles?fleetId=${fleetId}`, admin.headers)).json();
    expect(list.items).toEqual([expect.objectContaining({ vehicleId: carId, status: "pending" })]);
    const review = await call(app, "POST", `/admin/vehicles/${carId}/review`, admin.headers, { expectedVersion: 1, decision: "approved" });
    expect(review.json()).toMatchObject({ status: "approved", version: 2 });
    const mine = (await call(app, "GET", "/driver/vehicles", member)).json();
    expect(mine.items).toEqual([expect.objectContaining({ vehicleId: carId, status: "approved" })]);
    const m = await me(member);
    const pick = await call(app, "PATCH", "/driver/profile", member, { expectedVersion: m.version, vehicleId: carId });
    expect(pick.json()).toMatchObject({ vehicleId: carId, categoryIds: ["economy", "comfort"] });
    expect((await call(app, "GET", "/driver/vehicles", owner)).json().items[0]).toMatchObject({ driverId: memberId, inUse: false });
  });

  it("an active member goes online with the car; the owner cannot take it while it is in use", async () => {
    // The Paris driver joined a Swedish fleet; activate through a Super admin to keep the test about cars.
    const sup = await adminSession(app, database.db, "super", { now: clock.now });
    const d = (await call(app, "GET", `/admin/drivers/${memberId}`, sup.headers)).json().version;
    // v0.10.1: activation is refused until every required document is approved, and says which are missing.
    const refused = await call(app, "POST", `/admin/drivers/${memberId}/status`, sup.headers, { expectedVersion: d, accountStatus: "active", note: "Too early" });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("documents_not_approved");
    expect(refused.json().details.length).toBeGreaterThan(0);
    await approveDriverDocuments(database.db, memberId);
    const active = await call(app, "POST", `/admin/drivers/${memberId}/status`, sup.headers, { expectedVersion: d, accountStatus: "active", note: "Documents checked" });
    expect(active.json()).toMatchObject({ accountStatus: "active" });
    // The documents tests below upload the member's own files; take the seeded approvals away again.
    await database.db.deleteFrom("documents").where("owner_id", "=", memberId).where("reviewed_by", "=", "seed").execute();
    const m = await me(member);
    const online = await call(app, "POST", "/driver/availability", member, { expectedVersion: m.version, onlineStatus: "online" });
    expect(online.json()).toMatchObject({ onlineStatus: "online" });
    expect((await call(app, "GET", "/driver/vehicles", owner)).json().items[0]).toMatchObject({ driverId: memberId, inUse: true });
    const o = await me(owner);
    const take = await call(app, "PATCH", "/driver/profile", owner, { expectedVersion: o.version, vehicleId: carId });
    expect(take.json()).toMatchObject({ code: "conflict", reason: "vehicle_in_use" });
    await call(app, "POST", "/driver/availability", member, { expectedVersion: m.version + 1, onlineStatus: "offline" });
    // Offline: the owner's pick moves the car; the member has no car until he picks again.
    const moved = await call(app, "PATCH", "/driver/profile", owner, { expectedVersion: o.version, vehicleId: carId });
    expect(moved.json()).toMatchObject({ vehicleId: carId });
    expect(await me(member)).not.toHaveProperty("vehicleId");
    const m2 = await me(member);
    expect((await call(app, "POST", "/driver/availability", member, { expectedVersion: m2.version, onlineStatus: "online" })).json()).toMatchObject({ reason: "no_vehicle" });
  });

  it("a driver without a fleet cannot go online even when active", async () => {
    const sup = await adminSession(app, database.db, "super", { now: clock.now });
    const s = await me(second);
    await approveDriverDocuments(database.db, s.driverId);
    await call(app, "POST", `/admin/drivers/${s.driverId}/status`, sup.headers, { expectedVersion: s.version, accountStatus: "active", note: "ok" });
    const s2 = await me(second);
    expect((await call(app, "POST", "/driver/availability", second, { expectedVersion: s2.version, onlineStatus: "online" })).json()).toMatchObject({ reason: "no_fleet" });
  });
});

describe("documents", () => {
  let licenceId: string;
  it("uploads a file, lists it in review with the file path, replaces it on a new upload", async () => {
    const res = await upload(member, { type: "driving_license" });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ ownerId: memberId, type: "driving_license", status: "in_review", fileName: "licence.jpg", mediaType: "image/jpeg", version: 1 });
    licenceId = res.json().documentId;
    expect(res.json().fileUrl).toBe(`/api/v1/driver/documents/${licenceId}/file`);
    expect((await me(member)).documents).toEqual(expect.arrayContaining([expect.objectContaining({ documentId: licenceId, type: "driving_license", status: "in_review" })]));
    const again = await upload(member, { type: "driving_license" }, { name: "licence2.pdf", type: "application/pdf", bytes: Buffer.from("%PDF-1.4 test") });
    expect(again.json()).toMatchObject({ documentId: licenceId, fileName: "licence2.pdf", mediaType: "application/pdf", version: 2 });
    const list = (await call(app, "GET", "/driver/documents", member)).json();
    expect(list.items.map((d: { type: string }) => d.type).sort()).toEqual(["driving_license", "terms"]);
  });

  it("refuses an unknown type, a wrong media type, a too large file and a non-file type", async () => {
    expect((await upload(member, { type: "passport_scan" })).json()).toMatchObject({ reason: "unknown_document_type" });
    expect((await upload(member, { type: "profile_photo" }, { name: "x.gif", type: "image/gif", bytes: Buffer.from("gif") })).json()).toMatchObject({ reason: "unsupported_file_type" });
    expect((await upload(member, { type: "terms" })).json()).toMatchObject({ reason: "not_a_file_document" });
    const big = await upload(member, { type: "profile_photo" }, { name: "big.jpg", type: "image/jpeg", bytes: Buffer.alloc(10 * 1024 * 1024 + 10, 1) });
    expect(big.json()).toMatchObject({ reason: "file_too_large" });
    expect((await upload(member, { type: "vehicle_registration" })).json()).toMatchObject({ reason: "wrong_document_owner" });
  });

  it("the owner uploads a car's document; a member cannot", async () => {
    const res = await upload(owner, { type: "vehicle_registration", ownerId: carId });
    expect(res.json()).toMatchObject({ ownerId: carId, type: "vehicle_registration", status: "in_review" });
    expect((await call(app, "GET", "/driver/vehicles", owner)).json().items[0].documents).toEqual([expect.objectContaining({ type: "vehicle_registration" })]);
    expect((await upload(member, { type: "vehicle_registration", ownerId: carId })).json()).toMatchObject({ reason: "vehicle_not_found" });
  });

  it("only the owner of a file (or his fleet owner, or an admin) reads it; the admin's read is in the audit", async () => {
    const mine = await app.inject({ method: "GET", url: `/api/v1/driver/documents/${licenceId}/file`, headers: member });
    expect(mine.statusCode).toBe(200);
    expect(mine.headers["content-type"]).toBe("application/pdf");
    expect(mine.headers["cache-control"]).toBe("private, no-store");
    expect(mine.rawPayload.toString()).toBe("%PDF-1.4 test");
    expect((await app.inject({ method: "GET", url: `/api/v1/driver/documents/${licenceId}/file`, headers: owner })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/v1/driver/documents/${licenceId}/file`, headers: second })).statusCode).toBe(404);
    const sup = await adminSession(app, database.db, "super", { now: clock.now });
    const byAdmin = await app.inject({ method: "GET", url: `/api/v1/admin/documents/${licenceId}/file`, headers: sup.headers });
    expect(byAdmin.statusCode).toBe(200);
    expect(byAdmin.rawPayload.toString()).toBe("%PDF-1.4 test");
    const viewer = await adminSession(app, database.db, "viewer", { now: clock.now });
    expect((await app.inject({ method: "GET", url: `/api/v1/admin/documents/${licenceId}/file`, headers: viewer.headers })).statusCode).toBe(403);
    const audit = (await call(app, "GET", `/admin/audit?targetId=${licenceId}`, sup.headers)).json();
    expect(audit.items.some((a: { action: string }) => a.action === "document.file")).toBe(true);
    // The file is not stored in clear.
    const stored = await database.pool.query<{ ciphertext: Buffer }>("SELECT ciphertext FROM document_files WHERE document_id = $1", [licenceId]);
    expect(stored.rows[0]!.ciphertext.includes(Buffer.from("%PDF"))).toBe(false);
  });

  it("the admin approves or rejects with a note; the driver sees the status", async () => {
    const sup = await adminSession(app, database.db, "super", { now: clock.now });
    const approved = await call(app, "POST", `/admin/documents/${licenceId}/review`, sup.headers, { decision: "approved", expiresAt: "2030-01-01T00:00:00Z" });
    expect(approved.json()).toMatchObject({ status: "approved", expiresAt: "2030-01-01T00:00:00.000Z", version: 3 });
    expect(approved.json().fileUrl).toBe(`/api/v1/admin/documents/${licenceId}/file`);
    expect((await me(member)).documents).toEqual(expect.arrayContaining([expect.objectContaining({ documentId: licenceId, status: "approved", expiresAt: "2030-01-01T00:00:00.000Z" })]));
    const photo = (await upload(member, { type: "profile_photo" })).json();
    const rejected = await call(app, "POST", `/admin/documents/${photo.documentId}/review`, sup.headers, { decision: "rejected", note: "Too dark" });
    expect(rejected.json()).toMatchObject({ status: "rejected", reviewNote: "Too dark" });
  });
});

describe("leaving and removing", () => {
  it("the owner cannot leave; a member leaves and is back to waiting for a fleet", async () => {
    expect((await call(app, "POST", "/driver/fleet/leave", owner)).json()).toMatchObject({ code: "invalid_transition", reason: "fleet_owner" });
    const left = await call(app, "POST", "/driver/fleet/leave", member);
    expect(left.statusCode).toBe(200);
    expect(left.json()).not.toHaveProperty("fleet");
    expect(left.json()).not.toHaveProperty("payoutTo");
    expect((await call(app, "GET", "/driver/fleet", member)).statusCode).toBe(404);
    expect((await call(app, "GET", "/driver/fleet", owner)).json().drivers.map((d: { driverId: string }) => d.driverId)).toEqual([ownerId]);
  });

  it("the owner removes a driver; the admin removes a driver and renews the code", async () => {
    await joinAndAccept(member);
    expect((await call(app, "POST", `/driver/fleet/drivers/${memberId}/remove`, owner)).statusCode).toBe(204);
    expect((await me(member))).not.toHaveProperty("fleet");
    expect((await call(app, "POST", `/driver/fleet/drivers/${memberId}/remove`, member)).statusCode).toBe(403);
    await joinAndAccept(member);
    expect((await call(app, "POST", `/admin/fleets/${fleetId}/drivers/${memberId}/remove`, admin.headers)).statusCode).toBe(204);
    expect((await me(member))).not.toHaveProperty("fleet");
    const fleet = (await call(app, "GET", `/admin/fleets/${fleetId}`, admin.headers)).json().fleet;
    const renewed = await call(app, "POST", `/admin/fleets/${fleetId}/code`, admin.headers, { expectedVersion: fleet.version });
    expect(renewed.json().code).toMatch(/^MV-[A-Z2-9]{5}$/);
    expect(renewed.json().code).not.toBe(fleetCode);
    const old = await call(app, "POST", "/driver/fleet/join", member, { code: fleetCode, ownerName: "Fredrik Åkesson", ownerEmail: "fredrik@example.se" });
    expect(old.json()).toMatchObject({ reason: "fleet_join_mismatch" });
    fleetCode = renewed.json().code;
    await joinAndAccept(member);
  });

  it("the owner's earnings overview lists every driver; the member may not read it", async () => {
    const res = await call(app, "GET", "/driver/fleet/earnings", owner);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ total: { amountMinor: 0, currency: "SEK" } });
    expect(res.json().items.map((i: { driverId: string }) => i.driverId)).toEqual([ownerId, memberId]);
    expect((await call(app, "GET", "/driver/fleet/earnings", member)).statusCode).toBe(403);
  });

  it("blocking the fleet takes its drivers offline and keeps them from going online", async () => {
    const m = await me(member);
    await call(app, "PATCH", "/driver/profile", owner, { expectedVersion: (await me(owner)).version, vehicleId: carId });
    const fleet = (await call(app, "GET", `/admin/fleets/${fleetId}`, admin.headers)).json().fleet;
    const blocked = await call(app, "POST", `/admin/fleets/${fleetId}/review`, admin.headers, { expectedVersion: fleet.version, decision: "blocked", note: "Unpaid" });
    expect(blocked.json()).toMatchObject({ status: "blocked" });
    const m2 = await me(member);
    expect(m2.version).toBeGreaterThan(m.version);
    expect((await call(app, "POST", "/driver/availability", member, { expectedVersion: m2.version, onlineStatus: "online" })).json()).toMatchObject({ reason: "fleet_not_approved" });
  });
});
