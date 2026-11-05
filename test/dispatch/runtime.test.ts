import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { dispatchHandlers } from "../../src/dispatch/runtime.js";
import { seedDriver } from "../../src/drivers/service.js";
import { TimerWorker } from "../../src/jobs/timers.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { call, NORRMALM, SODERMALM, signIn, testWorld } from "../support/world.js";

let database: TestDatabase;
let app: FastifyInstance;
let worker: TimerWorker;
const clock = { now: new Date("2026-10-24T12:00:00Z") };
const advance = async (seconds: number) => {
  clock.now = new Date(clock.now.getTime() + seconds * 1000);
  await worker.runDue();
};
const sample = (name: string) => JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/${name}.json`, "utf8"));

// Three drivers near Sergels torg (Norrmalm): A closest, then B, then C.
const SPOTS = { A: { lat: 59.3335, lng: 18.0655 }, B: { lat: 59.3360, lng: 18.0700 }, C: { lat: 59.3400, lng: 18.0750 } };
const drivers: Record<"A" | "B" | "C", { id: string; headers: Record<string, string> }> = {} as never;
let rider: Record<string, string>;

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  await database.db.insertInto("config_live").values({ doc: "dispatch", zone_id: "Z001", version: 1, document: JSON.stringify(sample("dispatch_document")), published_at: clock.now, published_by: null }).execute();
  worker = new TimerWorker(database.db, { handlers: dispatchHandlers, logger: { warn: () => undefined, error: (d, m) => console.error(m, d) }, clock: () => clock.now });
  const phones = { A: TEST_PHONES[1]!, B: TEST_PHONES[2]!, C: TEST_PHONES[3]! };
  for (const key of ["A", "B", "C"] as const) {
    const made = await database.db.transaction().execute((trx) =>
      seedDriver(trx, { phone: phones[key], firstName: `Driver ${key}`, make: "Volvo", model: "V60", year: 2021, color: "Black", plate: `TST00${key}`, categoryIds: ["economy"], zoneIds: ["Z001", "Z002"] }, clock.now),
    );
    drivers[key] = { id: made.driverId, headers: {} };
  }
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

async function everyoneOnline() {
  clock.now = new Date(clock.now.getTime() + 3600_000);
  rider = (await signIn(app, TEST_PHONES[0]!, "rider")).headers;
  for (const key of ["A", "B", "C"] as const) {
    drivers[key].headers = (await signIn(app, ({ A: TEST_PHONES[1], B: TEST_PHONES[2], C: TEST_PHONES[3] } as const)[key]!, "driver")).headers;
    await database.db.updateTable("drivers").set({ online_status: "online", last_free_at: clock.now }).where("driver_id", "=", drivers[key].id).execute();
    await call(app, "POST", "/driver/location", drivers[key].headers, { fixes: [{ ...SPOTS[key], accuracy: 5, measuredAt: clock.now.toISOString() }] });
  }
}

async function book() {
  await database.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("status", "not in", ["completed", "cancelled_by_admin", "cancelled_by_rider", "expired"]).execute();
  await database.db.deleteFrom("timers").execute();
  // Each test starts with no offer history, so acceptance rates (part of the score) do not carry over.
  await database.db.deleteFrom("offers").execute();
  const quote = (await call(app, "POST", "/quotes", rider, { pickup: NORRMALM, dropoff: SODERMALM, stops: [], categoryIds: ["economy"] })).json().quotes[0];
  const trip = (await call(app, "POST", "/trips", rider, { quoteId: quote.quoteId, categoryId: "economy", pickup: NORRMALM, dropoff: SODERMALM, stops: [], kind: "live", paymentMethod: "cash" })).json();
  await worker.runDue();
  return trip.tripId as string;
}
const openOffers = async (key: "A" | "B" | "C") => (await call(app, "GET", "/driver/offers", drivers[key].headers)).json().items;
const tripOf = async (tripId: string, headers = rider) => (await call(app, "GET", `/trips/${tripId}`, headers)).json();

beforeEach(async () => {
  await everyoneOnline();
});

describe("automatic dispatch at run time", () => {
  it("a calm zone offers Exclusive to the best driver first, then the next one when the 15 s run out", async () => {
    const tripId = await book();
    expect((await tripOf(tripId)).status).toBe("offered");
    const [first] = await openOffers("A");
    expect(first).toMatchObject({ tripId, kind: "exclusive", status: "open", fare: { amountMinor: 21700 }, driverEarnings: { amountMinor: 15760 } });
    // v0.18.6 (owner G4-E7 "Remove short line explain"): no "why you got this trip" reason on the offer any more.
    expect(first).not.toHaveProperty("reasonCode");
    expect(new Date(first.expiresAt).getTime() - clock.now.getTime()).toBe(15_000);
    expect(await openOffers("B")).toEqual([]);

    await advance(15);
    expect(await openOffers("A")).toEqual([]);
    const [second] = await openOffers("B");
    // Ranked again before every offer: A missed one, so its acceptance fell and B now ranks first.
    expect(second).toMatchObject({ tripId, kind: "exclusive" });
    expect(second).not.toHaveProperty("reasonCode");
    const events = await database.db.selectFrom("offer_events").select(["kind", "sequence"]).where("driver_id", "=", drivers.A.id).orderBy("sequence").execute();
    expect(events.slice(-2).map((e) => e.kind)).toEqual(["offer_created", "offer_withdrawn"]);
  });

  it("a decline moves on at once; an accept assigns the driver and the rider sees the car", async () => {
    const tripId = await book();
    const [offerA] = await openOffers("A");
    const declined = await call(app, "POST", `/offers/${offerA.offerId}/decline`, drivers.A.headers, { expectedVersion: offerA.version, reasonCode: "too_far" });
    expect(declined.json()).toMatchObject({ status: "declined" });
    await worker.runDue();
    const [offerB] = await openOffers("B");
    expect(offerB).toBeDefined();
    const accepted = await call(app, "POST", `/offers/${offerB.offerId}/accept`, drivers.B.headers, { expectedVersion: offerB.version });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ tripId, status: "accepted", driverId: drivers.B.id, driverEarnings: { amountMinor: 15760 } });
    const seen = await tripOf(tripId);
    expect(seen).toMatchObject({ status: "accepted", driverId: drivers.B.id, driver: { driverId: drivers.B.id, firstName: "Driver B", vehicle: { make: "Volvo", model: "V60", plate: "TST00B" } } });
    expect(seen.acceptedAt).toBe(clock.now.toISOString());
    expect(seen).not.toHaveProperty("driverEarnings");
    expect((await call(app, "GET", "/driver/profile", drivers.B.headers)).json()).toMatchObject({ onlineStatus: "on_trip", activeTripId: tripId });
    // No more rounds for this trip; only the ETA tick (v0.18.7, trips/eta.ts) stays with the trip.
    await advance(60);
    expect((await tripOf(tripId)).status).toBe("accepted");
    expect((await database.db.selectFrom("timers").selectAll().where("ref_id", "like", `${tripId}%`).execute()).map((t) => t.kind)).toEqual(["trip_eta"]);
  });

  it("a late or second accept loses: 409 with the offer", async () => {
    const tripId = await book();
    const [offerA] = await openOffers("A");
    await advance(15);
    const late = await call(app, "POST", `/offers/${offerA.offerId}/accept`, drivers.A.headers, { expectedVersion: offerA.version + 1 });
    expect(late.statusCode).toBe(409);
    // FIX JOB 7 (L24 re-test): a closed offer answers offer_<status> with the offer projection.
    expect(late.json().reason).toMatch(/^offer_[a-z_]+$/);
    const [offerB] = await openOffers("B");
    const stale = await call(app, "POST", `/offers/${offerB.offerId}/accept`, drivers.B.headers, { expectedVersion: 99 });
    expect(stale.json()).toMatchObject({ code: "version_mismatch" });
    expect((await tripOf(tripId)).status).toBe("offered");
  });

  it("nobody answers: Exclusive to each in turn, then Radar to everyone; the rider sees the waiting steps; at 8 min the trip expires", async () => {
    const tripId = await book();
    for (let i = 0; i < 12; i++) await advance(15);
    const kinds = await database.db.selectFrom("offers").select(["kind", "driver_id", "sent_at"]).where("trip_id", "=", tripId).orderBy("sent_at").orderBy("offer_id").execute();
    expect(kinds.slice(0, 3).map((o) => [o.kind, o.driver_id])).toEqual([["exclusive", drivers.A.id], ["exclusive", drivers.B.id], ["exclusive", drivers.C.id]]);
    expect(kinds.some((o) => o.kind === "radar")).toBe(true);
    await advance(0);
    clock.now = new Date(clock.now.getTime() + 0);
    for (let t = 0; t < 40; t++) await advance(10);
    const steps = await database.db.selectFrom("searches").select(["fired"]).where("trip_id", "=", tripId).executeTakeFirstOrThrow();
    expect(steps.fired).toEqual(expect.arrayContaining(["w3", "w4"]));
    for (let t = 0; t < 10; t++) await advance(10);
    const done = await tripOf(tripId);
    expect(done.status).toBe("expired");
    expect(await openOffers("A")).toEqual([]);
  });

  it("Keep waiting? wait adds 3 minutes; stop is a free cancel", async () => {
    const tripId = await book();
    for (let t = 0; t < 30; t++) await advance(10);
    const asked = await tripOf(tripId);
    expect(asked.searchStep).toMatchObject({ id: "w4", kind: "keep_waiting", extraMin: 3 });
    const wait = await call(app, "POST", `/trips/${tripId}/keep-waiting`, rider, { answer: "wait" });
    expect(wait.statusCode).toBe(200);
    const again = await call(app, "POST", `/trips/${tripId}/keep-waiting`, rider, { answer: "wait" });
    expect(again.json()).toMatchObject({ code: "invalid_transition" });
    const search = await database.db.selectFrom("searches").select(["started_at", "end_at"]).where("trip_id", "=", tripId).executeTakeFirstOrThrow();
    expect((search.end_at.getTime() - search.started_at.getTime()) / 1000).toBe(660);
    for (let t = 0; t < 21; t++) await advance(10);
    expect(["searching", "offered"]).toContain((await tripOf(tripId)).status);

    const second = await book();
    for (let t = 0; t < 30; t++) await advance(10);
    const stop = await call(app, "POST", `/trips/${second}/keep-waiting`, rider, { answer: "stop" });
    expect(stop.json()).toMatchObject({ status: "cancelled_by_rider", cancellation: { reasonCode: "wait_too_long", fee: null } });
    expect(await openOffers("A")).toEqual([]);
  });

  it("a paused zone sends no offers until resumed; an ops admin forces a mode at once (v0.7.2, one admin is enough)", async () => {
    const owner = await adminSession(app, database.db, "super", { now: clock.now });
    const pause = await call(app, "PUT", "/admin/zones/Z001/dispatch-control", owner.headers, { expectedVersion: 0, paused: true, mode: null });
    expect(pause.statusCode).toBe(200);
    expect(pause.json()).toMatchObject({ zoneId: "Z001", paused: true, mode: null, version: 1 });
    const tripId = await book();
    await advance(30);
    expect(await database.db.selectFrom("offers").selectAll().where("trip_id", "=", tripId).execute()).toEqual([]);
    const ops = await adminSession(app, database.db, "ops", { now: clock.now });
    const resume = await call(app, "PUT", "/admin/zones/Z001/dispatch-control", ops.headers, { expectedVersion: 1, paused: false, mode: null });
    expect(resume.statusCode).toBe(200);
    await advance(15);
    expect((await openOffers("A")).length).toBe(1);
    const force = await call(app, "PUT", "/admin/zones/Z001/dispatch-control", ops.headers, { expectedVersion: 2, paused: false, mode: "radar" });
    expect(force.statusCode, force.body).toBe(200);
    expect(force.json()).toMatchObject({ zoneId: "Z001", paused: false, mode: "radar", version: 3 });
    // Contract v0.7.2: one admin is enough, a non-Super admin pauses at once too (no 202 second-admin wait).
    const opsPause = await call(app, "PUT", "/admin/zones/Z001/dispatch-control", ops.headers, { expectedVersion: 3, paused: true, mode: null });
    expect(opsPause.statusCode, opsPause.body).toBe(200);
    expect(opsPause.json()).toMatchObject({ paused: true, version: 4 });
  });
});

describe("v0.18.9 dispatch start: both at the same time (owner 2026-11-01)", () => {
  it("Exclusive to the best driver and Radar to the next ones at once; the first accept wins and the others are withdrawn", async () => {
    // The test above leaves the zone paused: back to the rules.
    await database.db.deleteFrom("dispatch_controls").where("zone_id", "=", "Z001").execute();
    const both = { ...sample("dispatch_document"), start: { mode: "both", nearKm: 2 } };
    await database.db.updateTable("config_live").set({ document: JSON.stringify(both) }).where("doc", "=", "dispatch").where("zone_id", "=", "Z001").execute();
    try {
      const tripId = await book();
      // Ranked by score (the earlier tests changed acceptance): one Exclusive to the best, Radar to the two others.
      const all = { A: await openOffers("A"), B: await openOffers("B"), C: await openOffers("C") };
      const keys = ["A", "B", "C"] as const;
      const exKey = keys.find((k) => all[k][0]?.kind === "exclusive")!;
      expect(exKey).toBeDefined();
      const radarKeys = keys.filter((k) => k !== exKey);
      for (const k of keys) expect(all[k]).toHaveLength(1);
      const [rk, other] = radarKeys as ["A" | "B" | "C", "A" | "B" | "C"];
      const rb = all[rk][0];
      expect(rb).toMatchObject({ tripId, kind: "radar" });
      expect(all[other][0]).toMatchObject({ tripId, kind: "radar", groupId: rb.groupId });
      const accepted = await call(app, "POST", `/offers/${rb.offerId}/accept`, drivers[rk].headers, { expectedVersion: rb.version });
      expect(accepted.statusCode).toBe(200);
      expect(await openOffers(exKey)).toEqual([]);
      expect(await openOffers(other)).toEqual([]);
      const statuses = await database.db.selectFrom("offers").select(["driver_id", "status"]).where("trip_id", "=", tripId).execute();
      expect(statuses.find((o) => o.driver_id === drivers[exKey].id)?.status).toBe("claimed_elsewhere");
      expect(statuses.find((o) => o.driver_id === drivers[other].id)?.status).toBe("claimed_elsewhere");
    } finally {
      await database.db.updateTable("config_live").set({ document: JSON.stringify(sample("dispatch_document")) }).where("doc", "=", "dispatch").where("zone_id", "=", "Z001").execute();
    }
  });

  it("both: when the Exclusive driver accepts, the Radar offers are withdrawn (claimed_elsewhere)", async () => {
    await database.db.deleteFrom("dispatch_controls").where("zone_id", "=", "Z001").execute();
    const both = { ...sample("dispatch_document"), start: { mode: "both", nearKm: 2 } };
    await database.db.updateTable("config_live").set({ document: JSON.stringify(both) }).where("doc", "=", "dispatch").where("zone_id", "=", "Z001").execute();
    try {
      const tripId = await book();
      const keys = ["A", "B", "C"] as const;
      const all = { A: await openOffers("A"), B: await openOffers("B"), C: await openOffers("C") };
      const exKey = keys.find((k) => all[k][0]?.kind === "exclusive")!;
      expect(exKey).toBeDefined();
      const radarKeys = keys.filter((k) => k !== exKey);
      for (const k of radarKeys) expect(all[k][0]).toMatchObject({ tripId, kind: "radar" });
      const ex = all[exKey][0];
      const accepted = await call(app, "POST", `/offers/${ex.offerId}/accept`, drivers[exKey].headers, { expectedVersion: ex.version });
      expect(accepted.statusCode).toBe(200);
      for (const k of radarKeys) expect(await openOffers(k)).toEqual([]);
      const statuses = await database.db.selectFrom("offers").select(["driver_id", "status"]).where("trip_id", "=", tripId).execute();
      for (const k of radarKeys) expect(statuses.find((o) => o.driver_id === drivers[k].id)?.status).toBe("claimed_elsewhere");
      expect((await tripOf(tripId)).status).not.toBe("searching");
    } finally {
      await database.db.updateTable("config_live").set({ document: JSON.stringify(sample("dispatch_document")) }).where("doc", "=", "dispatch").where("zone_id", "=", "Z001").execute();
    }
  });
});

describe("v0.18.9 neighbour zones stay inside one country and currency", () => {
  it.each([
    ["SE", "SEK", true],
    ["FR", "EUR", false],
  ])("a SE zone borrows a %s/%s neighbour's driver: %s", async (country, currency, offered) => {
    await database.db.deleteFrom("dispatch_controls").where("zone_id", "=", "Z001").execute();
    await database.db.deleteFrom("zones").where("zone_id", "=", "ZNB").execute();
    await database.db
      .insertInto("zones")
      .values({ zone_id: "ZNB", name: "Neighbour", country, currency, time_zone: country === "FR" ? "Europe/Paris" : "Europe/Stockholm", kind: "operating", center_lat: 59.33, center_lng: 18.06, open: false, south: 59.2, west: 17.9, north: 59.5, east: 18.3, names: JSON.stringify({ sv: "Granne", fr: "Voisin", en: "Neighbour" }), polygon: JSON.stringify([[59.2, 17.9], [59.5, 17.9], [59.5, 18.3], [59.2, 18.3]]) } as never)
      .execute();
    await database.db.updateTable("drivers").set({ zone_ids: ["ZNB"] }).where("driver_id", "=", drivers.C.id).execute();
    const doc = { ...sample("dispatch_document"), start: { mode: "radar" }, neighbours: { on: true, zoneIds: ["ZNB"], afterStep: 1 } };
    await database.db.updateTable("config_live").set({ document: JSON.stringify(doc) }).where("doc", "=", "dispatch").where("zone_id", "=", "Z001").execute();
    try {
      const tripId = await book();
      expect((await openOffers("A"))[0]).toMatchObject({ tripId, kind: "radar" });
      expect((await openOffers("C")).length > 0).toBe(offered);
    } finally {
      await database.db.updateTable("drivers").set({ zone_ids: ["Z001", "Z002"] }).where("driver_id", "=", drivers.C.id).execute();
      await database.db.updateTable("config_live").set({ document: JSON.stringify(sample("dispatch_document")) }).where("doc", "=", "dispatch").where("zone_id", "=", "Z001").execute();
      await database.db.deleteFrom("zones").where("zone_id", "=", "ZNB").execute();
    }
  });
});
