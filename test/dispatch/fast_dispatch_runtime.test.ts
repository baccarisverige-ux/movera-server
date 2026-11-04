import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { cacheLiveDocuments, forgetLiveDocuments, liveDocument } from "../../src/config/service.js";
import { dispatchHandlers } from "../../src/dispatch/runtime.js";
import { seedDriver } from "../../src/drivers/service.js";
import { TimerWorker } from "../../src/jobs/timers.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { call, NORRMALM, SODERMALM, signIn, testWorld } from "../support/world.js";

/** Job 1 "Fast dispatch" (fix plan R9, R10, L17, stress M1, M5): each test fails on main before the job. */
let database: TestDatabase;
let app: FastifyInstance;
let worker: TimerWorker;
const clock = { now: new Date("2026-10-24T12:00:00Z") };
const advance = async (seconds: number) => {
  clock.now = new Date(clock.now.getTime() + seconds * 1000);
  await worker.runDue();
};
const sample = (name: string) => JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/${name}.json`, "utf8"));
const SPOTS = { A: { lat: 59.3335, lng: 18.0655 }, B: { lat: 59.336, lng: 18.07 }, C: { lat: 59.34, lng: 18.075 } };
const drivers: Record<"A" | "B" | "C", { id: string; headers: Record<string, string> }> = {} as never;
let rider: Record<string, string>;
let admin: Record<string, string>;

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  await database.db.insertInto("config_live").values({ doc: "dispatch", zone_id: "Z001", version: 1, document: JSON.stringify(sample("dispatch_document")), published_at: clock.now, published_by: null }).execute();
  // The app document says 30 s for a hand-sent offer; the zone's dispatch rules say 15 s for Exclusive.
  await database.db.insertInto("config_live").values({ doc: "driver_app_config", zone_id: "Z001", version: 1, document: JSON.stringify(sample("driver_app_config")), published_at: clock.now, published_by: null }).execute();
  worker = new TimerWorker(database.db, { handlers: dispatchHandlers, logger: { warn: () => undefined, error: (d, m) => console.error(m, d) }, clock: () => clock.now });
  const phones = { A: TEST_PHONES[1]!, B: TEST_PHONES[2]!, C: TEST_PHONES[3]! };
  for (const key of ["A", "B", "C"] as const) {
    const made = await database.db.transaction().execute((trx) =>
      seedDriver(trx, { phone: phones[key], firstName: `Driver ${key}`, make: "Volvo", model: "V60", year: 2021, color: "Black", plate: `TSF00${key}`, categoryIds: ["economy"], zoneIds: ["Z001", "Z002"] }, clock.now),
    );
    drivers[key] = { id: made.driverId, headers: {} };
  }
});
afterAll(async () => {
  cacheLiveDocuments(0);
  await app.close();
  await database.drop();
});

beforeEach(async () => {
  clock.now = new Date(clock.now.getTime() + 3600_000);
  rider = (await signIn(app, TEST_PHONES[0]!, "rider")).headers;
  for (const key of ["A", "B", "C"] as const) {
    drivers[key].headers = (await signIn(app, ({ A: TEST_PHONES[1], B: TEST_PHONES[2], C: TEST_PHONES[3] } as const)[key]!, "driver")).headers;
    await database.db.updateTable("drivers").set({ online_status: "online", last_free_at: clock.now }).where("driver_id", "=", drivers[key].id).execute();
    await call(app, "POST", "/driver/location", drivers[key].headers, { fixes: [{ ...SPOTS[key], accuracy: 5, measuredAt: clock.now.toISOString() }] });
  }
  await database.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("status", "not in", ["completed", "cancelled_by_admin", "cancelled_by_rider", "expired"]).execute();
  await database.db.deleteFrom("timers").execute();
  await database.db.deleteFrom("offers").execute();
});

async function book(): Promise<string> {
  const quote = (await call(app, "POST", "/quotes", rider, { pickup: NORRMALM, dropoff: SODERMALM, stops: [], categoryIds: ["economy"] })).json().quotes[0];
  const trip = (await call(app, "POST", "/trips", rider, { quoteId: quote.quoteId, categoryId: "economy", pickup: NORRMALM, dropoff: SODERMALM, stops: [], kind: "live", paymentMethod: "cash" })).json();
  return trip.tripId as string;
}
const offersOf = (tripId: string) => database.db.selectFrom("offers").select(["driver_id", "kind", "status", "sent_at", "expires_at"]).where("trip_id", "=", tripId).orderBy("sent_at").execute();

describe("fast dispatch — Job 1", () => {
  it("R10: a driver holding a booked ride soon gets no clashing live ride (the next driver gets it)", async () => {
    // A (closest) holds a booked ride 10 minutes from now.
    const held = await book();
    await database.db.updateTable("trips").set({ kind: "scheduled", status: "accepted", driver_id: drivers.A.id, scheduled_at: new Date(clock.now.getTime() + 10 * 60_000), reservation: JSON.stringify({ held: true }) }).where("trip_id", "=", held).execute();
    await database.db.deleteFrom("timers").execute();
    const tripId = await book();
    await worker.runDue();
    const offers = await offersOf(tripId);
    expect(offers.length).toBeGreaterThan(0);
    expect(offers.map((o) => o.driver_id)).not.toContain(drivers.A.id);
  });

  it("R9: a booked ride whose search began before pickup time gets Exclusive offers only once the time has passed", async () => {
    const tripId = await book();
    // A booked ride whose search runs with the zone's normal rules (Exclusive + Radar)…
    await database.db.updateTable("trips").set({ kind: "scheduled", scheduled_at: new Date(clock.now.getTime() + 30_000) }).where("trip_id", "=", tripId).execute();
    const doc = sample("dispatch_document");
    await database.db.updateTable("searches").set({ document: JSON.stringify({ ...doc, start: { mode: "radar" }, radar: { ...doc.radar, on: true }, exclusive: { ...doc.exclusive, on: true } }), state: JSON.stringify({ cur: "radar", step: 0, tried: 0, asked: [], switched: [], repeat: false }) }).where("trip_id", "=", tripId).execute();
    // …and its first round runs after the pickup time.
    clock.now = new Date(clock.now.getTime() + 60_000);
    await worker.runDue();
    for (let i = 0; i < 6; i++) await advance(16);
    const kinds = new Set((await offersOf(tripId)).map((o) => o.kind));
    expect([...kinds]).toEqual(["exclusive"]);
  });

  it("L17: an admin-sent offer runs on the same seconds as the automatic Exclusive (dispatch exclusive.seconds)", async () => {
    await database.db.insertInto("dispatch_controls").values({ zone_id: "Z001", paused: true, mode: null, by: null, at: clock.now, version: 1 }).onConflict((c) => c.column("zone_id").doUpdateSet({ paused: true })).execute();
    admin = (await adminSession(app, database.db, "super", { now: clock.now })).headers;
    try {
    const tripId = await book();
    await worker.runDue();
    const trip = (await call(app, "GET", `/admin/trips/${tripId}`, admin)).json();
    const res = await call(app, "POST", `/admin/trips/${tripId}/assign`, admin, { expectedVersion: trip.version ?? trip.trip?.version, driverId: drivers.B.id });
    expect(res.statusCode, res.body).toBeLessThan(300);
    const [offer] = (await offersOf(tripId)).filter((o) => o.driver_id === drivers.B.id);
    expect(offer!.expires_at.getTime() - offer!.sent_at.getTime()).toBe(sample("dispatch_document").exclusive.seconds * 1000);
    } finally {
      await database.db.updateTable("dispatch_controls").set({ paused: false }).where("zone_id", "=", "Z001").execute();
    }
  });

  it("M1: an accept naming an older version of a still-open offer (money refreshed meanwhile) goes through", async () => {
    const tripId = await book();
    await worker.runDue();
    const [offer] = (await call(app, "GET", "/driver/offers", drivers.A.headers)).json().items;
    expect(offer.tripId).toBe(tripId);
    await database.db.updateTable("offers").set({ version: offer.version + 1 }).where("trip_id", "=", tripId).where("driver_id", "=", drivers.A.id).execute();
    const accepted = await call(app, "POST", `/offers/${offer.offerId}/accept`, drivers.A.headers, { expectedVersion: offer.version });
    expect(accepted.statusCode, accepted.body).toBe(200);
  });

  it("M5: settings are cached and a publish empties the cache at once", async () => {
    cacheLiveDocuments(60_000);
    try {
      const first = await liveDocument(database.db, "dispatch", "Z001");
      await database.db.updateTable("config_live").set({ version: 99 }).where("doc", "=", "dispatch").where("zone_id", "=", "Z001").execute();
      expect((await liveDocument(database.db, "dispatch", "Z001"))?.version).toBe(first?.version); // from memory
      forgetLiveDocuments(); // what a config_published (any instance) or this instance's publish does
      expect((await liveDocument(database.db, "dispatch", "Z001"))?.version).toBe(99);
    } finally {
      await database.db.updateTable("config_live").set({ version: 1 }).where("doc", "=", "dispatch").where("zone_id", "=", "Z001").execute();
      cacheLiveDocuments(0);
    }
  });
});
