import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { dispatchHandlers } from "../../src/dispatch/runtime.js";
import { seedDriver } from "../../src/drivers/service.js";
import { TimerWorker } from "../../src/jobs/timers.js";
import { rideHandlers } from "../../src/trips/ride.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { call, NORRMALM, SODERMALM, signIn, testWorld } from "../support/world.js";

/**
 * Owner bug 2026-11-01 (live admin, Stockholm): "+50 kr → Envoyer le radar" to a driver who already saw the trip from
 * the automatic dispatch answered "… already has this ride." and the raise was lost. A driver with an open offer keeps
 * it and sees the new money at once (offer_updated); only drivers without one get a new admin offer; 409 only when
 * nobody can get or keep an offer. Sweden (Z001, SEK) and France (FR-PC, EUR).
 */

let database: TestDatabase;
let app: FastifyInstance;
let worker: TimerWorker;
let admin: Record<string, string>;
const clock = { now: new Date("2026-11-01T12:00:00Z") };
const sample = (name: string) => JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/${name}.json`, "utf8"));
const inParis = (doc: unknown) => JSON.parse(JSON.stringify(doc).replace(/"SEK"/g, '"EUR"').replace(/"Z001"/g, '"FR-PC"').replace(/"SE"/g, '"FR"').replace(/Europe\/Stockholm/g, "Europe/Paris"));

const CASES = {
  SE: { zone: "Z001", currency: "SEK", pickup: NORRMALM, dropoff: SODERMALM, spots: { A: { lat: 59.3335, lng: 18.0655 }, B: { lat: 59.336, lng: 18.07 } } },
  FR: { zone: "FR-PC", currency: "EUR", pickup: { address: "Châtelet", lat: 48.8584, lng: 2.3472 }, dropoff: { address: "Gare de Lyon", lat: 48.8443, lng: 2.3744 }, spots: { A: { lat: 48.8590, lng: 2.3478 }, B: { lat: 48.8610, lng: 2.3500 } } },
} as const;
type Case = (typeof CASES)[keyof typeof CASES];
const drivers: Record<"A" | "B", { id: string; headers: Record<string, string> }> = {} as never;
let rider: Record<string, string>;

async function live(doc: "dispatch" | "rider_app_config" | "driver_app_config" | "pricing", zoneId: string, document: unknown) {
  await database.db.insertInto("config_live").values({ doc, zone_id: zoneId, version: 1, document: JSON.stringify(document), published_at: clock.now, published_by: null }).execute();
}

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  await live("dispatch", "Z001", sample("dispatch_document"));
  await live("rider_app_config", "Z001", sample("rider_app_config"));
  await live("dispatch", "FR-PC", inParis(sample("dispatch_document")));
  await live("rider_app_config", "FR-PC", inParis(sample("rider_app_config")));
  await live("driver_app_config", "FR-PC", inParis(sample("driver_app_config")));
  await live("pricing", "FR-PC", inParis(sample("pricing_document")));
  worker = new TimerWorker(database.db, { handlers: { ...dispatchHandlers, ...rideHandlers }, logger: { warn: () => undefined, error: (d, m) => console.error(m, d) }, clock: () => clock.now });
  for (const [key, phone] of [["A", TEST_PHONES[1]!], ["B", TEST_PHONES[2]!]] as const) {
    const made = await database.db.transaction().execute((trx) =>
      seedDriver(trx, { phone, firstName: `Driver ${key}`, make: "Volvo", model: "V60", year: 2021, color: "Black", plate: `RAI00${key}`, categoryIds: ["economy"], zoneIds: ["Z001", "FR-PC"] }, clock.now),
    );
    drivers[key] = { id: made.driverId, headers: {} };
  }
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

async function placeDrivers(c: Case) {
  for (const key of ["A", "B"] as const) {
    clock.now = new Date(clock.now.getTime() + 1000);
    await database.db.updateTable("drivers").set({ online_status: "online", last_free_at: clock.now, rating_sum: 0, rating_count: 0 }).where("driver_id", "=", drivers[key].id).execute();
    const res = await call(app, "POST", "/driver/location", drivers[key].headers, { fixes: [{ ...c.spots[key], accuracy: 5, measuredAt: clock.now.toISOString() }] });
    expect(res.statusCode).toBe(200);
  }
}

beforeEach(async () => {
  clock.now = new Date(clock.now.getTime() + 3600_000);
  await database.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("status", "not in", ["completed", "cancelled_by_admin", "cancelled_by_rider", "cancelled_by_driver", "no_show", "expired"]).execute();
  await database.db.deleteFrom("timers").execute();
  await database.db.deleteFrom("offers").execute();
  rider = (await signIn(app, TEST_PHONES[0]!, "rider")).headers;
  for (const key of ["A", "B"] as const) drivers[key].headers = (await signIn(app, { A: TEST_PHONES[1], B: TEST_PHONES[2] }[key]!, "driver")).headers;
  admin = (await adminSession(app, database.db, "super", { now: clock.now })).headers;
});

/** The rider books; the automatic dispatch offers the trip to A (the nearest) first. */
async function bookWithAutoOffer(c: Case) {
  await placeDrivers(c);
  const quote = (await call(app, "POST", "/quotes", rider, { pickup: c.pickup, dropoff: c.dropoff, stops: [], categoryIds: ["economy"] })).json().quotes[0];
  expect(quote.total.currency).toBe(c.currency);
  const res = await call(app, "POST", "/trips", rider, { quoteId: quote.quoteId, categoryId: "economy", pickup: c.pickup, dropoff: c.dropoff, stops: [], kind: "live", paymentMethod: "cash" });
  expect(res.statusCode).toBe(201);
  await worker.runDue();
  const tripId = res.json().tripId as string;
  const [auto] = (await call(app, "GET", "/driver/offers", drivers.A.headers)).json().items;
  expect(auto).toMatchObject({ tripId, source: "system" });
  return { tripId, auto };
}
const adminView = async (tripId: string) => (await call(app, "GET", `/admin/trips/${tripId}`, admin)).json();
const radar = async (tripId: string, body: Record<string, unknown>) => call(app, "POST", `/admin/trips/${tripId}/radar-group`, admin, { expectedVersion: (await adminView(tripId)).version, ...body });
const offerRows = (tripId: string, driverId: string) => database.db.selectFrom("offers").select(["offer_id", "status"]).where("trip_id", "=", tripId).where("driver_id", "=", driverId).execute();

describe.each(Object.entries(CASES))("admin raise + radar to a driver who already sees the trip (%s)", (_name, c) => {
  const money = (amountMinor: number) => ({ amountMinor, currency: c.currency });

  it("bonus + radar to the driver with the automatic offer: 200, the same offer with the new money, no duplicate, offer_updated", async () => {
    const { tripId, auto } = await bookWithAutoOffer(c);
    const res = await radar(tripId, { driverIds: [drivers.A.id], driverBonus: money(5000), priority: true });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.offers).toHaveLength(1);
    expect(body.offers[0]).toMatchObject({ offerId: auto.offerId, source: "system", fare: money(auto.fare.amountMinor + 5000), priority: true });
    expect(body.projection.driverBonus).toEqual(money(5000));
    const [seen] = (await call(app, "GET", "/driver/offers", drivers.A.headers)).json().items;
    expect(seen).toMatchObject({ offerId: auto.offerId, version: auto.version + 1, fare: money(auto.fare.amountMinor + 5000), driverEarnings: money(auto.driverEarnings.amountMinor + 5000), priority: true });
    expect(await offerRows(tripId, drivers.A.id)).toHaveLength(1);
    const last = await database.db.selectFrom("offer_events").select(["kind", "offer"]).where("driver_id", "=", drivers.A.id).orderBy("sequence", "desc").executeTakeFirstOrThrow();
    expect(last.kind).toBe("offer_updated");
    expect(last.offer).toMatchObject({ offerId: auto.offerId, fare: money(auto.fare.amountMinor + 5000) });
  });

  it("mixed group: A keeps and sees the raise, B gets a new admin offer with it", async () => {
    const { tripId, auto } = await bookWithAutoOffer(c);
    const res = await radar(tripId, { driverIds: [drivers.A.id, drivers.B.id], driverBonus: money(5000) });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.offers).toHaveLength(2);
    const fresh = body.offers.find((o: { groupId?: string }) => o.groupId === body.groupId);
    expect(fresh).toMatchObject({ source: "admin", kind: "radar", driverBonus: money(5000) });
    expect(body.offers.find((o: { offerId: string }) => o.offerId === auto.offerId)).toMatchObject({ fare: money(auto.fare.amountMinor + 5000) });
    expect(await offerRows(tripId, drivers.A.id)).toHaveLength(1);
    expect(await offerRows(tripId, drivers.B.id)).toHaveLength(1);
  });

  it("an offline driver in the group is left out; nobody available → 409 with the reason, and no bonus is kept", async () => {
    const { tripId } = await bookWithAutoOffer(c);
    await database.db.updateTable("drivers").set({ online_status: "offline" }).where("driver_id", "=", drivers.B.id).execute();
    const mixed = await radar(tripId, { driverIds: [drivers.A.id, drivers.B.id] });
    expect(mixed.statusCode, mixed.body).toBe(200);
    expect(mixed.json().offers).toHaveLength(1);
    expect(mixed.json().skipped).toEqual([{ driverId: drivers.B.id, reason: "driver_not_available" }]);
    const before = await adminView(tripId);
    const none = await radar(tripId, { driverIds: [drivers.B.id], driverBonus: money(5000) });
    expect(none.statusCode).toBe(409);
    expect(none.json()).toMatchObject({ code: "conflict", reason: "driver_not_available" });
    expect((await adminView(tripId)).driverBonus ?? null).toEqual(before.driverBonus ?? null);
  });

  it("exclusive assign to the driver with the automatic offer replaces it: old withdrawn, one open exclusive admin offer with the bonus", async () => {
    const { tripId, auto } = await bookWithAutoOffer(c);
    const res = await call(app, "POST", `/admin/trips/${tripId}/assign`, admin, { expectedVersion: (await adminView(tripId)).version, driverId: drivers.A.id, driverBonus: money(5000) });
    expect(res.statusCode, res.body).toBe(200);
    const items = (await call(app, "GET", "/driver/offers", drivers.A.headers)).json().items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "assigned", source: "admin", fare: money(auto.fare.amountMinor + 5000) });
    expect(items[0].offerId).not.toBe(auto.offerId);
    const rows = await database.db.selectFrom("offers").select(["offer_id", "status"]).where("trip_id", "=", tripId).where("driver_id", "=", drivers.A.id).orderBy("offer_id").execute();
    expect(rows.map((r) => r.status).sort()).toEqual(["open", "withdrawn"]);
    const kinds = (await database.db.selectFrom("offer_events").select("kind").where("driver_id", "=", drivers.A.id).orderBy("sequence", "desc").limit(2).execute()).map((e) => e.kind);
    expect(kinds).toEqual(["offer_created", "offer_withdrawn"]);
  });

  it("owner live test 2026-11-01: a driver document with 0 s never sends a 0 s offer (assign 30 s, radar 15 s)", async () => {
    const { tripId } = await bookWithAutoOffer(c);
    const zeroed = { ...sample("driver_app_config"), offers: { ...sample("driver_app_config").offers, radarSeconds: 0, exclusiveSeconds: 0, assignAcceptSeconds: 0 } };
    const before = await database.db.selectFrom("config_live").select(["document"]).where("doc", "=", "driver_app_config").where("zone_id", "=", c.zone).executeTakeFirst();
    await database.db.deleteFrom("config_live").where("doc", "=", "driver_app_config").where("zone_id", "=", c.zone).execute();
    await live("driver_app_config", c.zone, c.zone === "Z001" ? zeroed : inParis(zeroed));
    try {
      const res = await call(app, "POST", `/admin/trips/${tripId}/assign`, admin, { expectedVersion: (await adminView(tripId)).version, driverId: drivers.B.id });
      expect(res.statusCode, res.body).toBe(200);
      const [offer] = (await call(app, "GET", "/driver/offers", drivers.B.headers)).json().items;
      expect(Date.parse(offer.expiresAt) - clock.now.getTime()).toBeGreaterThanOrEqual(15_000);
    } finally {
      await database.db.deleteFrom("config_live").where("doc", "=", "driver_app_config").where("zone_id", "=", c.zone).execute();
      if (before) await live("driver_app_config", c.zone, before.document);
    }
  });
});

