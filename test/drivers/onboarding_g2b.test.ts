import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { categoryProblem, defaultSettings, type OnboardingSettings } from "../../src/drivers/onboardingSettings.js";
import { newId } from "../../src/ids.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { call, signIn, testWorld } from "../support/world.js";

/**
 * Contract v0.18.3 §28, owner decisions R2, R4, R5, R6, R8, R9 and R10 of 2026-10-30 (driver group 2 re-check after the
 * full live test), each for Sweden and France (owner: "U need to do the work for france too").
 */

let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-11-02T09:00:00Z") };
let sup: { headers: Record<string, string> };
const H: Record<string, Record<string, string>> = {};
const ID: Record<string, string> = {};
const FLEET: Record<string, string> = {};

const PEOPLE = {
  seOwner: { phone: 0, country: "SE", cityId: "stockholm_lan", language: "sv", accountType: "fleet", firstName: "Anna", lastName: "Lind", email: "anna@example.se", orgNumber: "556600-1111" },
  seDriver: { phone: 1, country: "SE", cityId: "stockholm_lan", language: "fr", accountType: "driver", firstName: "Omar", lastName: "Said", email: "omar@example.se" },
  frOwner: { phone: 3, country: "FR", cityId: "paris", language: "fr", accountType: "fleet", firstName: "Hugo", lastName: "Petit", email: "hugo@example.fr", orgNumber: "123456789" },
  frDriver: { phone: 4, country: "FR", cityId: "paris", language: "fr", accountType: "driver", firstName: "Sarah", lastName: "Benali", email: "sarah@example.fr" },
} as const;
type Who = keyof typeof PEOPLE;

const reminders = async (who: Who) => (await call(app, "GET", "/driver/reminders", H[who]!)).json();
const notices = async (who: Who) => (await call(app, "GET", "/notifications?limit=50", H[who]!)).json().items as Array<{ kind: string; title: string; body: string; deepLink?: string; data?: Record<string, unknown> }>;
/** The newest notice of a kind (notices written in the same test-clock instant have no order between them). */
const noticeOf = async (who: Who, kind: string) => (await notices(who)).find((n) => n.kind === kind);
const settingsOf = async (country: string) => (await call(app, "GET", `/admin/config/onboarding?country=${country}`, sup.headers)).json();
const driverSettings = async (who: Who) => (await call(app, "GET", "/driver/onboarding/settings", H[who]!)).json();
const review = (documentId: string, body: Record<string, unknown>) => call(app, "POST", `/admin/documents/${documentId}/review`, sup.headers, body);
const car = (extra: Record<string, unknown>) => ({ make: "Toyota", model: "Prius", color: "White", seats: 4, fuel: "hybrid", ...extra });

function multipart(fields: Record<string, string>) {
  const boundary = "----movera-g2b-boundary";
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="doc.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`), Buffer.from("jpeg-bytes-".repeat(50)), Buffer.from(`\r\n--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}
async function upload(who: Who, fields: Record<string, string>): Promise<string> {
  const body = multipart(fields);
  const res = await app.inject({ method: "POST", url: "/api/v1/driver/documents", headers: { ...H[who]!, ...body.headers, "idempotency-key": `g2b-${Math.random()}` }, payload: body.payload });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().documentId;
}
async function publishSettings(country: string, change: (doc: OnboardingSettings & Record<string, unknown>) => void) {
  const draft = await settingsOf(country);
  const document = structuredClone(draft.document);
  change(document);
  const put = await call(app, "PUT", "/admin/config/onboarding", sup.headers, { expectedVersion: draft.version, country, document });
  if (put.statusCode !== 200) return put;
  return call(app, "POST", "/admin/config/onboarding/publish", sup.headers, { expectedVersion: put.json().version, country });
}
/** A car straight in the database, approved or not, as the live test car TST G2A was. */
async function insertCar(fleetOf: Who, year: number, categoryIds: string[], status: "pending" | "approved", plate: string) {
  const vehicleId = newId("veh", clock.now.getTime());
  await database.db.insertInto("vehicles").values({ vehicle_id: vehicleId, driver_id: null, fleet_id: FLEET[fleetOf]!, make: "Toyota", model: "Prius", year, color: "White", plate, seats: 4, category_ids: categoryIds, fuel: "hybrid", status, created_at: clock.now, updated_at: clock.now }).execute();
  return vehicleId;
}

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
  await database.db.deleteFrom("test_phones").where("app", "=", "driver").execute();
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

describe("R2: the base year for every car, an extra only with a ride category, no approval of a rule-breaking car", () => {
  it("a category without a rule (child_seat) is still checked against the base year", () => {
    expect(categoryProblem({ year: 2012, seats: 4, fuel: "hybrid" }, defaultSettings("SE"), "child_seat")).toBe("year_too_old");
    expect(categoryProblem({ year: 2015, seats: 4, fuel: "hybrid" }, defaultSettings("FR"), "child_seat")).toBe("year_too_old");
    expect(categoryProblem({ year: 2016, seats: 4, fuel: "hybrid" }, defaultSettings("FR"), "child_seat")).toBeNull();
  });

  it("Sweden: a 2012 car with only Booster Seat is refused (year and extra alone); 2015 economy + child seat is fine", async () => {
    const old = await call(app, "POST", "/driver/vehicles", H.seOwner!, car({ year: 2012, plate: "TST G2A", categoryIds: ["child_seat"] }));
    expect(old.statusCode).toBe(400);
    expect(old.json()).toMatchObject({ reason: "category_not_allowed" });
    expect(old.json().details).toEqual(expect.arrayContaining(["child_seat:year_too_old", "child_seat:extra_needs_ride"]));
    const alone = await call(app, "POST", "/driver/vehicles", H.seOwner!, car({ year: 2020, plate: "SE 100", categoryIds: ["child_seat"] }));
    expect(alone.json()).toMatchObject({ reason: "category_not_allowed", details: ["child_seat:extra_needs_ride"] });
    const none = await call(app, "POST", "/driver/vehicles", H.seOwner!, car({ year: 2012, plate: "SE 101", categoryIds: [] }));
    expect(none.json()).toMatchObject({ reason: "category_not_allowed", details: ["car:year_too_old"] });
    const ok = await call(app, "POST", "/driver/vehicles", H.seOwner!, car({ year: 2015, plate: "SE 102", categoryIds: ["economy", "child_seat"] }));
    expect(ok.statusCode).toBe(201);
  });

  it("France: base year 2016 for a child-seat car too", async () => {
    const old = await call(app, "POST", "/driver/vehicles", H.frOwner!, car({ year: 2015, plate: "AB-100-FR", categoryIds: ["economy", "child_seat"] }));
    expect(old.json().details).toEqual(expect.arrayContaining(["economy:year_too_old", "child_seat:year_too_old"]));
    const ok = await call(app, "POST", "/driver/vehicles", H.frOwner!, car({ year: 2016, plate: "AB-101-FR", categoryIds: ["economy", "child_seat"] }));
    expect(ok.statusCode).toBe(201);
  });

  for (const [country, owner, year, plate] of [["SE", "seOwner", 2012, "TST G2B"], ["FR", "frOwner", 2015, "AB-102-FR"]] as const) {
    it(`${country}: the admin cannot approve a car that breaks the rules (409 vehicle_rules_not_met) and sees why`, async () => {
      const vehicleId = await insertCar(owner, year, ["child_seat"], "pending", plate);
      const list = (await call(app, "GET", `/admin/vehicles?fleetId=${FLEET[owner]}`, sup.headers)).json();
      expect(list.items.find((v: { vehicleId: string }) => v.vehicleId === vehicleId).ruleProblems).toEqual(expect.arrayContaining(["child_seat:year_too_old", "child_seat:extra_needs_ride"]));
      const approve = await call(app, "POST", `/admin/vehicles/${vehicleId}/review`, sup.headers, { expectedVersion: 1, decision: "approved" });
      expect(approve.statusCode).toBe(409);
      expect(approve.json()).toMatchObject({ code: "invalid_transition", reason: "vehicle_rules_not_met" });
      expect(approve.json().details).toContain("child_seat:year_too_old");
      const reject = await call(app, "POST", `/admin/vehicles/${vehicleId}/review`, sup.headers, { expectedVersion: 1, decision: "rejected", note: "Too old" });
      expect(reject.statusCode).toBe(200);
    });
  }

  it("migration 0035: an approved car below the base year goes back to pending (SE 2012 and FR 2015); a fitting one stays approved", async () => {
    const seOld = await insertCar("seOwner", 2012, ["child_seat"], "approved", "TST G2C");
    const frOld = await insertCar("frOwner", 2015, ["economy"], "approved", "AB-103-FR");
    const seNew = await insertCar("seOwner", 2018, ["economy"], "approved", "SE 103");
    const file = readFileSync(new URL("../../migrations/0035_car_base_year.sql", import.meta.url), "utf8");
    await sql.raw(file).execute(database.db);
    const status = async (id: string) => (await database.db.selectFrom("vehicles").select("status").where("vehicle_id", "=", id).executeTakeFirstOrThrow()).status;
    expect(await status(seOld)).toBe("pending");
    expect(await status(frOld)).toBe("pending");
    expect(await status(seNew)).toBe("approved");
  });
});

describe("R4: a driver with no fleet gets the red 'Join a fleet' line", () => {
  for (const who of ["seDriver", "frDriver"] as const) {
    it(`${who}: no_fleet, blocks going online, with Join a fleet and Start my own company`, async () => {
      const list = await reminders(who);
      expect(list.items).toContainEqual({ kind: "no_fleet", level: "blocks_online", fix: { target: "join_fleet" }, actions: [{ target: "join_fleet" }, { target: "start_company" }] });
    });
  }
  it("a fleet owner never gets it", async () => {
    expect((await reminders("seOwner")).items.map((i: { kind: string }) => i.kind)).not.toContain("no_fleet");
    expect((await reminders("frOwner")).items.map((i: { kind: string }) => i.kind)).not.toContain("no_fleet");
  });
});

describe("R5: document names follow the country", () => {
  it("Sweden's bank statement is 'Relevé bancaire de l’entreprise' in French, France's is the RIB; Sweden's company registration is not a Kbis", async () => {
    const se = await driverSettings("seOwner");
    expect(se.documentTypes.bank_statement.name).toEqual({ en: "Company bank account statement", sv: "Kontobevis", fr: "Relevé bancaire de l’entreprise" });
    expect(se.documentTypes.company_registration.name.fr).not.toMatch(/Kbis/);
    const fr = await driverSettings("frOwner");
    expect(fr.documentTypes.bank_statement.name.fr).toBe("RIB de la société");
    expect(fr.documentTypes.company_registration.name.fr).toMatch(/Kbis/);
  });
  it("the admin's own name for the country still wins", async () => {
    const res = await publishSettings("SE", (d) => (d.texts = { bank_statement: { name: { sv: "Bankintyg", fr: "Attestation bancaire", en: "Bank letter" } } }));
    expect(res.statusCode, res.body).toBe(200);
    expect((await driverSettings("seOwner")).documentTypes.bank_statement.name.fr).toBe("Attestation bancaire");
    expect((await publishSettings("SE", (d) => (d.texts = {}))).statusCode).toBe(200);
  });
});

describe("R6: a bell notice for every approval and rejection, with the reason, in the driver's language", () => {
  it("Sweden (sv): a rejected licence tells why; an approved one says so", async () => {
    const doc = await upload("seOwner", { type: "profile_photo" });
    expect((await review(doc, { decision: "rejected", note: "Suddig bild" })).statusCode).toBe(200);
    expect(await noticeOf("seOwner", "document_rejected")).toMatchObject({ kind: "document_rejected", title: "Profilbild godkändes inte", body: "Anledning: Suddig bild. Ladda upp ett nytt.", deepLink: "movera-driver://documents/profile_photo", data: { documentId: doc, type: "profile_photo", scope: "driver", decision: "rejected", note: "Suddig bild" } });
    await upload("seOwner", { type: "profile_photo" });
    expect((await review(doc, { decision: "approved" })).statusCode).toBe(200);
    expect(await noticeOf("seOwner", "document_approved")).toMatchObject({ kind: "document_approved", title: "Profilbild är godkänt" });
  });
  it("France (fr): the RIB rejected, then a car approved and a car rejected go to the fleet owner", async () => {
    const doc = await upload("frOwner", { type: "bank_statement" });
    expect((await review(doc, { decision: "rejected", note: "IBAN illisible" })).statusCode).toBe(200);
    expect(await noticeOf("frOwner", "document_rejected")).toMatchObject({ kind: "document_rejected", title: "RIB de la société : refusé", body: "Motif : IBAN illisible. Envoyez-en un nouveau." });
    const added = await call(app, "POST", "/driver/vehicles", H.frOwner!, car({ year: 2020, plate: "AB-200-FR", categoryIds: ["economy"] }));
    expect((await call(app, "POST", `/admin/vehicles/${added.json().vehicleId}/review`, sup.headers, { expectedVersion: 1, decision: "approved" })).statusCode).toBe(200);
    expect(await noticeOf("frOwner", "vehicle_approved")).toMatchObject({ kind: "vehicle_approved", title: "Le véhicule AB-200-FR est approuvé", data: { vehicleId: added.json().vehicleId, decision: "approved" } });
    expect((await call(app, "POST", `/admin/vehicles/${added.json().vehicleId}/review`, sup.headers, { expectedVersion: 2, decision: "rejected", note: "Carte grise manquante" })).statusCode).toBe(200);
    const rejected = (await notices("frOwner")).find((n) => n.kind === "vehicle_rejected" && n.data?.vehicleId === added.json().vehicleId);
    expect(rejected).toMatchObject({ body: "Motif : Carte grise manquante.", data: { decision: "rejected", note: "Carte grise manquante" } });
  });
  it("the info session marked held (admin check) is a notice too (Sweden, in French for this driver)", async () => {
    expect((await call(app, "POST", `/admin/drivers/${ID.seDriver}/documents/info_session/check`, sup.headers, { decision: "approved" })).statusCode).toBe(200);
    expect(await noticeOf("seDriver", "document_approved")).toMatchObject({ kind: "document_approved", title: "Session d’information en ligne : approuvé" });
  });
});

describe("R8: the upload guide text the admin writes per country and document", () => {
  const line = (sv: string, fr: string, en: string) => ({ sv, fr, en });
  it("Sweden and France: the guide is served with the type; an unknown type is refused", async () => {
    const se = await publishSettings("SE", (d) => (d.guides = { taxi_driver_license: { checklist: [line("Båda sidor", "Les deux faces", "Both sides")], tips: [line("Inget blixtljus", "Pas de flash", "No flash")] } }));
    expect(se.statusCode, se.body).toBe(200);
    expect((await driverSettings("seDriver")).documentTypes.taxi_driver_license.guide).toEqual({ checklist: [line("Båda sidor", "Les deux faces", "Both sides")], tips: [line("Inget blixtljus", "Pas de flash", "No flash")] });
    const fr = await publishSettings("FR", (d) => (d.guides = { vtc_card: { checklist: [line("Kortet i sin helhet", "La carte entière", "The whole card")], tips: [] } }));
    expect(fr.statusCode, fr.body).toBe(200);
    expect((await driverSettings("frDriver")).documentTypes.vtc_card.guide.checklist[0].fr).toBe("La carte entière");
    const bad = await publishSettings("FR", (d) => (d.guides = { taxi_traffic_permit: { checklist: [], tips: [] }, made_up: { checklist: [], tips: [] } }));
    expect(bad.json()).toMatchObject({ code: "invalid_request", reason: "invalid_document" });
  });
});

describe("R9: valid N months from the issue date", () => {
  it("France: URSSAF valid 6 months by default; issuedAt fills the expiry; the admin's own date wins", async () => {
    expect((await settingsOf("FR")).document.validMonths).toEqual({ urssaf_certificate: 6 });
    const doc = await upload("frOwner", { type: "urssaf_certificate" });
    const res = await review(doc, { decision: "approved", issuedAt: "2026-10-15T00:00:00.000Z" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().expiresAt).toBe("2027-04-15T00:00:00.000Z");
    await upload("frOwner", { type: "urssaf_certificate" });
    const typed = await review(doc, { decision: "approved", issuedAt: "2026-10-15T00:00:00.000Z", expiresAt: "2027-01-31T00:00:00.000Z" });
    expect(typed.json().expiresAt).toBe("2027-01-31T00:00:00.000Z");
    await upload("frOwner", { type: "urssaf_certificate" });
    expect((await review(doc, { decision: "approved", issuedAt: "2026-12-01T00:00:00.000Z" })).json()).toMatchObject({ reason: "issued_in_future" });
    expect((await review(doc, { decision: "approved", issuedAt: "2026-01-01T00:00:00.000Z" })).json()).toMatchObject({ reason: "expiry_in_past" });
  });
  it("Sweden: the admin sets 'valid 12 months' for the taxi licence and approval follows it", async () => {
    expect((await settingsOf("SE")).document.validMonths).toEqual({});
    expect((await publishSettings("SE", (d) => (d.validMonths = { taxi_driver_license: 12 }))).statusCode).toBe(200);
    expect((await driverSettings("seDriver")).documentTypes.taxi_driver_license.validMonths).toBe(12);
    const doc = await upload("seDriver", { type: "taxi_driver_license" });
    const res = await review(doc, { decision: "approved", issuedAt: "2026-09-30T00:00:00.000Z" });
    expect(res.json()).toMatchObject({ status: "approved", expiresAt: "2027-09-30T00:00:00.000Z" });
    expect((await publishSettings("SE", (d) => (d.validMonths = { taxi_driver_license: 0 }))).json()).toMatchObject({ reason: "invalid_document" });
  });
});

describe("R10: 'account not active' only when every document is done", () => {
  it("France: with documents still in review the line is not shown", async () => {
    for (const type of ["vtc_card", "driving_license", "national_id", "profile_photo"]) await upload("frDriver", { type });
    const list = await reminders("frDriver");
    expect(list.items.some((i: { kind: string }) => i.kind === "document_in_review")).toBe(true);
    expect(list.items.map((i: { kind: string }) => i.kind)).not.toContain("account_not_active");
  });
  it("Sweden: once every document is approved and the info session held, the line is shown", async () => {
    for (const type of ["driving_license", "profile_photo"]) {
      const id = await upload("seDriver", { type });
      expect((await review(id, { decision: "approved", ...(type === "driving_license" ? { expiresAt: "2030-01-01T00:00:00.000Z" } : {}) })).statusCode).toBe(200);
    }
    const list = await reminders("seDriver");
    expect(list.items.map((i: { kind: string }) => i.kind)).toContain("account_not_active");
  });
});
