import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { requestJoin } from "../../src/drivers/invitations.js";
import { fleetEarnings, submitOnboarding } from "../../src/drivers/onboarding.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver } from "../support/seed.js";
import { call, signIn, testWorld } from "../support/world.js";

/**
 * BQ-FLEETCUR (owner 2026-11-15 08:44 UTC, Rules decisions/session-2026-11-06.md:1322): a fleet works in ONE country and
 * earns in ONE currency; two currencies in one fleet must be impossible. (1) A driver joins only a fleet of his own
 * country (his country, else his first zone's: the server's one person-country rule): every path that links him is
 * 409 conflict `fleet_other_country` otherwise. (2) GET /driver/fleet/earnings counts only entries in the fleet's
 * currency (defense in depth for a member linked before this rule).
 */

let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-11-15T09:00:00Z") };
let owner: Record<string, string>;
let pierre: Record<string, string>;
let sven: Record<string, string>;
let admin: { headers: Record<string, string>; adminId: string };
let seFleetId: string;
let seCode: string;
let pierreId: string;
let svenId: string;

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
const french = { firstName: "Pierre", lastName: "Martin", email: "pierre@example.fr", country: "FR", cityId: "paris", language: "fr", accountType: "driver", company: undefined };
const swede = { firstName: "Sven", lastName: "Ek", email: "sven@example.se", accountType: "driver", company: undefined };
const joinSe = (driver: Record<string, string>) => call(app, "POST", "/driver/fleet/join", driver, { code: seCode, ownerName: "Fredrik Åkesson", ownerEmail: "fredrik@example.se" });
const fleetOf = async (driverId: string) => (await database.db.selectFrom("drivers").select("fleet_id").where("driver_id", "=", driverId).executeTakeFirstOrThrow()).fleet_id;
const invitationRow = (fleetId: string, driverId: string, direction: "owner_invite" | "driver_request", id: string) =>
  database.db
    .insertInto("fleet_invitations")
    .values({ invitation_id: id, fleet_id: fleetId, direction, driver_id: driverId, phone: null, expires_at: new Date(clock.now.getTime() + 86400_000), created_at: clock.now, updated_at: clock.now })
    .execute();

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  owner = (await signIn(app, TEST_PHONES[0]!, "driver")).headers;
  pierre = (await signIn(app, TEST_PHONES[1]!, "driver")).headers;
  sven = (await signIn(app, TEST_PHONES[2]!, "driver")).headers;
  admin = await adminSession(app, database.db, "super", { now: clock.now });
  await call(app, "POST", "/driver/onboarding", owner, details());
  pierreId = (await call(app, "POST", "/driver/onboarding", pierre, details(french))).json().driverId;
  svenId = (await call(app, "POST", "/driver/onboarding", sven, details(swede))).json().driverId;
  const fleet = (await call(app, "GET", "/driver/fleet", owner)).json().fleet;
  seFleetId = fleet.fleetId;
  // v0.18.159 (fleetNeedsCar): a fleet is approved only with at least one car.
  expect((await call(app, "POST", "/driver/vehicles", owner, { make: "Volvo", model: "V60", color: "Black", seats: 4, year: 2022, plate: "FNC 100", fuel: "hybrid" })).statusCode).toBe(201);
  seCode = (await call(app, "POST", `/admin/fleets/${seFleetId}/review`, admin.headers, { expectedVersion: fleet.version, decision: "approved" })).json().code;
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

describe("BQ-FLEETCUR: a driver joins only a fleet of his own country", () => {
  it("a French driver asking a Swedish fleet with the right code is 409 fleet_other_country; nothing is created", async () => {
    const res = await joinSe(pierre);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "conflict", reason: "fleet_other_country" });
    expect(await database.db.selectFrom("fleet_invitations").select("invitation_id").where("driver_id", "=", pierreId).execute()).toEqual([]);
    expect(await fleetOf(pierreId)).toBeNull();
  });

  it("the Swedish owner inviting the French driver's number is 409 fleet_other_country", async () => {
    const res = await call(app, "POST", "/driver/fleet/invite", owner, { phone: TEST_PHONES[1] });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "conflict", reason: "fleet_other_country" });
  });

  it("an invitation made before the rule (or before he signed up) cannot be accepted by him, the owner or an admin", async () => {
    await invitationRow(seFleetId, pierreId, "owner_invite", "inv_fcur_owner_invite");
    const byDriver = await call(app, "POST", "/driver/fleet/invitations/inv_fcur_owner_invite/accept", pierre);
    expect(byDriver.statusCode).toBe(409);
    expect(byDriver.json()).toMatchObject({ code: "conflict", reason: "fleet_other_country" });
    const byAdmin = await call(app, "POST", `/admin/fleets/${seFleetId}/invitations/inv_fcur_owner_invite/accept`, admin.headers);
    expect(byAdmin.statusCode).toBe(409);
    expect(byAdmin.json()).toMatchObject({ code: "conflict", reason: "fleet_other_country" });
    await invitationRow(seFleetId, pierreId, "driver_request", "inv_fcur_driver_request");
    const byOwner = await call(app, "POST", "/driver/fleet/invitations/inv_fcur_driver_request/accept", owner);
    expect(byOwner.statusCode).toBe(409);
    expect(byOwner.json()).toMatchObject({ code: "conflict", reason: "fleet_other_country" });
    expect(await fleetOf(pierreId)).toBeNull();
  });

  it("a driver of a Tunisian fleet's other country (SE) is refused too; a TN driver joins it", async () => {
    const tnOwner = await insertDriver(database.db);
    await database.db.updateTable("drivers").set({ first_name: "Karim", last_name: "Ben Ali", email: "karim@example.tn", country: "TN", zone_ids: ["TN-TC"], account_type: "fleet" }).where("driver_id", "=", tnOwner).execute();
    await database.db.insertInto("fleets").values({ fleet_id: "flt_fcur_tn", name: "Tunis Taxi", org_number: "1234567A", country: "TN", city_id: "tunis", zone_id: "TN-TC", owner_driver_id: tnOwner, status: "approved", code: "MV-TNF26" }).execute();
    await database.db.updateTable("drivers").set({ fleet_id: "flt_fcur_tn", fleet_linked_at: clock.now }).where("driver_id", "=", tnOwner).execute();
    const res = await call(app, "POST", "/driver/fleet/join", sven, { code: "MV-TNF26", ownerName: "Karim Ben Ali", ownerEmail: "karim@example.tn" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "conflict", reason: "fleet_other_country" });
    // A driver with no country of his own takes his first zone's (TN-TC is Tunisia).
    const tnDriver = await insertDriver(database.db);
    await database.db.updateTable("drivers").set({ account_type: "driver", zone_ids: ["TN-TC"] }).where("driver_id", "=", tnDriver).execute();
    await invitationRow("flt_fcur_tn", tnDriver, "driver_request", "inv_fcur_tn_ok");
    const ok = await call(app, "POST", "/admin/fleets/flt_fcur_tn/invitations/inv_fcur_tn_ok/accept", admin.headers);
    expect(ok.statusCode).toBe(200);
    expect(await fleetOf(tnDriver)).toBe("flt_fcur_tn");
  });

  it("a driver with no country and no zone is refused (his country is unknown, never assumed)", async () => {
    const nowhere = await insertDriver(database.db);
    await database.db.updateTable("drivers").set({ account_type: "driver", country: null, zone_ids: [] }).where("driver_id", "=", nowhere).execute();
    await invitationRow(seFleetId, nowhere, "driver_request", "inv_fcur_nowhere");
    const res = await call(app, "POST", `/admin/fleets/${seFleetId}/invitations/inv_fcur_nowhere/accept`, admin.headers);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "conflict", reason: "fleet_other_country" });
    expect(await fleetOf(nowhere)).toBeNull();
  });

  it("a Swedish driver joins the Swedish fleet; then he cannot move his details to France while in it", async () => {
    expect((await joinSe(sven)).statusCode).toBe(201);
    const pending = (await call(app, "GET", "/driver/fleet/invitations", owner)).json().items.find((i: { driverId?: string; status: string }) => i.driverId === svenId && i.status === "pending");
    expect((await call(app, "POST", `/driver/fleet/invitations/${pending.invitationId}/accept`, owner)).statusCode).toBe(200);
    expect(await fleetOf(svenId)).toBe(seFleetId);
    const moved = await call(app, "POST", "/driver/onboarding", sven, details({ ...swede, country: "FR", cityId: "paris", language: "fr" }));
    expect(moved.statusCode).toBe(409);
    expect(moved.json()).toMatchObject({ code: "conflict", reason: "fleet_other_country" });
    expect((await database.db.selectFrom("drivers").select("country").where("driver_id", "=", svenId).executeTakeFirstOrThrow()).country).toBe("SE");
  });

  it("the owner cannot move his fleet to another country while it has a driver", async () => {
    const moved = await call(app, "POST", "/driver/onboarding", owner, details({ country: "FR", cityId: "paris", language: "fr" }));
    expect(moved.statusCode).toBe(409);
    expect(moved.json()).toMatchObject({ code: "conflict", reason: "fleet_other_country" });
    expect((await database.db.selectFrom("fleets").select("country").where("fleet_id", "=", seFleetId).executeTakeFirstOrThrow()).country).toBe("SE");
  });
});

/* ------------------------------------------------- earnings: only the fleet's currency (moved from the proof test) */

const FROM = new Date("2026-11-09T00:00:00Z");
const AT = new Date("2026-11-10T10:00:00Z");
const NOW = new Date("2026-11-12T09:00:00Z");
const m = (amountMinor: number, currency: string) => ({ amountMinor, currency });
let n = 0;
async function seededFleet(country: "SE" | "TN") {
  const ownerId = await insertDriver(database.db);
  const member = await insertDriver(database.db);
  const fleetId = `flt_fcur_e${++n}`;
  await database.db.insertInto("fleets").values({ fleet_id: fleetId, name: "FC Taxi", org_number: "556677-8899", country, city_id: country === "SE" ? "stockholm_lan" : "tunis", zone_id: country === "SE" ? "Z001" : "TN-TC", owner_driver_id: ownerId, status: "approved" }).execute();
  // A member linked before the join rule (a foreign entry can only be old data now).
  await database.db.updateTable("drivers").set({ fleet_id: fleetId, fleet_linked_at: FROM }).where("driver_id", "in", [ownerId, member]).execute();
  return { ownerId, member };
}
const tripEntry = (driverId: string, currency: string, earnings: number) =>
  database.db.insertInto("earnings_entries").values({ entry_id: `ern_fcur_${++n}`, driver_id: driverId, trip_id: null, kind: "trip", currency, amount_minor: earnings, gross_minor: null, commission_minor: null, cash_minor: 0, at: AT }).execute();
const view = (ownerId: string) => fleetEarnings(database.db, ownerId, { from: FROM.toISOString(), to: NOW.toISOString() }, NOW);

describe("BQ-FLEETCUR: fleet earnings count only the fleet's currency", () => {
  it("SEK fleet: 160 kr + 16.000 DT shows 160 kr, never 32 000 (SEK)", async () => {
    const { ownerId, member } = await seededFleet("SE");
    await tripEntry(member, "SEK", 16_000);
    await tripEntry(member, "TND", 16_000);
    const v = await view(ownerId);
    expect(v.items.find((i) => i.driverId === member)).toMatchObject({ trips: 1, earnings: m(16_000, "SEK") });
    expect(v.total).toEqual(m(16_000, "SEK"));
  });

  it("TND fleet: 16.000 DT + 160 kr shows 16.000 DT, never 32.000 DT", async () => {
    const { ownerId, member } = await seededFleet("TN");
    await tripEntry(member, "TND", 16_000);
    await tripEntry(member, "SEK", 16_000);
    const v = await view(ownerId);
    expect(v.items.find((i) => i.driverId === member)).toMatchObject({ trips: 1, earnings: m(16_000, "TND") });
    expect(v.total).toEqual(m(16_000, "TND"));
  });
});

/* ------------------------------------- MF1: the owner's country change and a join race (two connections, one wins) */

describe("BQ-FLEETCUR MF1: an owner moving his fleet to France and a Swedish driver joining never both win", () => {
  const deps = {} as never;
  const ownerToFrance = (ownerId: string) => (trx: Parameters<typeof submitOnboarding>[0]) => submitOnboarding(trx, deps, ownerId, details({ email: "fredrik@example.se", country: "FR", cityId: "paris", language: "fr" }), clock.now);
  async function race(phone: string, first: "owner" | "join") {
    const ownerHeaders = (await signIn(app, phone, "driver")).headers;
    const ownerId = (await call(app, "POST", "/driver/onboarding", ownerHeaders, details())).json().driverId as string;
    await call(app, "POST", "/driver/vehicles", ownerHeaders, { make: "Volvo", model: "V60", color: "Black", seats: 4, year: 2022, plate: `FNC ${first}`, fuel: "hybrid" }); // v0.18.159 (fleetNeedsCar): a fleet is approved only with at least one car.
    const f = (await call(app, "GET", "/driver/fleet", ownerHeaders)).json().fleet;
    const code = (await call(app, "POST", `/admin/fleets/${f.fleetId}/review`, admin.headers, { expectedVersion: f.version, decision: "approved" })).json().code as string;
    const member = await insertDriver(database.db);
    await database.db.updateTable("drivers").set({ account_type: "driver", country: "SE", zone_ids: ["Z001"] }).where("driver_id", "=", member).execute();
    const invitationId = `inv_fcur_race_${first}`;
    await invitationRow(f.fleetId, member, "owner_invite", invitationId);
    // The driver asks with the code while the owner's invite waits: POST /driver/fleet/join links him at once (matchFleet -> link).
    const join = (trx: Parameters<typeof requestJoin>[0]) => requestJoin(trx, deps, member, { code, ownerName: "Fredrik Åkesson", ownerEmail: "fredrik@example.se" }, clock.now);
    // The first transaction does its work and stays open; the second starts on another connection meanwhile.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let ready!: () => void;
    const started = new Promise<void>((r) => (ready = r));
    const firstWork = first === "owner" ? ownerToFrance(ownerId) : join;
    const secondWork = first === "owner" ? join : ownerToFrance(ownerId);
    const one = database.db.transaction().execute(async (trx) => {
      const out = await firstWork(trx as never);
      ready();
      await gate;
      return out;
    });
    await started;
    const two = database.db.transaction().execute(async (trx) => secondWork(trx as never));
    await new Promise((r) => setTimeout(r, 300));
    release();
    const [a, b] = await Promise.allSettled([one, two]);
    const fleet = await database.db.selectFrom("fleets").select("country").where("fleet_id", "=", f.fleetId).executeTakeFirstOrThrow();
    return { results: [a.status, b.status], loser: [a, b].find((x) => x.status === "rejected") as PromiseRejectedResult | undefined, fleetCountry: fleet.country, memberFleet: await fleetOf(member), fleetId: f.fleetId };
  }

  it("the owner first: the join waits for him, then is refused (the fleet is French now)", async () => {
    const r = await race(TEST_PHONES[3]!, "owner");
    expect(r.results).toEqual(["fulfilled", "rejected"]);
    expect(r.loser!.reason).toMatchObject({ options: { reason: "fleet_other_country" } });
    expect(r.fleetCountry).toBe("FR");
    expect(r.memberFleet).toBeNull();
  });

  it("the join first: the owner's change waits for it, then is refused (the fleet has a driver now)", async () => {
    const r = await race(TEST_PHONES[4]!, "join");
    expect(r.results).toEqual(["fulfilled", "rejected"]);
    expect(r.loser!.reason).toMatchObject({ options: { reason: "fleet_other_country" } });
    expect(r.fleetCountry).toBe("SE");
    expect(r.memberFleet).toBe(r.fleetId);
  });
});
