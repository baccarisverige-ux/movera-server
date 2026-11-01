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
 * Owner bug 2026-11-01 (live admin FR, Stockholm): "Ajouter de l'argent", Appliquer à: Exclusif, 200 kr → the driver
 * saw the money on his Radar offer. The admin's money is kept per kind of offer: Exclusive money only on exclusive
 * offers, Radar money only on radar offers, Both on both; accept pays the kind the driver took. SE and FR.
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

const bonusPost = async (tripId: string, body: Record<string, unknown>) => call(app, "POST", `/admin/trips/${tripId}/driver-bonus`, admin, { expectedVersion: (await adminView(tripId)).version, ...body });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const offersOf = async (key: "A" | "B") => (await call(app, "GET", "/driver/offers", drivers[key].headers)).json().items as any;

describe.each(Object.entries(CASES))("admin money per kind of offer (%s)", (_name, c) => {
  const money = (amountMinor: number) => ({ amountMinor, currency: c.currency });

  it("Add money for Exclusive while only a radar offer is out: the radar offer does not change; the next exclusive offer carries it", async () => {
    const { tripId, auto } = await bookWithAutoOffer(c);
    await database.db.updateTable("offers").set({ kind: "radar" }).where("offer_id", "=", auto.offerId).execute();
    const res = await bonusPost(tripId, { amount: money(2000), priority: true, applyTo: "exclusive" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().driverBonusByKind).toEqual({ exclusive: { ...money(2000), priority: true }, radar: { ...money(0), priority: false } });
    const [seen] = await offersOf("A");
    expect(seen).toMatchObject({ offerId: auto.offerId, kind: "radar", version: auto.version, fare: auto.fare, priority: false });
    expect(seen.driverBonus).toBeUndefined();
    const sent = await call(app, "POST", `/admin/trips/${tripId}/assign`, admin, { expectedVersion: (await adminView(tripId)).version, driverId: drivers.B.id });
    expect(sent.statusCode, sent.body).toBe(200);
    const [excl] = await offersOf("B");
    expect(excl).toMatchObject({ kind: "assigned", driverBonus: money(2000), priority: true });
  });

  it("Add money for Exclusive while an exclusive offer is out: that driver sees it at once (offer_updated) with Priority", async () => {
    const { tripId } = await bookWithAutoOffer(c);
    const sent = await call(app, "POST", `/admin/trips/${tripId}/assign`, admin, { expectedVersion: (await adminView(tripId)).version, driverId: drivers.B.id });
    expect(sent.statusCode, sent.body).toBe(200);
    const [before] = await offersOf("B");
    const res = await bonusPost(tripId, { amount: money(2000), priority: true, applyTo: "exclusive" });
    expect(res.statusCode, res.body).toBe(200);
    const [after] = await offersOf("B");
    expect(after).toMatchObject({ offerId: before.offerId, kind: "assigned", version: before.version + 1, fare: money(before.fare.amountMinor + 2000), driverBonus: money(2000), priority: true });
  });

  it("Radar money stays off the exclusive offer; Both reaches both; the limit counts per kind", async () => {
    const { tripId, auto } = await bookWithAutoOffer(c);
    await database.db.updateTable("offers").set({ kind: "radar" }).where("offer_id", "=", auto.offerId).execute();
    await call(app, "POST", `/admin/trips/${tripId}/assign`, admin, { expectedVersion: (await adminView(tripId)).version, driverId: drivers.B.id });
    expect((await bonusPost(tripId, { amount: money(1000), applyTo: "radar" })).statusCode).toBe(200);
    expect((await offersOf("A"))[0]).toMatchObject({ driverBonus: money(1000) });
    expect((await offersOf("B"))[0].driverBonus).toBeUndefined();
    expect((await bonusPost(tripId, { amount: money(500), applyTo: "both" })).statusCode).toBe(200);
    expect((await offersOf("A"))[0]).toMatchObject({ driverBonus: money(1500) });
    expect((await offersOf("B"))[0]).toMatchObject({ driverBonus: money(500) });
    const view = await adminView(tripId);
    expect(view.driverBonus).toEqual(money(1500));
    expect(view.driverBonusByKind).toMatchObject({ exclusive: money(500), radar: money(1500) });
  });

  it("accept pays the kind the driver took: radar driver gets the radar money, commission counts only that", async () => {
    const { tripId, auto } = await bookWithAutoOffer(c);
    await database.db.updateTable("offers").set({ kind: "radar" }).where("offer_id", "=", auto.offerId).execute();
    await bonusPost(tripId, { amount: money(2000), applyTo: "exclusive" });
    await bonusPost(tripId, { amount: money(300), applyTo: "radar" });
    const [offer] = await offersOf("A");
    const res = await call(app, "POST", `/offers/${offer.offerId}/accept`, drivers.A.headers, { expectedVersion: offer.version });
    expect(res.statusCode, res.body).toBe(200);
    const row = await database.db.selectFrom("trips").select(["driver_bonus_minor", "commission_minor", "fare_minor", "driver_earnings_minor", "pickup_pay_minor"]).where("trip_id", "=", tripId).executeTakeFirstOrThrow();
    expect(Number(row.driver_bonus_minor)).toBe(300);
    expect(Number(row.commission_minor)).toBe(Number(row.fare_minor) - Number(row.driver_earnings_minor) - Number(row.pickup_pay_minor ?? 0) - 300);
  });

  it("an old caller without applyTo adds to both kinds (unchanged behaviour)", async () => {
    const { tripId, auto } = await bookWithAutoOffer(c);
    const res = await bonusPost(tripId, { amount: money(700) });
    expect(res.statusCode, res.body).toBe(200);
    expect((await offersOf("A"))[0]).toMatchObject({ offerId: auto.offerId, driverBonus: money(700) });
    expect(res.json().driverBonusByKind).toMatchObject({ exclusive: money(700), radar: money(700) });
  });
});
