import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { contract } from "../../src/contract/contract.js";
import { expiredBlockers } from "../../src/drivers/readiness.js";
import { rulesBrokenBy, type VehicleRow } from "../../src/drivers/service.js";
import { driverPhotoUrl } from "../../src/trips/driverPhoto.js";
import { newId } from "../../src/ids.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertTrip, signup } from "../support/seed.js";
import { call, signIn, testWorld } from "../support/world.js";

/**
 * Contract v0.18.5 §30, deep second audit of driver group 2 (Rules decisions/driver-g2.md): D1 renewal keeps the approved
 * document, D2 the fleet owner sees nothing of his drivers' documents, D3 the rider sees the approved photo, D4 notices on
 * remove / leave, D5.2 real files, D5.3 categories from the admin, D5.4 the test cars, D5.5 / D5.6 invitations, D5.7 a
 * reason for every rejection, D5.8 end date at most 15 years ahead. Sweden and France.
 */

let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-11-04T09:00:00Z") };
let sup: { headers: Record<string, string> };
const H: Record<string, Record<string, string>> = {};
const ID: Record<string, string> = {};
const FLEET: Record<string, string> = {};

const PEOPLE = {
  seOwner: { phone: 0, country: "SE", cityId: "stockholm_lan", language: "sv", accountType: "fleet", firstName: "Anna", lastName: "Lind", email: "anna@example.se", orgNumber: "556600-2222" },
  seDriver: { phone: 1, country: "SE", cityId: "stockholm_lan", language: "sv", accountType: "driver", firstName: "Omar", lastName: "Said", email: "omar@example.se" },
  seInvitee: { phone: 2, country: "SE", cityId: "stockholm_lan", language: "sv", accountType: "driver", firstName: "Lina", lastName: "Berg", email: "lina@example.se" },
  frOwner: { phone: 3, country: "FR", cityId: "paris", language: "fr", accountType: "fleet", firstName: "Hugo", lastName: "Petit", email: "hugo@example.fr", orgNumber: "123456780" },
  frDriver: { phone: 4, country: "FR", cityId: "paris", language: "fr", accountType: "driver", firstName: "Sarah", lastName: "Benali", email: "sarah@example.fr" },
  frInvitee: { phone: 5, country: "FR", cityId: "paris", language: "fr", accountType: "driver", firstName: "Paul", lastName: "Martin", email: "paul@example.fr" },
} as const;
type Who = keyof typeof PEOPLE;

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]), Buffer.alloc(200, 7)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 3)]);
const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(200, 1)]);
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic"), Buffer.alloc(200, 2)]);

function multipart(fields: Record<string, string>, file: Buffer, mediaType: string, name = "doc.jpg") {
  const boundary = "----movera-deepfix-boundary";
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${mediaType}\r\n\r\n`), file, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}
const uploadRaw = (who: Who, fields: Record<string, string>, file: Buffer = JPEG, mediaType = "image/jpeg") => {
  const body = multipart(fields, file, mediaType);
  return app.inject({ method: "POST", url: "/api/v1/driver/documents", headers: { ...H[who]!, ...body.headers, "idempotency-key": `deep-${Math.random()}` }, payload: body.payload });
};
async function upload(who: Who, fields: Record<string, string>, file: Buffer = JPEG, mediaType = "image/jpeg") {
  const res = await uploadRaw(who, fields, file, mediaType);
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { documentId: string; status: string; renewalOf?: string; mediaType: string; expiresAt?: string };
}
const review = (documentId: string, body: Record<string, unknown>) => call(app, "POST", `/admin/documents/${documentId}/review`, sup.headers, body);
const notices = async (who: Who) => (await call(app, "GET", "/notifications?limit=50", H[who]!)).json().items as Array<{ kind: string; title: string; body: string; deepLink?: string; data?: Record<string, unknown> }>;
const reminders = async (who: Who) => (await call(app, "GET", "/driver/reminders", H[who]!)).json().items as Array<Record<string, unknown>>;
const days = (n: number) => new Date(clock.now.getTime() + n * 86_400_000).toISOString();
const driverRow = (who: Who) => database.db.selectFrom("drivers").select(["driver_id", "country", "account_type"]).where("driver_id", "=", ID[who]!).executeTakeFirstOrThrow();
const pair = (country: "SE" | "FR") => (country === "SE" ? { owner: "seOwner", driver: "seDriver", invitee: "seInvitee" } : { owner: "frOwner", driver: "frDriver", invitee: "frInvitee" }) as { owner: Who; driver: Who; invitee: Who };

async function joinFleet(owner: Who, driver: Who) {
  const invite = await call(app, "POST", "/driver/fleet/invite", H[owner]!, { phone: TEST_PHONES[PEOPLE[driver].phone]! });
  expect(invite.statusCode, invite.body).toBe(201);
  const accept = await call(app, "POST", `/driver/fleet/invitations/${invite.json().invitationId}/accept`, H[driver]!, {});
  expect(accept.statusCode, accept.body).toBe(200);
}

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  sup = await adminSession(app, database.db, "super", { now: clock.now });
  for (const [who, p] of Object.entries(PEOPLE) as Array<[Who, (typeof PEOPLE)[Who]]>) {
    H[who] = (await signIn(app, TEST_PHONES[p.phone]!, "driver")).headers;
    const res = await call(app, "POST", "/driver/onboarding", H[who]!, signup({
      firstName: p.firstName, lastName: p.lastName, dateOfBirth: "1988-04-01", email: p.email, country: p.country, cityId: p.cityId, language: p.language,
      accountType: p.accountType, termsAccepted: true, ...("orgNumber" in p ? { company: { name: `${p.lastName} Trafik`, orgNumber: p.orgNumber, address: "Gatan 1" } } : {}),
    }));
    expect(res.statusCode, res.body).toBe(200);
    ID[who] = res.json().driverId;
    if (p.accountType === "fleet") {
      FLEET[who] = res.json().fleet.fleetId;
      // v0.18.159 (fleetNeedsCar): a fleet is approved only with at least one car.
      expect((await call(app, "POST", "/driver/vehicles", H[who]!, { make: "Volvo", model: "V60", color: "Black", seats: 4, year: 2022, plate: `FNC ${p.phone}`, fuel: "hybrid" })).statusCode).toBe(201);
      const fleet = (await call(app, "GET", `/admin/fleets/${FLEET[who]}`, sup.headers)).json();
      const approved = await call(app, "POST", `/admin/fleets/${FLEET[who]}/review`, sup.headers, { expectedVersion: fleet.fleet?.version ?? fleet.version, decision: "approved" });
      expect(approved.statusCode, approved.body).toBe(200);
    }
  }
  await joinFleet("seOwner", "seDriver");
  await joinFleet("frOwner", "frDriver");
  // Not test accounts any more: no photo exemption.
  await database.db.deleteFrom("test_phones").where("app", "=", "driver").execute();
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

describe("D5.2: only real JPG / PNG / HEIC / PDF files", () => {
  for (const country of ["SE", "FR"] as const) {
    const { driver } = pair(country);
    it(`${country}: text sent as a PNG is refused (400 invalid_file_content); real files of the four kinds pass, stored as what they are`, async () => {
      const fake = await uploadRaw(driver, { type: "profile_photo" }, Buffer.from("this is not a picture at all ".repeat(10)), "image/png");
      expect(fake.statusCode).toBe(400);
      expect(fake.json()).toMatchObject({ code: "invalid_request", reason: "invalid_file_content" });
      expect((contract as unknown as { driverOnboarding: { documents: { upload: { texts: Record<string, Record<string, string>> } } } }).driverOnboarding.documents.upload.texts.invalid_file_content!.en).toBe("This file is not a photo or PDF");
      expect((await upload(driver, { type: "profile_photo" }, PNG, "image/png")).mediaType).toBe("image/png");
      expect((await upload(driver, { type: "profile_photo" }, HEIC, "image/heic")).mediaType).toBe("image/heic");
      // A real PDF sent with a photo's media type is stored as the PDF it is.
      expect((await upload(driver, { type: "profile_photo" }, PDF, "image/jpeg")).mediaType).toBe("application/pdf");
      expect((await upload(driver, { type: "profile_photo" }, JPEG, "image/jpeg")).mediaType).toBe("image/jpeg");
    });
  }
});

describe("D1: a renewal keeps the approved document valid until the new one is approved", () => {
  for (const country of ["SE", "FR"] as const) {
    const { driver } = pair(country);
    it(`${country}: the approved licence stays; the upload waits as a renewal; expiry blocks even with the renewal in review; approving it replaces the old one`, async () => {
      const first = await upload(driver, { type: "driving_license" });
      expect((await review(first.documentId, { decision: "approved", expiresAt: days(10) })).statusCode).toBe(200);
      const renewal = await upload(driver, { type: "driving_license" }, PNG, "image/png");
      expect(renewal).toMatchObject({ status: "in_review", renewalOf: first.documentId });
      expect(renewal.documentId).not.toBe(first.documentId);
      const list = (await call(app, "GET", "/driver/documents", H[driver]!)).json().items as Array<{ documentId: string; type: string; status: string; renewalOf?: string }>;
      expect(list.filter((d) => d.type === "driving_license").map((d) => [d.documentId, d.status, d.renewalOf ?? null])).toEqual(expect.arrayContaining([[first.documentId, "approved", null], [renewal.documentId, "in_review", first.documentId]]));
      // The old file is still the approved one.
      const file = await app.inject({ method: "GET", url: `/api/v1/driver/documents/${first.documentId}/file`, headers: H[driver]! });
      expect(file.headers["content-type"]).toBe("image/jpeg");
      // The approved one expires before Movera answers: blocked, though a renewal waits.
      await database.db.updateTable("documents").set({ expires_at: new Date(clock.now.getTime() - 86_400_000) }).where("document_id", "=", first.documentId).execute();
      expect(await expiredBlockers(database.db, await driverRow(driver), clock.now)).toContain("driver:driving_license");
      const line = (await reminders(driver)).find((r) => r.documentType === "driving_license");
      expect(line).toMatchObject({ kind: "document_expired", level: "blocks_online", documentId: first.documentId, renewalStatus: "in_review" });
      // A rejection needs a reason (D5.7) and leaves the old one as it was.
      expect((await review(renewal.documentId, { decision: "rejected" })).json()).toMatchObject({ code: "invalid_request", reason: "note_required" });
      expect((await review(renewal.documentId, { decision: "rejected", note: "Blurry" })).statusCode).toBe(200);
      // Checker finding 5: the Home line says why the renewal was rejected.
      expect((await reminders(driver)).find((r) => r.documentType === "driving_license")).toMatchObject({ kind: "document_expired", renewalStatus: "rejected", reviewNote: "Blurry" });
      // A new upload replaces the waiting renewal (one renewal per document).
      const again = await upload(driver, { type: "driving_license" }, PNG, "image/png");
      expect(again.renewalOf).toBe(first.documentId);
      const approved = await review(again.documentId, { decision: "approved", expiresAt: days(400) });
      expect(approved.statusCode, approved.body).toBe(200);
      expect(approved.json()).toMatchObject({ documentId: first.documentId, status: "approved", expiresAt: days(400), mediaType: "image/png" });
      expect(approved.json()).not.toHaveProperty("renewalOf");
      const after = (await call(app, "GET", "/driver/documents", H[driver]!)).json().items.filter((d: { type: string }) => d.type === "driving_license");
      expect(after).toHaveLength(1);
      expect(await expiredBlockers(database.db, await driverRow(driver), clock.now)).not.toContain("driver:driving_license");
      const newFile = await app.inject({ method: "GET", url: `/api/v1/driver/documents/${first.documentId}/file`, headers: H[driver]! });
      expect(newFile.headers["content-type"]).toBe("image/png");
    });
  }

  it("a document still in review (never approved) is simply replaced, as before", async () => {
    const one = await upload("seInvitee", { type: "profile_photo" });
    const two = await upload("seInvitee", { type: "profile_photo" });
    expect(two.documentId).toBe(one.documentId);
    expect(two).not.toHaveProperty("renewalOf");
  });
});

describe("D2: a fleet owner sees nothing of his drivers' documents", () => {
  for (const country of ["SE", "FR"] as const) {
    const { owner, driver } = pair(country);
    it(`${country}: no file of a member, no status in My fleet; his own and his cars' documents still open`, async () => {
      const mine = await upload(driver, { type: "profile_photo" });
      const res = await app.inject({ method: "GET", url: `/api/v1/driver/documents/${mine.documentId}/file`, headers: H[owner]! });
      expect(res.statusCode).toBe(404);
      const fleet = (await call(app, "GET", "/driver/fleet", H[owner]!)).json();
      for (const d of fleet.drivers) {
        expect(d).not.toHaveProperty("documents");
        expect(d).not.toHaveProperty("documentStatus");
      }
      const own = await upload(owner, { type: "profile_photo" });
      expect((await app.inject({ method: "GET", url: `/api/v1/driver/documents/${own.documentId}/file`, headers: H[owner]! })).statusCode).toBe(200);
      const car = await call(app, "POST", "/driver/vehicles", H[owner]!, { make: "Toyota", model: "Corolla", year: 2022, color: "White", plate: `${country}-D2-1`, seats: 4, fuel: "hybrid" });
      expect(car.statusCode, car.body).toBe(201);
      const carDoc = await upload(owner, { type: "vehicle_photo_front", ownerId: car.json().vehicleId });
      expect((await app.inject({ method: "GET", url: `/api/v1/driver/documents/${carDoc.documentId}/file`, headers: H[owner]! })).statusCode).toBe(200);
    });
  }
});

describe("D3: the rider sees the driver's approved photo, never another", () => {
  for (const country of ["SE", "FR"] as const) {
    const { driver } = pair(country);
    it(`${country}: no URL and 404 while the photo waits; after approval the trip's rider gets it while the driver is on the trip`, async () => {
      const rider = await signIn(app, TEST_PHONES[country === "SE" ? 0 : 3]!, "rider");
      const other = await signIn(app, TEST_PHONES[country === "SE" ? 1 : 4]!, "rider");
      const riderId = (await database.db.selectFrom("riders").select("rider_id").where("phone", "=", TEST_PHONES[country === "SE" ? 0 : 3]!).executeTakeFirstOrThrow()).rider_id;
      const photo = await upload(driver, { type: "profile_photo" });
      const tripId = await insertTrip(database.db, riderId, { status: "driver_to_pickup", driverId: ID[driver]! });
      expect(await driverPhotoUrl(database.db, ID[driver]!, tripId)).toBeUndefined();
      const get = (headers: Record<string, string>) => app.inject({ method: "GET", url: `/api/v1/rider/trips/${tripId}/driver-photo`, headers });
      expect((await get(rider.headers)).statusCode).toBe(404);
      expect((await review(photo.documentId, { decision: "approved" })).statusCode).toBe(200);
      expect(await driverPhotoUrl(database.db, ID[driver]!, tripId)).toBe(`/api/v1/rider/trips/${tripId}/driver-photo`);
      const ok = await get(rider.headers);
      expect(ok.statusCode).toBe(200);
      expect(ok.headers["content-type"]).toBe("image/jpeg");
      expect(ok.headers["cache-control"]).toBe("private, no-store");
      expect(Buffer.compare(ok.rawPayload, JPEG)).toBe(0);
      expect((await get(other.headers)).statusCode).toBe(404);
      // A new photo waiting for review never shows: the approved one stays. v0.18.166 (signupV2.profilePhoto.locked, owner
      // 2026-11-26 "Peut pas"): the driver cannot even send one now (409 profile_photo_locked); a renewal already waiting stays hidden.
      const locked = await uploadRaw(driver, { type: "profile_photo" }, PNG, "image/png");
      expect(locked.statusCode).toBe(409);
      expect(locked.json()).toMatchObject({ reason: "profile_photo_locked" });
      expect((await get(rider.headers)).headers["content-type"]).toBe("image/jpeg");
      await database.db.updateTable("trips").set({ status: "completed" }).where("trip_id", "=", tripId).execute();
      expect((await get(rider.headers)).statusCode).toBe(404);
      // A driver's token cannot use the rider endpoint.
      expect((await get(H[driver]!)).statusCode).toBe(403);
    });
  }
});

describe("D5.3: the admin gives the categories when approving a car", () => {
  for (const country of ["SE", "FR"] as const) {
    const { owner } = pair(country);
    it(`${country}: Add car ignores categories; approval needs a ride category the car fits; fitCategories lists them`, async () => {
      const added = await call(app, "POST", "/driver/vehicles", H[owner]!, { make: "Volvo", model: "V60", year: 2019, color: "Black", plate: `${country}-CAT-1`, seats: 4, fuel: "hybrid", categoryIds: ["economy", "premium"] });
      expect(added.statusCode, added.body).toBe(201);
      expect(added.json().categoryIds ?? []).toEqual([]);
      const vehicleId = added.json().vehicleId as string;
      const seen = (await call(app, "GET", `/admin/vehicles?fleetId=${FLEET[owner]}`, sup.headers)).json().items.find((v: { vehicleId: string }) => v.vehicleId === vehicleId);
      // SE: economy (2015), comfort (2019), priority, pet fit; FR: comfort needs 2020. Premium (2021/2022) and XL (6 seats) never.
      expect(seen.fitCategories).toEqual(expect.arrayContaining(["economy", "priority", "pet"]));
      expect(seen.fitCategories).not.toContain("xl");
      expect(seen.fitCategories).not.toContain("premium");
      expect(seen.fitCategories.includes("comfort")).toBe(country === "SE");
      const none = await call(app, "POST", `/admin/vehicles/${vehicleId}/review`, sup.headers, { expectedVersion: 1, decision: "approved" });
      expect(none.statusCode).toBe(400);
      expect(none.json()).toMatchObject({ reason: "categories_required" });
      const extraOnly = await call(app, "POST", `/admin/vehicles/${vehicleId}/review`, sup.headers, { expectedVersion: 1, decision: "approved", categoryIds: ["child_seat"] });
      expect(extraOnly.json()).toMatchObject({ reason: "categories_required" });
      const wrong = await call(app, "POST", `/admin/vehicles/${vehicleId}/review`, sup.headers, { expectedVersion: 1, decision: "approved", categoryIds: ["economy", "xl"] });
      expect(wrong.statusCode).toBe(409);
      expect(wrong.json()).toMatchObject({ reason: "vehicle_rules_not_met", details: ["xl:too_few_seats"] });
      // Checker finding 4: an id that is no category at all is refused, never stored as a fake category.
      const fake = await call(app, "POST", `/admin/vehicles/${vehicleId}/review`, sup.headers, { expectedVersion: 1, decision: "approved", categoryIds: ["economy", "foo"] });
      expect(fake.statusCode).toBe(409);
      expect(fake.json()).toMatchObject({ reason: "vehicle_rules_not_met", details: ["foo:unknown_category"] });
      const ok = await call(app, "POST", `/admin/vehicles/${vehicleId}/review`, sup.headers, { expectedVersion: 1, decision: "approved", categoryIds: ["economy", "child_seat"] });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json()).toMatchObject({ status: "approved", categoryIds: ["economy", "child_seat"] });
    });
  }
});

describe("D5.4: the owner's test cars TST 001–003 stay approved with corrected data", () => {
  it("migration 0038 gives them 7 seats and electric, so XL and Electric fit; they stay approved", async () => {
    const ids: string[] = [];
    for (const plate of ["TST 001", "TST 002", "TST 003"]) {
      const vehicleId = newId("veh", clock.now.getTime());
      ids.push(vehicleId);
      await database.db.insertInto("vehicles").values({ vehicle_id: vehicleId, driver_id: null, fleet_id: FLEET.seOwner!, make: "Volvo", model: "V60", year: 2021, color: "Black", plate, seats: 4, category_ids: ["economy", "comfort", "premium", "priority", "xl", "electric", "pet", "child_seat"], fuel: null, status: "approved", created_at: clock.now, updated_at: clock.now }).execute();
    }
    const other = newId("veh", clock.now.getTime());
    await database.db.insertInto("vehicles").values({ vehicle_id: other, driver_id: null, fleet_id: FLEET.seOwner!, make: "Kia", model: "Ceed", year: 2021, color: "Red", plate: "ABC 123", seats: 4, category_ids: ["xl"], fuel: null, status: "approved", created_at: clock.now, updated_at: clock.now }).execute();
    const before = (await database.db.selectFrom("vehicles").selectAll().where("vehicle_id", "=", ids[0]!).executeTakeFirstOrThrow()) as unknown as VehicleRow;
    expect(await rulesBrokenBy(database.db, before, "SE")).toEqual(expect.arrayContaining(["xl:too_few_seats", "electric:fuel_required"]));
    await sql.raw(readFileSync(new URL("../../migrations/0038_deep_fixes.sql", import.meta.url), "utf8")).execute(database.db);
    for (const id of ids) {
      const row = (await database.db.selectFrom("vehicles").selectAll().where("vehicle_id", "=", id).executeTakeFirstOrThrow()) as unknown as VehicleRow & { seats: number; fuel: string; status: string };
      expect(row).toMatchObject({ seats: 7, fuel: "electric", status: "approved" });
      expect(await rulesBrokenBy(database.db, row, "SE")).toEqual([]);
    }
    // Only the owner's test cars are touched.
    expect((await database.db.selectFrom("vehicles").select(["seats", "fuel"]).where("vehicle_id", "=", other).executeTakeFirstOrThrow())).toEqual({ seats: 4, fuel: null });
  });
});

describe("D5.5 / D5.6: invitations — the name only after he accepts; the invitation on Home", () => {
  for (const country of ["SE", "FR"] as const) {
    const { owner, invitee } = pair(country);
    it(`${country}: the owner sees only the number; the driver's Home shows "<Fleet> invited you" with Accept / Decline; a decline names the number`, async () => {
      const phone = TEST_PHONES[PEOPLE[invitee].phone]!;
      const invite = await call(app, "POST", "/driver/fleet/invite", H[owner]!, { phone });
      expect(invite.statusCode, invite.body).toBe(201);
      expect(invite.json()).toMatchObject({ phone, status: "pending" });
      expect(invite.json()).not.toHaveProperty("driverName");
      expect(invite.json()).not.toHaveProperty("driverId");
      const listed = (await call(app, "GET", "/driver/fleet/invitations", H[owner]!)).json().items.find((i: { invitationId: string }) => i.invitationId === invite.json().invitationId);
      expect(listed).not.toHaveProperty("driverName");
      const fleetView = (await call(app, "GET", "/driver/fleet", H[owner]!)).json();
      expect(fleetView.invitations.find((i: { invitationId: string }) => i.invitationId === invite.json().invitationId)).not.toHaveProperty("driverName");
      const lines = await reminders(invitee);
      const line = lines.find((r) => r.kind === "fleet_invitation");
      expect(line).toMatchObject({ kind: "fleet_invitation", level: "waiting", invitationId: invite.json().invitationId, fleetName: `${PEOPLE[owner].lastName} Trafik`,
        actions: [{ target: "accept_invitation", invitationId: invite.json().invitationId }, { target: "decline_invitation", invitationId: invite.json().invitationId }] });
      // The admin still sees who it is.
      const admin = (await call(app, "GET", `/admin/fleets/${FLEET[owner]}`, sup.headers)).json();
      expect(JSON.stringify(admin)).toContain(PEOPLE[invitee].firstName);
      const declined = await call(app, "POST", `/driver/fleet/invitations/${invite.json().invitationId}/decline`, H[invitee]!, {});
      expect(declined.statusCode).toBe(200);
      const notice = (await notices(owner)).find((n) => n.kind === "fleet_invitation" && n.data?.status === "declined");
      expect(notice?.body).toContain(phone);
      expect(notice?.body).not.toContain(PEOPLE[invitee].firstName);
      expect((await reminders(invitee)).some((r) => r.kind === "fleet_invitation")).toBe(false);
    });
  }

  it("the join line asks for the code, the owner's name and e-mail (sv / fr / en)", () => {
    const texts = (contract as unknown as { driverOnboarding: { reminders: { texts: { no_fleet: Record<string, string> } } } }).driverOnboarding.reminders.texts.no_fleet;
    expect(texts.en).toBe("Join a fleet to drive – ask your fleet owner for the Movera code, his name and e-mail");
    expect(texts.sv).toMatch(/e-post/);
    expect(texts.fr).toMatch(/e-mail/);
  });
});

describe("D4: a notice to the other side when a driver is removed or leaves", () => {
  for (const country of ["SE", "FR"] as const) {
    const { owner, driver } = pair(country);
    it(`${country}: removed → the driver is told; he joins again and leaves → the owner is told (bell, kind fleet_membership)`, async () => {
      const removed = await app.inject({ method: "POST", url: `/api/v1/driver/fleet/drivers/${ID[driver]}/remove`, headers: { ...H[owner]!, "idempotency-key": `remove-driver-key-${country}-${Date.now()}` } });
      expect(removed.statusCode, removed.body).toBe(204);
      const toDriver = (await notices(driver)).find((n) => n.kind === "fleet_membership");
      expect(toDriver).toMatchObject({ deepLink: "movera-driver://fleet", data: { fleetId: FLEET[owner], driverId: ID[driver], change: "removed" } });
      expect(toDriver!.title).toBe(country === "SE" ? "Du är inte längre med i Lind Trafik" : "Vous ne faites plus partie de Petit Trafik");
      await joinFleet(owner, driver);
      const left = await call(app, "POST", "/driver/fleet/leave", H[driver]!, {});
      expect(left.statusCode, left.body).toBe(200);
      const toOwner = (await notices(owner)).find((n) => n.kind === "fleet_membership");
      expect(toOwner).toMatchObject({ data: { fleetId: FLEET[owner], driverId: ID[driver], change: "left" } });
      expect(toOwner!.title).toBe(country === "SE" ? "Omar Said lämnade ditt åkeri" : "Sarah Benali a quitté votre flotte");
      await joinFleet(owner, driver);
    });
  }
});

describe("D5.7 / D5.8: a reason for every rejection; end dates at most 15 years ahead", () => {
  for (const country of ["SE", "FR"] as const) {
    const { owner, driver } = pair(country);
    it(`${country}: rejecting or blocking without a note is 400 note_required everywhere`, async () => {
      const doc = await upload(driver, { type: "bank_statement" });
      expect((await review(doc.documentId, { decision: "rejected", note: "   " })).json()).toMatchObject({ reason: "note_required" });
      expect((await call(app, "POST", `/admin/drivers/${ID[driver]}/bank/review`, sup.headers, { decision: "rejected" })).json()).toMatchObject({ reason: "note_required" });
      expect((await call(app, "POST", `/admin/drivers/${ID[driver]}/documents/info_session/check`, sup.headers, { decision: "rejected" })).json()).toMatchObject({ reason: "note_required" });
      const car = await call(app, "POST", "/driver/vehicles", H[owner]!, { make: "Volvo", model: "V60", year: 2021, color: "Black", plate: `${country}-RSN-1`, seats: 4, fuel: "hybrid" });
      for (const decision of ["rejected", "blocked"]) {
        const res = await call(app, "POST", `/admin/vehicles/${car.json().vehicleId}/review`, sup.headers, { expectedVersion: 1, decision });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ reason: "note_required" });
      }
      expect((await review(doc.documentId, { decision: "rejected", note: "Wrong account" })).statusCode).toBe(200);
    });

    it(`${country}: an end date more than 15 years ahead is 400 expiry_too_far (admin and upload); 15 years is fine`, async () => {
      const doc = await upload(driver, { type: "driving_license" });
      const far = new Date(clock.now.getTime());
      far.setUTCFullYear(far.getUTCFullYear() + 15);
      far.setUTCDate(far.getUTCDate() + 2);
      expect((await review(doc.documentId, { decision: "approved", expiresAt: far.toISOString() })).json()).toMatchObject({ code: "invalid_request", reason: "expiry_too_far" });
      const upl = await uploadRaw(driver, { type: "driving_license", expiresAt: "2999-01-01T00:00:00Z" });
      expect(upl.json()).toMatchObject({ reason: "expiry_too_far" });
      const fine = new Date(clock.now.getTime());
      fine.setUTCFullYear(fine.getUTCFullYear() + 15);
      fine.setUTCDate(fine.getUTCDate() - 1);
      expect((await review(doc.documentId, { decision: "approved", expiresAt: fine.toISOString() })).statusCode).toBe(200);
    });
  }
});
