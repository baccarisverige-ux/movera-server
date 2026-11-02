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

describe.each(Object.entries(CASES))("admin money per kind of offer, sent at once (%s)", (_name, c) => {
  const money = (amountMinor: number) => ({ amountMinor, currency: c.currency });

  it("Exclusive with only a radar offer out: the nearest free driver gets an exclusive offer with the money now", async () => {
    const { tripId, auto } = await bookWithAutoOffer(c);
    await database.db.updateTable("offers").set({ kind: "radar" }).where("offer_id", "=", auto.offerId).execute();
    const res = await bonusPost(tripId, { amount: money(2000), priority: true, applyTo: "exclusive" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().moneySend).toMatchObject({ exclusiveTo: drivers.A.id, radarTo: [] });
    expect(res.json().driverBonusByKind).toEqual({ exclusive: { ...money(2000), priority: true }, radar: { ...money(0), priority: false } });
    const items = await offersOf("A");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "assigned", source: "admin", driverBonus: money(2000), priority: true });
    expect(await offersOf("B")).toHaveLength(0);
  });

  it("Exclusive with an exclusive offer already out: that offer shows the money (offer_updated), nothing new is sent", async () => {
    const { tripId } = await bookWithAutoOffer(c);
    const sent = await call(app, "POST", `/admin/trips/${tripId}/assign`, admin, { expectedVersion: (await adminView(tripId)).version, driverId: drivers.B.id });
    expect(sent.statusCode, sent.body).toBe(200);
    const [before] = await offersOf("B");
    const res = await bonusPost(tripId, { amount: money(2000), priority: true, applyTo: "exclusive" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().moneySend).toMatchObject({ exclusiveTo: null, radarTo: [] });
    const [after] = await offersOf("B");
    expect(after).toMatchObject({ offerId: before.offerId, kind: "assigned", version: before.version + 1, fare: money(before.fare.amountMinor + 2000), driverBonus: money(2000), priority: true });
  });

  it("Radar turns the open exclusive offer into radar and sends radar to the other free drivers; Both then sends exclusive to the nearest", async () => {
    const { tripId, auto } = await bookWithAutoOffer(c);
    const radar = await bonusPost(tripId, { amount: money(1000), applyTo: "radar" });
    expect(radar.statusCode, radar.body).toBe(200);
    expect(radar.json().moneySend.exclusiveTo).toBeNull();
    expect([...radar.json().moneySend.radarTo].sort()).toEqual([drivers.A.id, drivers.B.id].sort());
    expect((await offersOf("A"))[0]).toMatchObject({ offerId: auto.offerId, kind: "radar", driverBonus: money(1000) });
    expect((await offersOf("B"))[0]).toMatchObject({ kind: "radar", source: "admin", driverBonus: money(1000) });
    const both = await bonusPost(tripId, { amount: money(500), applyTo: "both" });
    expect(both.statusCode, both.body).toBe(200);
    expect(both.json().moneySend).toMatchObject({ exclusiveTo: drivers.A.id, radarTo: [] });
    const a = await offersOf("A");
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ kind: "assigned", driverBonus: money(500) });
    expect((await offersOf("B"))[0]).toMatchObject({ kind: "radar", driverBonus: money(1500) });
    const view = await adminView(tripId);
    expect(view.driverBonus).toEqual(money(1500));
    expect(view.driverBonusByKind).toMatchObject({ exclusive: money(500), radar: money(1500) });
  });

  it("Both on a trip with no offer out: exclusive to the nearest and radar to the others at the same time", async () => {
    const { tripId, auto } = await bookWithAutoOffer(c);
    await database.db.updateTable("offers").set({ status: "withdrawn" }).where("offer_id", "=", auto.offerId).execute();
    const res = await bonusPost(tripId, { amount: money(800), applyTo: "both" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().moneySend).toMatchObject({ exclusiveTo: drivers.A.id, radarTo: [drivers.B.id] });
    expect((await offersOf("A"))[0]).toMatchObject({ kind: "assigned", driverBonus: money(800) });
    expect((await offersOf("B"))[0]).toMatchObject({ kind: "radar", driverBonus: money(800) });
  });

  it("nobody free: the money is kept, nothing is sent, no error", async () => {
    const { tripId, auto } = await bookWithAutoOffer(c);
    await database.db.updateTable("offers").set({ status: "withdrawn" }).where("offer_id", "=", auto.offerId).execute();
    await database.db.updateTable("drivers").set({ online_status: "offline" }).where("driver_id", "in", [drivers.A.id, drivers.B.id]).execute();
    // As live: nobody was free, so the automatic dispatch left the trip searching (no offer out).
    await database.db.updateTable("trips").set({ status: "searching" }).where("trip_id", "=", tripId).execute();
    const res = await bonusPost(tripId, { amount: money(800), applyTo: "exclusive" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().moneySend).toEqual({ exclusiveTo: null, radarTo: [], skipped: { expired: 0, busy: 0, far: 0 }, reachKm: 8 });
    expect(res.json().driverBonusByKind).toMatchObject({ exclusive: money(800) });
    // Live test 2026-11-01: no offer went out, so the trip keeps waiting (not offered) and no priority was asked.
    expect(res.json().status).toBe("searching");
    expect(res.json().driverBonusByKind.exclusive.priority).toBe(false);
    // The automatic dispatch still picks it up when a driver comes online, with the money and no Priority badge.
    await placeDrivers(c);
    clock.now = new Date(clock.now.getTime() + 60_000);
    await worker.runDue();
    const [next] = await offersOf("A").then((items: unknown[]) => items.length ? items : offersOf("B"));
    expect(next).toMatchObject({ tripId, driverBonus: money(800), priority: false });
  });

  it("live G8 8: Radar money with nobody free waits on the ride; an automatic exclusive offer does not carry it, the next radar offer does", async () => {
    const { tripId, auto } = await bookWithAutoOffer(c);
    await database.db.updateTable("offers").set({ status: "withdrawn" }).where("offer_id", "=", auto.offerId).execute();
    await database.db.updateTable("drivers").set({ online_status: "offline" }).where("driver_id", "in", [drivers.A.id, drivers.B.id]).execute();
    await database.db.updateTable("trips").set({ status: "searching" }).where("trip_id", "=", tripId).execute();
    const res = await bonusPost(tripId, { amount: money(800), priority: true, applyTo: "radar" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().moneySend).toMatchObject({ exclusiveTo: null, radarTo: [] });
    // The admin sees where the money waits: on the radar side, with its badge, nothing on the exclusive side.
    expect(res.json().driverBonusByKind).toEqual({ exclusive: { ...money(0), priority: false }, radar: { ...money(800), priority: true } });
    // A driver comes online: the automatic first offer is exclusive (money per kind: the radar money is not on it).
    await placeDrivers(c);
    clock.now = new Date(clock.now.getTime() + 60_000);
    await worker.runDue();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const seen: any[] = [];
    for (let round = 0; round < 20 && !seen.some((o) => o.kind === "radar"); round++) {
      for (const key of ["A", "B"] as const) {
        for (const offer of await offersOf(key)) {
          if (offer.tripId !== tripId || seen.some((o) => o.offerId === offer.offerId && o.version === offer.version)) continue;
          seen.push(offer);
          if (offer.kind !== "radar") {
            expect(offer.driverBonus, `exclusive ${offer.offerId}`).toBeUndefined();
            expect(offer.priority).toBe(false);
            // He lets it go: the dispatch moves on.
            expect((await call(app, "POST", `/offers/${offer.offerId}/decline`, drivers[key].headers, { expectedVersion: offer.version })).statusCode).toBe(200);
          }
        }
      }
      // Their phones keep sending positions while they wait.
      await placeDrivers(c);
      clock.now = new Date(clock.now.getTime() + 20_000);
      await worker.runDue();
    }
    const radar = seen.find((o) => o.kind === "radar");
    expect(radar, JSON.stringify(seen.map((o) => o.kind))).toBeDefined();
    expect(radar).toMatchObject({ tripId, driverBonus: money(800), priority: true });
    // Still waiting for the radar until someone takes it.
    expect((await adminView(tripId)).driverBonusByKind.radar).toEqual({ ...money(800), priority: true });
  });

  it("Add money without priority: the offer sent at once has no Priority badge", async () => {
    const { tripId, auto } = await bookWithAutoOffer(c);
    await database.db.updateTable("offers").set({ status: "withdrawn" }).where("offer_id", "=", auto.offerId).execute();
    const res = await bonusPost(tripId, { amount: money(500), applyTo: "exclusive" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().moneySend.exclusiveTo).toBe(drivers.A.id);
    expect(res.json().status).toBe("offered");
    expect((await offersOf("A"))[0]).toMatchObject({ tripId, driverBonus: money(500), priority: false });
  });

  it("a driver who holds an open exclusive offer on another trip is skipped: the next nearest free driver gets the exclusive", async () => {
    const { tripId, auto } = await bookWithAutoOffer(c);
    const other = await database.db.selectFrom("trips").select("trip_id").where("trip_id", "!=", tripId).executeTakeFirstOrThrow();
    const row = await database.db.selectFrom("offers").selectAll().where("offer_id", "=", auto.offerId).executeTakeFirstOrThrow();
    await database.db.insertInto("offers").values({ ...row, offer_id: `${row.offer_id}x`, trip_id: other.trip_id, kind: "assigned" }).execute();
    await database.db.updateTable("offers").set({ status: "withdrawn" }).where("offer_id", "=", auto.offerId).execute();
    const res = await bonusPost(tripId, { amount: money(900), applyTo: "exclusive" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().moneySend).toMatchObject({ exclusiveTo: drivers.B.id, radarTo: [] });
    expect((await offersOf("B"))[0]).toMatchObject({ tripId, kind: "assigned", driverBonus: money(900) });
  });

  it("a driver who declined this ride is not offered it again (exclusive and radar)", async () => {
    const { tripId, auto } = await bookWithAutoOffer(c);
    const declined = await call(app, "POST", `/offers/${auto.offerId}/decline`, drivers.A.headers, { expectedVersion: auto.version });
    expect(declined.statusCode, declined.body).toBe(200);
    await database.db.updateTable("offers").set({ status: "withdrawn" }).where("trip_id", "=", tripId).where("status", "=", "open").execute();
    const radar = await bonusPost(tripId, { amount: money(400), applyTo: "radar" });
    expect(radar.statusCode, radar.body).toBe(200);
    expect(radar.json().moneySend).toMatchObject({ exclusiveTo: null, radarTo: [drivers.B.id], skipped: { expired: 1 } });
    await database.db.updateTable("offers").set({ status: "withdrawn" }).where("trip_id", "=", tripId).where("status", "=", "open").execute();
    const both = await bonusPost(tripId, { amount: money(400), applyTo: "both" });
    expect(both.statusCode, both.body).toBe(200);
    expect(both.json().moneySend).toMatchObject({ exclusiveTo: drivers.B.id, radarTo: [] });
    expect(await offersOf("A")).toHaveLength(0);
  });

  it("accept pays the kind the driver took: the radar driver gets the radar money, commission counts only that", async () => {
    const { tripId } = await bookWithAutoOffer(c);
    expect((await bonusPost(tripId, { amount: money(300), applyTo: "radar" })).statusCode).toBe(200);
    expect((await bonusPost(tripId, { amount: money(2000), applyTo: "exclusive" })).statusCode).toBe(200);
    const [offer] = await offersOf("B");
    expect(offer).toMatchObject({ kind: "radar", driverBonus: money(300) });
    const res = await call(app, "POST", `/offers/${offer.offerId}/accept`, drivers.B.headers, { expectedVersion: offer.version });
    expect(res.statusCode, res.body).toBe(200);
    const row = await database.db.selectFrom("trips").select(["driver_bonus_minor", "commission_minor", "fare_minor", "driver_earnings_minor", "pickup_pay_minor"]).where("trip_id", "=", tripId).executeTakeFirstOrThrow();
    expect(Number(row.driver_bonus_minor)).toBe(300);
    expect(Number(row.commission_minor)).toBe(Number(row.fare_minor) - Number(row.driver_earnings_minor) - Number(row.pickup_pay_minor ?? 0) - 300);
  });

  it("an old caller without applyTo adds to both kinds and sends nothing new (unchanged behaviour)", async () => {
    const { tripId, auto } = await bookWithAutoOffer(c);
    const res = await bonusPost(tripId, { amount: money(700) });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().moneySend).toBeUndefined();
    expect((await offersOf("A"))[0]).toMatchObject({ offerId: auto.offerId, driverBonus: money(700) });
    expect(await offersOf("B")).toHaveLength(0);
  });
});

/**
 * Owner rule 16 (checker 2026-11-02): Add money's immediate send follows the zone's own dispatch settings — drivers of
 * the zone first (a closer neighbour-zone driver never beats a free in-zone one), a same-country neighbour only when no
 * in-zone driver is free, and never beyond limits.maxPickupKm. SE and FR.
 */
describe.each(Object.entries(CASES))("admin money follows the zone's start/order limits (%s)", (name, c) => {
  const money = (amountMinor: number) => ({ amountMinor, currency: c.currency });
  const nb = `NB-${name}`;
  const base = () => (name === "FR" ? inParis(sample("dispatch_document")) : sample("dispatch_document"));
  const setDoc = (doc: unknown) => database.db.updateTable("config_live").set({ document: JSON.stringify(doc) }).where("doc", "=", "dispatch").where("zone_id", "=", c.zone).execute();
  const box = name === "FR" ? { south: 48.7, west: 2.2, north: 49.0, east: 2.5 } : { south: 59.2, west: 17.9, north: 59.5, east: 18.3 };

  beforeAll(async () => {
    await database.db.deleteFrom("zones").where("zone_id", "=", nb).execute();
    await database.db
      .insertInto("zones")
      .values({ zone_id: nb, name: "Neighbour", country: name, currency: c.currency, time_zone: name === "FR" ? "Europe/Paris" : "Europe/Stockholm", kind: "operating", center_lat: (box.south + box.north) / 2, center_lng: (box.west + box.east) / 2, open: false, ...box, names: JSON.stringify({ sv: "Granne", fr: "Voisin", en: "Neighbour" }), polygon: JSON.stringify([[box.south, box.west], [box.north, box.west], [box.north, box.east], [box.south, box.east]]) } as never)
      .execute();
  });
  afterAll(async () => {
    await database.db.updateTable("drivers").set({ zone_ids: ["Z001", "FR-PC"] }).where("driver_id", "in", [drivers.A.id, drivers.B.id]).execute();
    await setDoc(base());
    await database.db.deleteFrom("zones").where("zone_id", "=", nb).execute();
  });

  /** A (nearest) books the auto offer; then A is moved to the neighbour zone and the zone turns neighbours on. */
  async function withNeighbourA() {
    await database.db.updateTable("drivers").set({ zone_ids: ["Z001", "FR-PC"] }).where("driver_id", "in", [drivers.A.id, drivers.B.id]).execute();
    await setDoc(base());
    const { tripId, auto } = await bookWithAutoOffer(c);
    await database.db.updateTable("offers").set({ status: "withdrawn" }).where("offer_id", "=", auto.offerId).execute();
    await database.db.updateTable("drivers").set({ zone_ids: [nb] }).where("driver_id", "=", drivers.A.id).execute();
    await setDoc({ ...base(), neighbours: { on: true, zoneIds: [nb], afterStep: 1 } });
    return tripId;
  }

  it("a closer neighbour-zone driver vs a farther free in-zone driver: the in-zone driver gets the Exclusive", async () => {
    const tripId = await withNeighbourA();
    const res = await bonusPost(tripId, { amount: money(700), applyTo: "exclusive" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().moneySend).toMatchObject({ exclusiveTo: drivers.B.id, radarTo: [] });
    expect(await offersOf("A")).toHaveLength(0);
  });

  it("Radar list: in-zone drivers only while one is free", async () => {
    const tripId = await withNeighbourA();
    const res = await bonusPost(tripId, { amount: money(700), applyTo: "radar" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().moneySend).toMatchObject({ exclusiveTo: null, radarTo: [drivers.B.id] });
  });

  it("no in-zone driver free: the neighbour-zone driver gets the Exclusive", async () => {
    const tripId = await withNeighbourA();
    await database.db.updateTable("drivers").set({ online_status: "offline" }).where("driver_id", "=", drivers.B.id).execute();
    const res = await bonusPost(tripId, { amount: money(700), applyTo: "exclusive" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().moneySend).toMatchObject({ exclusiveTo: drivers.A.id, radarTo: [] });
  });

  it("a driver beyond limits.maxPickupKm is not offered", async () => {
    await database.db.updateTable("drivers").set({ zone_ids: ["Z001", "FR-PC"] }).where("driver_id", "in", [drivers.A.id, drivers.B.id]).execute();
    await setDoc(base());
    const { tripId, auto } = await bookWithAutoOffer(c);
    await database.db.updateTable("offers").set({ status: "withdrawn" }).where("offer_id", "=", auto.offerId).execute();
    await database.db.updateTable("drivers").set({ online_status: "offline" }).where("driver_id", "=", drivers.A.id).execute();
    await setDoc({ ...base(), limits: { maxPickupKm: 0.2 } });
    const res = await bonusPost(tripId, { amount: money(700), applyTo: "both" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().moneySend).toMatchObject({ exclusiveTo: null, radarTo: [], skipped: { expired: 0, busy: 0, far: 1 }, reachKm: 0.2 });
    expect(await offersOf("B")).toHaveLength(0);
  });
});
