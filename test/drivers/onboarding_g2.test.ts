import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { listReminders, sweepDocumentExpiry, sweepSignUpReminders } from "../../src/drivers/reminders.js";
import { loadDriver } from "../../src/drivers/service.js";
import type { OnboardingSettings } from "../../src/drivers/onboardingSettings.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { approveDriverDocuments, approveFleetDocuments, approveVehicleDocuments } from "../support/seed.js";
import { call, signIn, testWorld } from "../support/world.js";

/**
 * Contract v0.18.0 §27, owner decisions of 2026-10-29 (driver group 2 "Onboarding", items 1-11 and the note check),
 * each for Sweden and France (owner: "U need to do the work for france too"); Tunisia stays closed.
 */

let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-11-02T09:00:00Z") };
const DAY = 86_400_000;
let sup: { headers: Record<string, string> };
const H: Record<string, Record<string, string>> = {};
const ID: Record<string, string> = {};
const FLEET: Record<string, string> = {};

const PEOPLE = {
  seOwner: { phone: 0, country: "SE", cityId: "stockholm_lan", language: "sv", accountType: "fleet", firstName: "Anna", lastName: "Lind", email: "anna@example.se", orgNumber: "556600-1111" },
  seMember: { phone: 1, country: "SE", cityId: "stockholm_lan", language: "sv", accountType: "driver", firstName: "Omar", lastName: "Said", email: "omar@example.se" },
  seConvert: { phone: 2, country: "SE", cityId: "stockholm_lan", language: "sv", accountType: "driver", firstName: "Elin", lastName: "Berg", email: "elin@example.se" },
  frOwner: { phone: 3, country: "FR", cityId: "paris", language: "fr", accountType: "fleet", firstName: "Hugo", lastName: "Petit", email: "hugo@example.fr", orgNumber: "123456789" },
  frMember: { phone: 4, country: "FR", cityId: "paris", language: "fr", accountType: "driver", firstName: "Sarah", lastName: "Benali", email: "sarah@example.fr" },
  frConvert: { phone: 5, country: "FR", cityId: "paris", language: "fr", accountType: "driver", firstName: "Théo", lastName: "Garnier", email: "theo@example.fr" },
} as const;
type Who = keyof typeof PEOPLE;

const me = async (who: Who) => (await call(app, "GET", "/driver/profile", H[who]!)).json();
const reminders = async (who: Who) => (await call(app, "GET", "/driver/reminders", H[who]!)).json();
const notices = async (who: Who) => (await call(app, "GET", "/notifications?limit=50", H[who]!)).json().items as Array<{ kind: string; title: string; data?: Record<string, unknown> }>;

function multipart(fields: Record<string, string>) {
  const boundary = "----movera-g2-boundary";
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="doc.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`), Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("jpeg-bytes-".repeat(50))]), Buffer.from(`\r\n--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}
async function upload(who: Who, fields: Record<string, string>): Promise<string> {
  const body = multipart(fields);
  const res = await app.inject({ method: "POST", url: "/api/v1/driver/documents", headers: { ...H[who]!, ...body.headers, "idempotency-key": `g2-${Math.random()}` }, payload: body.payload });
  expect(res.statusCode).toBe(201);
  return res.json().documentId;
}
const review = (documentId: string, body: Record<string, unknown>) => call(app, "POST", `/admin/documents/${documentId}/review`, sup.headers, body);
const inDays = (days: number) => new Date(clock.now.getTime() + days * DAY).toISOString();
const settingsOf = async (country: string) => (await call(app, "GET", `/admin/config/onboarding?country=${country}`, sup.headers)).json();
async function publishSettings(country: string, change: (doc: OnboardingSettings) => void) {
  const draft = await settingsOf(country);
  const document = structuredClone(draft.document);
  change(document);
  const put = await call(app, "PUT", "/admin/config/onboarding", sup.headers, { expectedVersion: draft.version, country, document });
  expect(put.statusCode, put.body).toBe(200);
  const pub = await call(app, "POST", "/admin/config/onboarding/publish", sup.headers, { expectedVersion: put.json().version, country });
  expect(pub.statusCode).toBe(200);
  return pub.json();
}
async function activate(who: Who) {
  const d = (await call(app, "GET", `/admin/drivers/${ID[who]}`, sup.headers)).json();
  const res = await call(app, "POST", `/admin/drivers/${ID[who]}/status`, sup.headers, { expectedVersion: d.version, accountStatus: "active", note: "ok" });
  return res;
}
async function approveFleet(who: Who) {
  const fleet = (await call(app, "GET", `/admin/fleets/${FLEET[who]}`, sup.headers)).json().fleet;
  const res = await call(app, "POST", `/admin/fleets/${FLEET[who]}/review`, sup.headers, { expectedVersion: fleet.version, decision: "approved" });
  expect(res.statusCode).toBe(200);
  return res.json().code as string;
}
// v0.18.4 (decision 2): going online sends a fresh position, in the driver's own country.
const homeOf = (who: Who) => (PEOPLE[who].country === "FR" ? { lat: 48.8566, lng: 2.3522 } : { lat: 59.3326, lng: 18.0649 });
const goOnline = async (who: Who) => call(app, "POST", "/driver/availability", H[who]!, { expectedVersion: (await me(who)).version, onlineStatus: "online", location: { ...homeOf(who), accuracy: 5, measuredAt: clock.now.toISOString() } });
const goOffline = async (who: Who) => call(app, "POST", "/driver/availability", H[who]!, { expectedVersion: (await me(who)).version, onlineStatus: "offline" });

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  sup = await adminSession(app, database.db, "super", { now: clock.now });
  for (const [who, p] of Object.entries(PEOPLE) as Array<[Who, (typeof PEOPLE)[Who]]>) {
    H[who] = (await signIn(app, TEST_PHONES[p.phone]!, "driver")).headers;
    const res = await call(app, "POST", "/driver/onboarding", H[who]!, {
      firstName: p.firstName, lastName: p.lastName, dateOfBirth: "1988-04-01", email: p.email, country: p.country, cityId: p.cityId, language: p.language,
      accountType: p.accountType, termsAccepted: true, ...("orgNumber" in p ? { company: { name: `${p.lastName} Trafik`, orgNumber: p.orgNumber, address: "Gatan 1" } } : {}),
    });
    expect(res.statusCode).toBe(200);
    ID[who] = res.json().driverId;
    if (p.accountType === "fleet") FLEET[who] = res.json().fleet.fleetId;
  }
  // Signed in through the test numbers; from here on they are ordinary drivers (owner item 16 exempts test accounts).
  await database.db.deleteFrom("test_phones").where("app", "=", "driver").execute();
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

describe("item 10 + note check: the onboarding settings document, per country, with the admin's defaults", () => {
  it("Sweden and France start from the admin defaults (steps, reminders, expiry, car rules); Tunisia closed with no documents", async () => {
    const se = await settingsOf("SE");
    expect(se).toMatchObject({ doc: "onboarding", country: "SE", version: 1, liveVersion: 0 });
    expect(se.document).toMatchObject({
      documents: { driver: ["terms", "info_session", "driving_license", "profile_photo", "taxi_driver_license"], fleet: ["company_registration", "taxi_traffic_permit", "tax_settings", "bank_statement"], vehicle: ["vehicle_registration", "insurance"] },
      steps: [{ id: "signup", days: 3 }, { id: "documents", days: 7 }, { id: "checks", days: 3 }, { id: "training", days: 5 }, { id: "ready", days: 2 }],
      signUpReminders: { on: true, everyDays: 2, stuckAfterDays: 10 },
      expiry: { warnDays: [30, 7, 1], blockAtExpiry: true },
      vehicles: { warnDays: 30, autoHold: true, photosNeeded: true },
    });
    expect(se.document.vehicles.categories.find((r: { category: string }) => r.category === "economy")).toMatchObject({ minYear: 2015, minSeats: 4 });
    const fr = await settingsOf("FR");
    expect(fr.document.documents).toEqual({ driver: ["terms", "info_session", "vtc_card", "driving_license", "national_id", "profile_photo"], fleet: ["company_registration", "vtc_register_certificate", "rc_pro_insurance", "bank_statement"], vehicle: ["vehicle_registration", "insurance", "vtc_sticker"] }); // v0.18.164 Uber FR
    expect(fr.document.vehicles).toMatchObject({ maxAgeYears: 6, hybridElectricExempt: true });
    expect(fr.document.vehicles.categories.find((r: { category: string }) => r.category === "economy")).toMatchObject({ minYear: 2016 });
    expect(fr.document.vehicles.categories.find((r: { category: string }) => r.category === "premium")).toMatchObject({ minYear: 2022 });
    expect(fr.document.expiry).toEqual({ warnDays: [30, 7, 1], blockAtExpiry: true });
    // Owner item 14: which documents expire, per country.
    expect([...fr.document.expiringTypes].sort()).toEqual(["driving_license", "insurance", "national_id", "rc_pro_insurance", "urssaf_certificate", "vehicle_registration", "vtc_card", "vtc_register_certificate", "vtc_sticker"]);
    expect([...se.document.expiringTypes].sort()).toEqual(["driving_license", "insurance", "taxi_driver_license", "taxi_traffic_permit", "vehicle_registration"]);
    const tn = await settingsOf("TN");
    expect(tn.document.documents).toEqual({ driver: [], fleet: [], vehicle: [] });
  });

  it("is per country only, and refuses lists and numbers the admin page would refuse", async () => {
    const zone = await call(app, "GET", "/admin/config/onboarding?zoneId=Z001", sup.headers);
    expect(zone.json()).toMatchObject({ code: "invalid_request", reason: "scope_country_only" });
    const draft = await settingsOf("FR");
    for (const change of [
      (d: OnboardingSettings) => (d.documents.driver = d.documents.driver.filter((t: string) => t !== "driving_license")),
      (d: OnboardingSettings) => d.documents.driver.push("insurance"),
      (d: OnboardingSettings) => d.documents.vehicle.push("made_up_paper"),
      (d: OnboardingSettings) => (d.expiry.warnDays = [7, 30]),
      (d: OnboardingSettings) => (d.vehicles.categories[0]!.fuels = []),
    ]) {
      const document = structuredClone(draft.document);
      change(document);
      const res = await call(app, "PUT", "/admin/config/onboarding", sup.headers, { expectedVersion: draft.version, country: "FR", document });
      expect(res.json()).toMatchObject({ code: "invalid_request", reason: "invalid_document" });
    }
  });

  it("the driver app reads its country's settings (defaults, version 0)", async () => {
    expect((await call(app, "GET", "/driver/onboarding/settings", H.seMember!)).json()).toMatchObject({ version: 0, country: "SE", vehicles: { photosNeeded: true } });
    expect((await call(app, "GET", "/driver/onboarding/settings", H.frMember!)).json()).toMatchObject({ version: 0, country: "FR" });
  });
});

describe("item 11: car rules per category and country, and the four photos", () => {
  const car = (extra: Record<string, unknown>) => ({ make: "Volvo", model: "V60", color: "Black", seats: 4, ...extra });

  // v0.18.5 (G2-D5.3): the owner no longer picks categories; the rules are checked when the admin gives them on approval.
  it("Sweden: refuses a car built before 2015; the admin cannot give an XL with 4 seats, Electric to a petrol car or to a car with no fuel given", async () => {
    const old = await call(app, "POST", "/driver/vehicles", H.seOwner!, car({ year: 2014, plate: "SE 001", categoryIds: ["economy"] }));
    expect(old.json()).toMatchObject({ code: "invalid_request", reason: "category_not_allowed", details: ["car:year_too_old"] });
    const approve = async (plate: string, extra: Record<string, unknown>, categoryIds: string[]) => {
      const added = await call(app, "POST", "/driver/vehicles", H.seOwner!, car({ year: 2020, plate, ...extra }));
      expect(added.statusCode).toBe(201);
      return (await call(app, "POST", `/admin/vehicles/${added.json().vehicleId}/review`, sup.headers, { expectedVersion: 1, decision: "approved", categoryIds })).json();
    };
    expect(await approve("SE 002", {}, ["economy", "xl"])).toMatchObject({ code: "invalid_transition", reason: "vehicle_rules_not_met", details: ["xl:too_few_seats"] });
    expect(await approve("SE 003", { fuel: "petrol" }, ["electric"])).toMatchObject({ details: ["electric:fuel_not_allowed"] });
    expect(await approve("SE 004", {}, ["electric"])).toMatchObject({ details: ["electric:fuel_required"] });
  });

  it("France: base year 2016, so a 2015 car is refused there", async () => {
    const old = await call(app, "POST", "/driver/vehicles", H.frOwner!, car({ year: 2015, plate: "AA-001-FR", categoryIds: ["economy"] }));
    expect(old.json()).toMatchObject({ reason: "category_not_allowed", details: ["car:year_too_old"] });
    const ok = await call(app, "POST", "/driver/vehicles", H.frOwner!, car({ year: 2016, plate: "AA-002-FR", fuel: "hybrid", categoryIds: ["economy"] }));
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ fuel: "hybrid", requiredDocuments: ["vehicle_registration", "insurance", "vtc_sticker", "vehicle_photo_front", "vehicle_photo_back", "vehicle_photo_side", "vehicle_photo_inside"] });
    ID.frCar = ok.json().vehicleId;
  });

  it("a fitting Swedish car needs its papers and the four photos before it can be picked", async () => {
    const ok = await call(app, "POST", "/driver/vehicles", H.seOwner!, car({ year: 2017, plate: "SE 005", fuel: "electric", categoryIds: ["economy", "electric"] }));
    expect(ok.statusCode).toBe(201);
    expect(ok.json().requiredDocuments).toEqual(["vehicle_registration", "insurance", "vehicle_photo_front", "vehicle_photo_back", "vehicle_photo_side", "vehicle_photo_inside"]);
    ID.seCar = ok.json().vehicleId;
    const reviewCar = await call(app, "POST", `/admin/vehicles/${ID.seCar}/review`, sup.headers, { expectedVersion: 1, decision: "approved", categoryIds: ["economy", "electric"] });
    expect(reviewCar.statusCode).toBe(200);
    await approveVehicleDocuments(database.db, ID.seCar!, ID.seOwner!, "SE", ["vehicle_registration", "insurance"]);
    const o = await me("seOwner");
    const pick = await call(app, "PATCH", "/driver/profile", H.seOwner!, { expectedVersion: o.version, vehicleId: ID.seCar });
    expect(pick.json()).toMatchObject({ code: "documents_not_approved", reason: "vehicle_documents_not_approved", details: ["vehicle:vehicle_photo_front", "vehicle:vehicle_photo_back", "vehicle:vehicle_photo_side", "vehicle:vehicle_photo_inside"] });
    // A photo is uploaded like any car document.
    await upload("seOwner", { type: "vehicle_photo_front", ownerId: ID.seCar! });
  });
});

describe("item 9: a fleet with no approved car", () => {
  it("Sweden: the member is told the fleet has no approved car and cannot go online; the owner gets a Home reminder to fix it", async () => {
    const code = await approveFleet("seOwner");
    const join = await call(app, "POST", "/driver/fleet/join", H.seMember!, { code, ownerName: "Anna Lind", ownerEmail: "anna@example.se" });
    await call(app, "POST", `/driver/fleet/invitations/${join.json().invitationId}/accept`, H.seOwner!);
    await approveDriverDocuments(database.db, ID.seMember!);
    expect((await activate("seMember")).statusCode).toBe(200);
    const refused = await goOnline("seMember");
    expect(refused.json()).toMatchObject({ code: "invalid_transition", reason: "fleet_no_approved_car" });
    const member = await reminders("seMember");
    expect(member.items).toContainEqual({ kind: "fleet_no_approved_car", level: "blocks_online" });
    const owner = await reminders("seOwner");
    expect(owner.items).toContainEqual({ kind: "fleet_no_approved_car", level: "blocks_online", fix: { target: "fleet_vehicles" } });
    // The photos done: the car can be picked, and the member now has to pick it.
    await approveVehicleDocuments(database.db, ID.seCar!, ID.seOwner!, "SE");
    expect((await goOnline("seMember")).json()).toMatchObject({ reason: "no_vehicle" });
    expect((await reminders("seMember")).items).toContainEqual({ kind: "no_vehicle", level: "blocks_online", fix: { target: "pick_vehicle" } });
    const m = await me("seMember");
    expect((await call(app, "PATCH", "/driver/profile", H.seMember!, { expectedVersion: m.version, vehicleId: ID.seCar })).statusCode).toBe(200);
    expect((await goOnline("seMember")).json()).toMatchObject({ onlineStatus: "online" });
    expect((await goOffline("seMember")).statusCode).toBe(200);
  });

  it("France: the same, with the Paris fleet", async () => {
    const code = await approveFleet("frOwner");
    const join = await call(app, "POST", "/driver/fleet/join", H.frMember!, { code, ownerName: "Hugo Petit", ownerEmail: "hugo@example.fr" });
    await call(app, "POST", `/driver/fleet/invitations/${join.json().invitationId}/accept`, H.frOwner!);
    await approveDriverDocuments(database.db, ID.frMember!);
    expect((await activate("frMember")).statusCode).toBe(200);
    expect((await goOnline("frMember")).json()).toMatchObject({ reason: "fleet_no_approved_car" });
    expect((await reminders("frOwner")).items).toContainEqual({ kind: "fleet_no_approved_car", level: "blocks_online", fix: { target: "fleet_vehicles" } });
  });
});

describe("items 1 and 3: expiry typed by the admin, warnings at 30 / 7 / 1 days, expired on the date, no going online after", () => {
  it("Sweden: approving a licence needs a future expiry date; a profile photo needs none", async () => {
    const licence = await upload("seConvert", { type: "driving_license" });
    expect((await review(licence, { decision: "approved" })).json()).toMatchObject({ code: "invalid_request", reason: "expiry_required" });
    expect((await review(licence, { decision: "approved", expiresAt: inDays(-1) })).json()).toMatchObject({ reason: "expiry_in_past" });
    expect((await review(licence, { decision: "approved", expiresAt: inDays(40) })).json()).toMatchObject({ status: "approved", expiresAt: inDays(40) });
    const photo = await upload("seConvert", { type: "profile_photo" });
    expect((await review(photo, { decision: "approved" })).json()).toMatchObject({ status: "approved" });
    // A rejection never needs a date.
    const taxi = await upload("seConvert", { type: "taxi_driver_license" });
    expect((await review(taxi, { decision: "rejected", note: "Blurry" })).json()).toMatchObject({ status: "rejected" });
  });

  it("France: the VTC card needs the date too; the Kbis does not expire (owner item 14)", async () => {
    const kbis = await upload("frOwner", { type: "company_registration" });
    expect((await review(kbis, { decision: "approved" })).json()).toMatchObject({ status: "approved" });
    const rc = await upload("frOwner", { type: "rc_pro_insurance" });
    expect((await review(rc, { decision: "approved" })).json()).toMatchObject({ reason: "expiry_required" });
    const card = await upload("frConvert", { type: "vtc_card" });
    expect((await review(card, { decision: "approved" })).json()).toMatchObject({ reason: "expiry_required" });
    expect((await review(card, { decision: "approved", expiresAt: inDays(40) })).json()).toMatchObject({ status: "approved" });
  });

  it("Home reminders: red for what blocks going online, the info session waiting for Movera (Sweden only)", async () => {
    const se = await reminders("seConvert");
    expect(se.items[0].level).toBe("blocks_online");
    expect(se.items).toContainEqual(expect.objectContaining({ kind: "document_rejected", level: "blocks_online", documentType: "taxi_driver_license", reviewNote: "Blurry", fix: { target: "document", documentType: "taxi_driver_license", scope: "driver" } }));
    expect(se.items).toContainEqual({ kind: "info_session_waiting", level: "waiting", scope: "driver", documentType: "info_session", status: "waiting_for_movera", fix: { target: "info_session", contentSlot: "driver-info-session" } });
    expect(se.items.map((i: { level: string }) => i.level)).toEqual([...se.items.map((i: { level: string }) => i.level)].sort((a, b) => ["blocks_online", "due_soon", "waiting"].indexOf(a) - ["blocks_online", "due_soon", "waiting"].indexOf(b)));
    expect(se.blocksOnline).toBe(se.items.filter((i: { level: string }) => i.level === "blocks_online").length);
    const fr = await reminders("frConvert");
    // Owner item 13: "Yes, same as Sweden".
    expect(fr.items).toContainEqual({ kind: "info_session_waiting", level: "waiting", scope: "driver", documentType: "info_session", status: "waiting_for_movera", fix: { target: "info_session", contentSlot: "driver-info-session" } });
    expect(fr.items).toContainEqual(expect.objectContaining({ kind: "document_needed", documentType: "national_id", level: "blocks_online" }));
  });

  it("items 8 and 13: an admin marks the info session held, in Sweden and in France; the line goes", async () => {
    for (const who of ["seConvert", "frConvert"] as const) {
      const res = await call(app, "POST", `/admin/drivers/${ID[who]}/documents/info_session/check`, sup.headers, { decision: "approved", note: "Held 2 Nov" });
      expect(res.json()).toMatchObject({ type: "info_session", status: "approved" });
      expect((await reminders(who)).items.some((i: { kind: string }) => i.kind === "info_session_waiting")).toBe(false);
    }
    const notCheck = await call(app, "POST", `/admin/drivers/${ID.seConvert}/documents/driving_license/check`, sup.headers, { decision: "approved" });
    expect(notCheck.json()).toMatchObject({ reason: "not_an_admin_check" });
  });

  it("item 8: 'How to book your info session' is a driver content place the admin publishes", async () => {
    const pub = await call(app, "POST", "/admin/content/driver-info-session/publish", sup.headers, { zoneIds: ["Z001"], title: "Info session", text: { sv: "Boka här: https://movera.example/boka", fr: "Réservez ici", en: "Book here" } });
    expect(pub.statusCode).toBe(200);
    const content = (await call(app, "GET", "/driver/content?zoneId=Z001", H.seConvert!)).json();
    expect(content.items).toContainEqual(expect.objectContaining({ slot: "driver-info-session" }));
  });

  it("warnings once per warning day (sv and fr texts), then expired on the date", async () => {
    const start = clock.now;
    await sweepDocumentExpiry(database.db, new Date(start.getTime() + 5 * DAY)); // 35 days left: nothing yet
    expect((await notices("seConvert")).filter((n) => n.kind === "document_expiring" || n.kind === "document_expired")).toEqual([]);
    await sweepDocumentExpiry(database.db, new Date(start.getTime() + 11 * DAY)); // 29 days left
    await sweepDocumentExpiry(database.db, new Date(start.getTime() + 11 * DAY + 3_600_000));
    let se = (await notices("seConvert")).filter((n) => n.kind === "document_expiring" || n.kind === "document_expired");
    expect(se).toHaveLength(1);
    expect(se[0]).toMatchObject({ kind: "document_expiring", title: "Körkort går ut om 29 dagar", data: { type: "driving_license", scope: "driver", daysLeft: 29 } });
    const fr = (await notices("frConvert")).filter((n) => n.kind === "document_expiring" || n.kind === "document_expired");
    expect(fr[0]).toMatchObject({ kind: "document_expiring", title: "Carte professionnelle VTC expire dans 29 jours" });
    // The Home sheet on that day (read through the service: the test tokens would have expired by then).
    const sheet = await listReminders(database.db, await loadDriver(database.db, ID.seConvert!), new Date(start.getTime() + 11 * DAY));
    expect(sheet.items).toContainEqual(expect.objectContaining({ kind: "document_expiring", level: "due_soon", documentType: "driving_license", daysLeft: 29 }));
    await sweepDocumentExpiry(database.db, new Date(start.getTime() + 34 * DAY)); // 6 days left: the 7-day warning
    await sweepDocumentExpiry(database.db, new Date(start.getTime() + 39 * DAY + 3_600_000)); // under a day left: the 1-day warning
    se = (await notices("seConvert")).filter((n) => n.kind === "document_expiring" || n.kind === "document_expired");
    expect(se.map((n) => n.data?.["daysLeft"])).toEqual([1, 6, 29]);
    await sweepDocumentExpiry(database.db, new Date(start.getTime() + 40 * DAY));
    se = (await notices("seConvert")).filter((n) => n.kind === "document_expiring" || n.kind === "document_expired");
    expect(se[0]).toMatchObject({ kind: "document_expired", title: "Körkort har gått ut" });
    const docs = (await call(app, "GET", "/driver/documents", H.seConvert!)).json().items;
    expect(docs.find((d: { type: string }) => d.type === "driving_license")).toMatchObject({ status: "expired" });
  });

  it("Sweden and France: an active driver with an expired licence cannot go online (documents_expired), and the line is red", async () => {
    for (const who of ["seMember", "frMember"] as const) {
      const c = who === "seMember" ? "SE" : "FR";
      if (c === "FR") {
        await approveVehicleDocuments(database.db, ID.frCar!, ID.frOwner!, "FR");
        const reviewCar = await call(app, "POST", `/admin/vehicles/${ID.frCar}/review`, sup.headers, { expectedVersion: 1, decision: "approved", categoryIds: ["economy"] });
        expect(reviewCar.statusCode).toBe(200);
        const m = await me(who);
        expect((await call(app, "PATCH", "/driver/profile", H[who]!, { expectedVersion: m.version, vehicleId: ID.frCar })).statusCode).toBe(200);
      }
      // The licence expired yesterday; the hourly sweep has not run yet, the check counts it already.
      await database.db.updateTable("documents").set({ expires_at: new Date(clock.now.getTime() - DAY) }).where("owner_id", "=", ID[who]!).where("type", "=", "driving_license").execute();
      const refused = await goOnline(who);
      expect(refused.json()).toMatchObject({ code: "documents_not_approved", reason: "documents_expired", details: ["driver:driving_license"] });
      expect((await reminders(who)).items[0]).toMatchObject({ kind: "document_expired", level: "blocks_online", documentType: "driving_license", daysLeft: 0 });
    }
  });
});

describe("deep fix 2026-11-02 (g1-g3 H1): a paper that expires during the shift takes the driver offline", () => {
  it("SE: online with a valid licence; it expires → the sweep sets him offline with reason documents_expired and a notice (fail-before: stayed online)", async () => {
    const who = "seMember" as const;
    await database.db.updateTable("documents").set({ status: "approved", expires_at: new Date(clock.now.getTime() + 2 * DAY) }).where("owner_id", "=", ID[who]!).where("type", "=", "driving_license").execute();
    const online = await goOnline(who);
    expect(online.statusCode, online.body).toBe(200);
    expect(online.json().onlineStatus).toBe("online");
    await database.db.updateTable("documents").set({ expires_at: new Date(clock.now.getTime() - 1000) }).where("owner_id", "=", ID[who]!).where("type", "=", "driving_license").execute();
    await sweepDocumentExpiry(database.db, clock.now);
    expect(await me(who)).toMatchObject({ onlineStatus: "offline", offlineReason: "documents_expired" });
    const notice = (await notices(who)).find((n) => n.kind === "set_offline");
    expect(notice?.data).toMatchObject({ reason: "documents_expired" });
  });
});

describe("decision 19: car documents are the fleet owner's; a member only picks a car", () => {
  for (const [country, owner, member, plate] of [["SE", "seOwner", "seMember", "SE 019"], ["FR", "frOwner", "frMember", "AA-019-FR"]] as const) {
    it(`${country}: the member gets 403 on car documents, sees none, and lists every car with whether he can pick it`, async () => {
      const pending = await call(app, "POST", "/driver/vehicles", H[owner]!, { make: "Kia", model: "Niro", year: 2022, color: "Red", seats: 4, plate, categoryIds: ["economy"] });
      const vehicleId = pending.json().vehicleId as string;
      const ownerDoc = await upload(owner, { type: "insurance", ownerId: vehicleId });
      // Upload and read by the member: refused.
      const body = multipart({ type: "insurance", ownerId: vehicleId });
      const up = await app.inject({ method: "POST", url: "/api/v1/driver/documents", headers: { ...H[member]!, ...body.headers, "idempotency-key": `g2-${Math.random()}` }, payload: body.payload });
      expect(up.statusCode).toBe(403);
      expect(up.json()).toMatchObject({ code: "forbidden", reason: "fleet_owner_only" });
      const read = await call(app, "GET", `/driver/documents/${ownerDoc}/file`, H[member]!);
      expect(read.json()).toMatchObject({ code: "forbidden", reason: "fleet_owner_only" });
      expect((await call(app, "GET", `/driver/documents/${ownerDoc}/file`, H[owner]!)).statusCode).toBe(200);
      // His document list and Home sheet: no car documents.
      const mine = (await call(app, "GET", "/driver/documents", H[member]!)).json().items as Array<{ ownerId: string }>;
      expect(mine.every((d) => d.ownerId === ID[member])).toBe(true);
      expect((await reminders(member)).items.filter((i: { scope?: string }) => i.scope === "vehicle")).toEqual([]);
      expect((await reminders(owner)).items.some((i: { scope?: string; vehicleId?: string }) => i.scope === "vehicle" && i.vehicleId === vehicleId)).toBe(true);
      // Every car of the fleet, the pending one too, with pickable; no documents for the member.
      const cars = (await call(app, "GET", "/driver/vehicles", H[member]!)).json().items as Array<Record<string, unknown>>;
      const it = cars.find((v) => v["vehicleId"] === vehicleId)!;
      expect(it).toMatchObject({ status: "pending", pickable: false, notPickableReason: "vehicle_not_approved" });
      expect(it).not.toHaveProperty("documents");
      expect(it).not.toHaveProperty("requiredDocuments");
      const fleetCars = (await call(app, "GET", "/driver/fleet", H[member]!)).json().vehicles as Array<Record<string, unknown>>;
      expect(fleetCars.find((v) => v["vehicleId"] === vehicleId)).toMatchObject({ pickable: false });
      const ownerView = (await call(app, "GET", "/driver/vehicles", H[owner]!)).json().items.find((v: { vehicleId: string }) => v.vehicleId === vehicleId);
      expect(ownerView.documents).toEqual([expect.objectContaining({ type: "insurance" })]);
    });
  }
});

describe("item 16: every car needs its four photos approved; test accounts keep working", () => {
  const asTest = (who: Who, on: boolean) =>
    on
      ? database.db.insertInto("test_phones").values({ phone: TEST_PHONES[PEOPLE[who].phone]!, app: "driver", note: "test" }).execute()
      : database.db.deleteFrom("test_phones").where("phone", "=", TEST_PHONES[PEOPLE[who].phone]!).execute();
  for (const [country, owner, plate] of [["SE", "seOwner", "SE 077"], ["FR", "frOwner", "AA-077-FR"]] as const) {
    it(`${country}: an approved car with its papers but no photos is blocked with 'Add 4 photos of your car'; a test account may drive it`, async () => {
      const car = await call(app, "POST", "/driver/vehicles", H[owner]!, { make: "Skoda", model: "Superb", year: 2022, color: "Blue", seats: 4, plate, categoryIds: ["economy"] });
      const vehicleId = car.json().vehicleId as string;
      expect((await call(app, "POST", `/admin/vehicles/${vehicleId}/review`, sup.headers, { expectedVersion: 1, decision: "approved", categoryIds: ["economy"] })).statusCode).toBe(200);
      const papers = country === "SE" ? ["vehicle_registration", "insurance"] : ["vehicle_registration", "insurance", "vtc_sticker"];
      await approveVehicleDocuments(database.db, vehicleId, ID[owner]!, country, papers);
      const o = await me(owner);
      const refused = await call(app, "PATCH", "/driver/profile", H[owner]!, { expectedVersion: o.version, vehicleId });
      expect(refused.json()).toMatchObject({ code: "documents_not_approved", reason: "vehicle_documents_not_approved", details: ["vehicle:vehicle_photo_front", "vehicle:vehicle_photo_back", "vehicle:vehicle_photo_side", "vehicle:vehicle_photo_inside"] });
      expect((await reminders(owner)).items).toContainEqual({ kind: "vehicle_photos_needed", level: "blocks_online", scope: "vehicle", vehicleId, documentType: "vehicle_photo_front", fix: { target: "document", documentType: "vehicle_photo_front", scope: "vehicle", vehicleId } });
      await asTest(owner, true);
      try {
        expect((await call(app, "PATCH", "/driver/profile", H[owner]!, { expectedVersion: o.version, vehicleId })).json()).toMatchObject({ vehicleId });
        expect((await reminders(owner)).items.some((i: { kind: string }) => i.kind === "vehicle_photos_needed")).toBe(false);
      } finally {
        await asTest(owner, false);
      }
    });
  }
});

describe("item 7: Start my own company", () => {
  it("Sweden: the driver becomes a fleet on hold with a pending company, keeps his documents, and only the company's are new", async () => {
    await approveDriverDocuments(database.db, ID.seConvert!);
    // The licence renewed (the earlier test let it expire).
    await database.db.updateTable("documents").set({ expires_at: new Date(clock.now.getTime() + 300 * DAY) }).where("owner_id", "=", ID.seConvert!).where("type", "=", "driving_license").execute();
    const before = await me("seConvert");
    const res = await call(app, "POST", "/driver/fleet/start-company", H.seConvert!, { expectedVersion: before.version, company: { name: "Berg Taxi AB", orgNumber: "556611-2222", address: "Vägen 2" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accountType: "fleet", accountStatus: "on_hold", payoutTo: "self", fleet: { name: "Berg Taxi AB", role: "owner", status: "pending" }, requiredFleetDocuments: ["company_registration", "taxi_traffic_permit", "tax_settings", "bank_statement"] });
    expect(res.json().documents.filter((d: { status: string }) => d.status === "approved").map((d: { type: string }) => d.type).sort()).toEqual(["driving_license", "info_session", "profile_photo", "taxi_driver_license", "terms"]);
    const lines = (await reminders("seConvert")).items.filter((i: { kind: string }) => i.kind === "document_needed");
    expect(lines.map((i: { scope: string; documentType: string }) => `${i.scope}:${i.documentType}`)).toEqual(["fleet:bank_statement", "fleet:company_registration", "fleet:tax_settings", "fleet:taxi_traffic_permit"]);
    // Like a new fleet: the admin approves the company and activates on its documents.
    const fleetId = res.json().fleet.fleetId;
    expect((await call(app, "GET", "/admin/fleets?status=pending", sup.headers)).json().items).toContainEqual(expect.objectContaining({ fleetId, name: "Berg Taxi AB" }));
    const refused = await activate("seConvert");
    expect(refused.json()).toMatchObject({ code: "documents_not_approved", details: ["fleet:company_registration", "fleet:taxi_traffic_permit", "fleet:tax_settings", "fleet:bank_statement"] });
    const again = await call(app, "POST", "/driver/fleet/start-company", H.seConvert!, { expectedVersion: res.json().version, company: { name: "X AB", orgNumber: "556611-3333", address: "Y" } });
    expect(again.json()).toMatchObject({ code: "invalid_transition", reason: "already_fleet" });
  });

  it("France: the ID already approved as a driver document counts for the company too", async () => {
    await approveDriverDocuments(database.db, ID.frConvert!);
    const before = await me("frConvert");
    const res = await call(app, "POST", "/driver/fleet/start-company", H.frConvert!, { expectedVersion: before.version, company: { name: "Garnier VTC", orgNumber: "987654321", address: "Rue 3" } });
    expect(res.json()).toMatchObject({ accountType: "fleet", accountStatus: "on_hold", fleet: { status: "pending" } });
    const lines = (await reminders("frConvert")).items.filter((i: { kind: string }) => i.kind === "document_needed").map((i: { documentType: string }) => i.documentType);
    expect(lines).not.toContain("national_id");
    // v0.18.164 (Uber FR): no URSSAF and no second ID in the FR fleet list.
    expect(lines.sort()).toEqual(["bank_statement", "company_registration", "rc_pro_insurance", "vtc_register_certificate"]);
  });

  it("a member leaves his fleet when he starts his own", async () => {
    const before = await me("frMember");
    expect(before.fleet.role).toBe("member");
    const res = await call(app, "POST", "/driver/fleet/start-company", H.frMember!, { expectedVersion: before.version, company: { name: "Benali VTC", orgNumber: "111222333", address: "Rue 4" } });
    expect(res.json()).toMatchObject({ accountType: "fleet", accountStatus: "on_hold", fleet: { role: "owner", status: "pending" } });
    expect(res.json()).not.toHaveProperty("vehicleId");
  });
});

describe("note check: 'Finish your sign-up' reminders and stuck applicants", () => {
  it("every 2 days while the account waits on itself, in its language; stuck after 10 days in the admin view", async () => {
    // seOwner and frOwner are on hold with company papers missing.
    for (const who of ["seOwner", "frOwner"] as const) await database.db.updateTable("drivers").set({ created_at: new Date(clock.now.getTime() - 3 * DAY) }).where("driver_id", "=", ID[who]!).execute();
    await sweepSignUpReminders(database.db, clock.now);
    await sweepSignUpReminders(database.db, new Date(clock.now.getTime() + DAY));
    expect((await notices("seOwner")).filter((n) => n.kind === "finish_sign_up").map((n) => n.title)).toEqual(["Slutför din registrering"]);
    expect((await notices("frOwner")).filter((n) => n.kind === "finish_sign_up").map((n) => n.title)).toEqual(["Terminez votre inscription"]);
    await sweepSignUpReminders(database.db, new Date(clock.now.getTime() + 2 * DAY));
    expect((await notices("seOwner")).filter((n) => n.kind === "finish_sign_up")).toHaveLength(2);
    expect((await call(app, "GET", `/admin/drivers/${ID.seOwner}`, sup.headers)).json().signUp).toMatchObject({ stuck: false, remindersSent: 2 });
    // One clock everywhere (2026-11-09): the server now judges "stuck" by the command's clock, as the sweeps do.
    await database.db.updateTable("drivers").set({ created_at: new Date(clock.now.getTime() - 11 * DAY) }).where("driver_id", "=", ID.seOwner!).execute();
    expect((await call(app, "GET", `/admin/drivers/${ID.seOwner}`, sup.headers)).json().signUp).toMatchObject({ stuck: true });
    // An active driver gets none.
    expect((await call(app, "GET", `/admin/drivers/${ID.seMember}`, sup.headers)).json()).not.toHaveProperty("signUp");
  });

  it("reminders off in the published settings: none", async () => {
    await publishSettings("FR", (d) => (d.signUpReminders.on = false));
    await sweepSignUpReminders(database.db, new Date(clock.now.getTime() + 6 * DAY));
    // The two sent before the admin turned them off; none after.
    expect((await notices("frOwner")).filter((n) => n.kind === "finish_sign_up")).toHaveLength(2);
  });
});

describe("items 10, 11 and the note check: what the admin publishes is what the server follows", () => {
  it("Sweden: a document added to the driver list is required at once; block at expiry off lets the driver go online", async () => {
    const pub = await publishSettings("SE", (d) => {
      d.documents.driver.push("national_id");
      d.expiry.blockAtExpiry = false;
    });
    expect(pub).toMatchObject({ doc: "onboarding", country: "SE", version: 1 });
    expect((await me("seMember")).requiredDocuments).toEqual(["terms", "info_session", "driving_license", "profile_photo", "taxi_driver_license", "national_id"]);
    expect((await call(app, "GET", "/driver/onboarding/settings", H.seMember!)).json()).toMatchObject({ version: 1, expiry: { blockAtExpiry: false } });
    expect((await goOnline("seMember")).json()).toMatchObject({ onlineStatus: "online" });
    expect((await reminders("seMember")).items).toContainEqual(expect.objectContaining({ kind: "document_expired", level: "due_soon" }));
    await goOffline("seMember");
    // Checker: activation follows the same switch (an expired licence does not hold the account back).
    await approveFleetDocuments(database.db, ID.seConvert!);
    await database.db.updateTable("documents").set({ status: "expired", expires_at: new Date(clock.now.getTime() - DAY) }).where("owner_id", "=", ID.seConvert!).where("type", "=", "driving_license").execute();
    await approveDriverDocuments(database.db, ID.seConvert!, ["national_id"]);
    expect((await activate("seConvert")).json()).toMatchObject({ accountStatus: "active" });
  });

  it("France: photos off and a stricter economy year are followed at once", async () => {
    await publishSettings("FR", (d) => {
      d.vehicles.photosNeeded = false;
      d.vehicles.categories.find((r) => r.category === "economy")!.minYear = 2019;
    });
    const fleetCar = (await call(app, "GET", "/driver/vehicles", H.frOwner!)).json().items.find((v: { vehicleId: string }) => v.vehicleId === ID.frCar);
    expect(fleetCar.requiredDocuments).toEqual(["vehicle_registration", "insurance", "vtc_sticker"]);
    // v0.18.5 (G2-D5.3): checked when the admin gives the category.
    const old = await call(app, "POST", "/driver/vehicles", H.frOwner!, { make: "Renault", model: "Talisman", year: 2018, color: "Grey", plate: "AA-003-FR", seats: 4, fuel: "hybrid", categoryIds: ["economy"] }); // v0.18.164: hybrid, so only the stricter minYear applies (not the 6-year age)
    expect(old.statusCode).toBe(201);
    const give = await call(app, "POST", `/admin/vehicles/${old.json().vehicleId}/review`, sup.headers, { expectedVersion: 1, decision: "approved", categoryIds: ["economy"] });
    expect(give.json()).toMatchObject({ reason: "vehicle_rules_not_met", details: ["economy:year_too_old"] });
  });
});

describe("item 14: document types the admin makes, renames, expires and removes, per country", () => {
  const text = (s: string) => ({ sv: `${s} sv`, fr: `${s} fr`, en: s });
  for (const [country, who, cityType] of [["SE", "seMember", "taxi_driver_license"], ["FR", "frMember", "vtc_card"]] as const) {
    it(`${country}: a new file type and a new admin_check type get server ids, are required at once, and the app gets their texts`, async () => {
      const pub = await publishSettings(country, (d) => {
        d.customTypes = [
          { draftKey: "a", owner: "driver", kind: "file", expires: true, name: text("Medical certificate"), help: text("Signed by a doctor") },
          { draftKey: "b", owner: "driver", kind: "admin_check", expires: false, name: text("Road test"), help: text("Booked by Movera") },
        ];
        d.documents.driver.push("draft:a", "draft:b");
        d.texts = { [cityType]: { name: text("Renamed licence"), help: text("Both sides") } };
      });
      expect(pub.doc).toBe("onboarding");
      const live = (await settingsOf(country)).document as OnboardingSettings;
      const [a, b] = live.customTypes!.map((c) => c.id!);
      expect(a).toMatch(/^custom_[a-z0-9]{10}$/);
      expect(live.customTypes![0]).not.toHaveProperty("draftKey");
      expect(live.documents.driver.slice(-2)).toEqual([a, b]);
      expect(live.expiringTypes).toContain(a);
      expect(live.expiringTypes).not.toContain(b);
      expect((await me(who)).requiredDocuments).toEqual(expect.arrayContaining([a, b]));
      const forApp = (await call(app, "GET", "/driver/onboarding/settings", H[who]!)).json();
      expect(forApp.documentTypes[a!]).toEqual({ owner: "driver", kind: "file", expires: true, custom: true, name: text("Medical certificate"), help: text("Signed by a doctor") });
      expect(forApp.documentTypes[cityType]).toMatchObject({ custom: false, name: text("Renamed licence"), help: text("Both sides") });
      // The driver uploads the new type; the admin approves it with a date (it expires).
      const doc = await upload(who, { type: a! });
      expect((await review(doc, { decision: "approved" })).json()).toMatchObject({ reason: "expiry_required" });
      expect((await reminders(who)).items).toContainEqual(expect.objectContaining({ kind: "admin_check_waiting", documentType: b, status: "waiting_for_movera" }));
      // Removed from the list: no longer required.
      await publishSettings(country, (d) => {
        d.documents.driver = d.documents.driver.filter((t) => t !== b);
        d.customTypes = d.customTypes!.filter((c) => c.id !== b);
      });
      expect((await me(who)).requiredDocuments).not.toContain(b);
    });
  }

  it("refuses an id the country never made, texts for an unknown type, a custom type in the wrong list", async () => {
    const draft = await settingsOf("FR");
    for (const change of [
      (d: OnboardingSettings) => d.customTypes!.push({ id: "custom_aaaaaaaaaa", owner: "driver", kind: "file", expires: false, name: text("X"), help: text("X") }),
      (d: OnboardingSettings) => (d.texts = { no_such_type: { name: text("X") } }),
      (d: OnboardingSettings) => d.documents.vehicle.push(d.customTypes![0]!.id!),
    ]) {
      const document = structuredClone(draft.document);
      change(document);
      const res = await call(app, "PUT", "/admin/config/onboarding", sup.headers, { expectedVersion: draft.version, country: "FR", document });
      expect(res.json()).toMatchObject({ code: "invalid_request", reason: "invalid_document" });
    }
  });
});
