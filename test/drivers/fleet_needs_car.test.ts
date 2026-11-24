import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { call, signIn, testWorld } from "../support/world.js";

/**
 * Contract v0.18.159 (contract.json#fleetNeedsCar; owner 2026-11-24, Rules decisions/driver-g2.md "Fleet owner must add a
 * car": "Why fleet owner after sign in don't know that he need to add car ?" and "No but in sheet must see that it's
 * missing to add car"; mockup PROPOSAL-fleet-add-car-2026-11-24.html approved): the fleet owner's red Home line
 * fleet_no_car from the first sign-in, whatever the fleet's status, and no fleet approval with zero cars while the
 * country's OnboardingSettings.fleetNeedsCarForApproval is on (default). Sweden and France.
 */

let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-11-24T10:00:00Z") };
let sup: { headers: Record<string, string> };
const H: Record<string, Record<string, string>> = {};
const ID: Record<string, string> = {};
const FLEET: Record<string, string> = {};
const NEW = "0.18.159";
const OLD = "0.18.154";

const PEOPLE = {
  seOwner: { phone: 0, country: "SE", cityId: "stockholm_lan", language: "sv", accountType: "fleet", firstName: "Anna", lastName: "Lind", email: "anna@example.se", orgNumber: "556600-1111" },
  frOwner: { phone: 1, country: "FR", cityId: "paris", language: "fr", accountType: "fleet", firstName: "Hugo", lastName: "Petit", email: "hugo@example.fr", orgNumber: "123456789" },
  seOwner2: { phone: 2, country: "SE", cityId: "stockholm_lan", language: "sv", accountType: "fleet", firstName: "Lars", lastName: "Holm", email: "lars@example.se", orgNumber: "556600-2222" },
  seMember: { phone: 3, country: "SE", cityId: "stockholm_lan", language: "sv", accountType: "driver", firstName: "Omar", lastName: "Said", email: "omar@example.se" },
} as const;
type Who = keyof typeof PEOPLE;

const reminders = async (who: Who, version?: string) => (await call(app, "GET", "/driver/reminders", { ...H[who]!, ...(version ? { "x-contract-version": version } : {}) })).json() as { items: Array<{ kind: string; level: string; fix?: unknown }>; blocksOnline: number };
const kinds = async (who: Who, version?: string) => (await reminders(who, version)).items.map((i) => i.kind);
const fleetOf = async (who: Who) => (await call(app, "GET", `/admin/fleets/${FLEET[who]}`, sup.headers)).json().fleet;
const review = async (who: Who, decision: string) => call(app, "POST", `/admin/fleets/${FLEET[who]}/review`, sup.headers, { expectedVersion: (await fleetOf(who)).version, decision, note: "ok" });
const addCar = (who: Who, plate: string) => call(app, "POST", "/driver/vehicles", H[who]!, { make: "Volvo", model: "V60", color: "Black", seats: 4, year: 2022, plate, fuel: "hybrid" });
async function setting(country: string, on: unknown) {
  const draft = (await call(app, "GET", `/admin/config/onboarding?country=${country}`, sup.headers)).json();
  const put = await call(app, "PUT", "/admin/config/onboarding", sup.headers, { expectedVersion: draft.version, country, document: { ...draft.document, fleetNeedsCarForApproval: on } });
  if (put.statusCode !== 200) return put;
  return call(app, "POST", "/admin/config/onboarding/publish", sup.headers, { expectedVersion: put.json().version, country });
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
    expect(res.statusCode, res.body).toBe(200);
    ID[who] = res.json().driverId;
    if (p.accountType === "fleet") FLEET[who] = res.json().fleet.fleetId;
  }
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

describe("v0.18.159 fleetNeedsCar: the setting", () => {
  it("is in the onboarding document of Sweden and France, on by default, a boolean only", async () => {
    for (const country of ["SE", "FR"]) {
      const draft = (await call(app, "GET", `/admin/config/onboarding?country=${country}`, sup.headers)).json();
      expect(draft.document.fleetNeedsCarForApproval).toBe(true);
    }
    expect((await setting("SE", "yes")).statusCode).toBe(400);
  });
});

describe("v0.18.159 fleetNeedsCar: the Home line fleet_no_car", () => {
  it("Sweden: a new fleet owner (pending fleet, no car) gets the red Add your first car line, not 'Everything is sent'", async () => {
    const list = await reminders("seOwner", NEW);
    expect(list.items).toContainEqual({ kind: "fleet_no_car", level: "blocks_online", fix: { target: "fleet_vehicles" } });
    const k = list.items.map((i) => i.kind);
    expect(k).toContain("fleet_not_approved");
    expect(k).not.toContain("account_not_active");
    expect(k).not.toContain("fleet_no_approved_car");
  });

  it("France: the same for the Paris fleet owner", async () => {
    expect((await reminders("frOwner", NEW)).items).toContainEqual({ kind: "fleet_no_car", level: "blocks_online", fix: { target: "fleet_vehicles" } });
  });

  it("an older app (X-Contract-Version below 0.18.159 or none) never gets the line", async () => {
    expect(await kinds("seOwner", OLD)).not.toContain("fleet_no_car");
    expect(await kinds("seOwner")).not.toContain("fleet_no_car");
  });

  it("a driver account (no fleet) never gets it", async () => {
    expect(await kinds("seMember", NEW)).not.toContain("fleet_no_car");
  });
});

describe("v0.18.159 fleetNeedsCar: no fleet approval with zero cars", () => {
  it("Sweden: approving a fleet with no car is 409 invalid_transition fleet_has_no_car and changes nothing", async () => {
    const before = await fleetOf("seOwner");
    const res = await review("seOwner", "approved");
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toMatchObject({ code: "invalid_transition", reason: "fleet_has_no_car" });
    const after = await fleetOf("seOwner");
    expect(after).toMatchObject({ status: "pending", version: before.version });
  });

  it("France: rejecting a fleet with no car is never refused for this", async () => {
    const res = await review("frOwner", "rejected");
    expect(res.statusCode, res.body).toBe(200);
    expect((await fleetOf("frOwner")).status).toBe("rejected");
    // A rejected fleet with no car: the owner still sees the line (whatever the fleet's status).
    expect(await kinds("frOwner", NEW)).toContain("fleet_no_car");
    expect((await review("frOwner", "approved")).json()).toMatchObject({ reason: "fleet_has_no_car" });
  });

  it("once the owner adds a car (any status) the line goes and the fleet can be approved", async () => {
    const car = await addCar("seOwner", "FNC 001");
    expect(car.statusCode, car.body).toBe(201);
    expect(await kinds("seOwner", NEW)).not.toContain("fleet_no_car");
    const res = await review("seOwner", "approved");
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().status).toBe("approved");
    const fr = await addCar("frOwner", "FN-001-FR");
    expect(fr.statusCode, fr.body).toBe(201);
    expect((await review("frOwner", "approved")).statusCode).toBe(200);
  });

  it("setting off (Sweden): approval ignores the cars; the owner of the approved car-less fleet still gets one car line, fleet_no_car", async () => {
    expect((await setting("SE", false)).statusCode).toBe(200);
    const res = await review("seOwner2", "approved");
    expect(res.statusCode, res.body).toBe(200);
    const k = await kinds("seOwner2", NEW);
    expect(k).toContain("fleet_no_car");
    expect(k).not.toContain("fleet_no_approved_car");
    // An older app keeps its old line.
    expect(await kinds("seOwner2", OLD)).toContain("fleet_no_approved_car");
    expect((await setting("SE", true)).statusCode).toBe(200);
  });
});
