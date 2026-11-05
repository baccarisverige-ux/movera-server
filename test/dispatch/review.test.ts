import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { dispatchHandlers } from "../../src/dispatch/runtime.js";
import { seedDriver } from "../../src/drivers/service.js";
import { TimerWorker } from "../../src/jobs/timers.js";
import { lockTrip } from "../../src/db/tripLog.js";
import { riderCancel } from "../../src/trips/service.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { call, NORRMALM, SODERMALM, signIn, testWorld } from "../support/world.js";

let database: TestDatabase;
let app: FastifyInstance;
const warnings: string[] = [];
const logger = { warn: (d: object) => void warnings.push(JSON.stringify(d)), error: (d: object) => void warnings.push(JSON.stringify(d)) };
let worker: TimerWorker;
let worker2: TimerWorker;
const clock = { now: new Date("2026-10-24T12:00:00Z") };
const advance = async (seconds: number) => {
  clock.now = new Date(clock.now.getTime() + seconds * 1000);
  await worker.runDue();
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sample = (name: string) => JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/${name}.json`, "utf8"));
const SPOTS = { A: { lat: 59.3335, lng: 18.0655 }, B: { lat: 59.336, lng: 18.07 }, C: { lat: 59.34, lng: 18.075 } };
const PH = { A: TEST_PHONES[1]!, B: TEST_PHONES[2]!, C: TEST_PHONES[3]! };
type K = "A" | "B" | "C";
const drivers: Record<K, { id: string; headers: Record<string, string> }> = {} as never;
let rider: Record<string, string>;
let rider2: Record<string, string>;

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  await database.db.insertInto("config_live").values({ doc: "dispatch", zone_id: "Z001", version: 1, document: JSON.stringify(sample("dispatch_document")), published_at: clock.now, published_by: null }).execute();
  worker = new TimerWorker(database.db, { handlers: dispatchHandlers, logger, clock: () => clock.now });
  worker2 = new TimerWorker(database.db, { handlers: dispatchHandlers, logger, clock: () => clock.now });
  for (const key of ["A", "B", "C"] as const) {
    const made = await database.db.transaction().execute((trx) =>
      seedDriver(trx, { phone: PH[key], firstName: `Driver ${key}`, make: "Volvo", model: "V60", year: 2021, color: "Black", plate: `TST00${key}`, categoryIds: ["economy"], zoneIds: ["Z001", "Z002"] }, clock.now),
    );
    drivers[key] = { id: made.driverId, headers: {} };
  }
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

beforeEach(async () => {
  warnings.length = 0;
  clock.now = new Date(clock.now.getTime() + 3600_000);
  await database.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("status", "not in", ["completed", "cancelled_by_admin", "cancelled_by_rider", "expired"]).execute();
  await database.db.deleteFrom("timers").execute();
  await database.db.deleteFrom("offers").execute();
  await database.db.deleteFrom("dispatch_controls").execute();
  rider = (await signIn(app, TEST_PHONES[0]!, "rider")).headers;
  rider2 = (await signIn(app, TEST_PHONES[4]!, "rider")).headers;
  for (const key of ["A", "B", "C"] as const) {
    drivers[key].headers = (await signIn(app, PH[key], "driver")).headers;
    await database.db.updateTable("drivers").set({ online_status: "online", last_free_at: clock.now }).where("driver_id", "=", drivers[key].id).execute();
    await call(app, "POST", "/driver/location", drivers[key].headers, { fixes: [{ ...SPOTS[key], accuracy: 5, measuredAt: clock.now.toISOString() }] });
  }
});

async function create(who: Record<string, string>) {
  const quote = (await call(app, "POST", "/quotes", who, { pickup: NORRMALM, dropoff: SODERMALM, stops: [], categoryIds: ["economy"] })).json().quotes[0];
  const trip = (await call(app, "POST", "/trips", who, { quoteId: quote.quoteId, categoryId: "economy", pickup: NORRMALM, dropoff: SODERMALM, stops: [], kind: "live", paymentMethod: "cash" })).json();
  return trip.tripId as string;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped JSON from the API in a test helper
const openOffers = async (key: K) => (await call(app, "GET", "/driver/offers", drivers[key].headers)).json().items as Array<Record<string, any>>;
const forceRadar = () => database.db.insertInto("dispatch_controls").values({ zone_id: "Z001", paused: false, mode: "radar", by: null, at: clock.now, version: 1 }).execute();
const offline = (key: K) => database.db.updateTable("drivers").set({ online_status: "offline" }).where("driver_id", "=", drivers[key].id).execute();

// Regression tests from the dispatch review (each was a failing proof before the fix).
describe("dispatch runtime review", () => {
  it("H1, changed by owner answer 2026-11-05 (fix job 5): a driver with a rider, almost at the drop-off, gets only an Exclusive, and accepting it queues it", async () => {
    // A is in_trip on trip0, dropping off right next to the new pickup.
    const trip0 = await create(rider2);
    await database.db.deleteFrom("timers").execute();
    await database.db.deleteFrom("offers").execute();
    await database.db.updateTable("trips").set({ status: "in_trip", driver_id: drivers.A.id, dropoff: JSON.stringify({ lat: 59.3329, lng: 18.065 }) }).where("trip_id", "=", trip0).execute();
    await database.db.updateTable("drivers").set({ online_status: "on_trip" }).where("driver_id", "=", drivers.A.id).execute();
    await offline("B");
    await offline("C");
    const trip1 = await create(rider);
    await worker.runDue();
    const offers = await openOffers("A");
    expect(offers.map((o) => o.kind)).toEqual(["exclusive"]);
    const took = await call(app, "POST", `/offers/${offers[0]!.offerId}/accept`, drivers.A.headers, { expectedVersion: offers[0]!.version });
    expect(took.statusCode, took.body).toBe(200);
    const row = await database.db.selectFrom("trips").select(["status", "next_after_trip_id"]).where("trip_id", "=", trip1).executeTakeFirstOrThrow();
    expect(row).toEqual({ status: "accepted", next_after_trip_id: trip0 });
  });

  it("H2: after accepting one Radar trip the driver's other offers are withdrawn, and accepting one is 409", async () => {
    await forceRadar();
    const trip1 = await create(rider);
    const trip2 = await create(rider2);
    await worker.runDue();
    const offersA = await openOffers("A");
    const o1 = offersA.find((o) => o.tripId === trip1)!;
    const o2 = offersA.find((o) => o.tripId === trip2)!;
    expect(o1.kind).toBe("radar");
    expect((await call(app, "POST", `/offers/${o1.offerId}/accept`, drivers.A.headers, { expectedVersion: o1.version })).statusCode).toBe(200);
    // Even before the withdraw job runs, the second accept is refused.
    const second = await call(app, "POST", `/offers/${o2.offerId}/accept`, drivers.A.headers, { expectedVersion: o2.version });
    await worker.runDue();
    const stillOpen = (await openOffers("A")).map((o) => o.tripId);
    expect({ stillOpen, second: second.statusCode }).toEqual({ stillOpen: [], second: 409 });
    // FIX JOB 7 (L24 re-test, contract.json#smallFixes.retested): the refusal names its reason and carries the offer.
    expect(second.json().reason).toMatch(/^(driver_on_trip|offer_[a-z_]+)$/);
  });

  it("H3: two drivers accepting two different Radar trips at once do not deadlock (feed rows locked in id order)", async () => {
    await forceRadar();
    await offline("C");
    const trip1 = await create(rider);
    const trip2 = await create(rider2);
    await worker.runDue();
    const a1 = (await openOffers("A")).find((o) => o.tripId === trip1)!;
    const b2 = (await openOffers("B")).find((o) => o.tripId === trip2)!;
    const b1 = (await openOffers("B")).find((o) => o.tripId === trip1)!;
    const a2 = (await openOffers("A")).find((o) => o.tripId === trip2)!;
    // Hold the losing offers for a moment so both accepts have locked their own driver row first (the natural race, made deterministic).
    const hold = await database.pool.connect();
    await hold.query("BEGIN");
    await hold.query("SELECT 1 FROM offers WHERE offer_id = ANY($1) FOR UPDATE", [[b1.offerId, a2.offerId]]);
    const both = Promise.all([
      call(app, "POST", `/offers/${a1.offerId}/accept`, drivers.A.headers, { expectedVersion: a1.version }),
      call(app, "POST", `/offers/${b2.offerId}/accept`, drivers.B.headers, { expectedVersion: b2.version }),
    ]);
    await sleep(400);
    await hold.query("COMMIT");
    hold.release();
    const [ra, rb] = await both;
    expect([ra.statusCode, rb.statusCode], ra.body + rb.body).toEqual([200, 200]);
  });

  it("H4: a timer firing while a command holds the trip steps back instead of deadlocking", async () => {
    const tripId = await create(rider);
    await worker.runDue();
    clock.now = new Date(clock.now.getTime() + 15_000); // the exclusive offer's ROUND timer is now due
    const riderId = (await database.db.selectFrom("trips").select("rider_id").where("trip_id", "=", tripId).executeTakeFirstOrThrow()).rider_id;
    let commandError: unknown;
    let fired: Promise<boolean> | undefined;
    const command = database.db.transaction().execute(async (trx) => {
      await lockTrip(trx, tripId); // the rider's cancel request has started
      fired = worker.runOne(); // meanwhile the worker takes the ROUND timer and waits for the trip
      await sleep(300);
      const trip = await lockTrip(trx, tripId);
      await riderCancel(trx, riderId, tripId, { expectedVersion: trip.version, reasonCode: "plans_changed" }, clock.now).catch((e) => {
        commandError = e;
        throw e;
      });
    }).catch(() => undefined);
    await command;
    await fired;
    expect({ commandError: String(commandError ?? ""), warnings: warnings.join() }).toEqual({ commandError: "", warnings: "" });
  });

  it("H5: with two instances, the busy step and the search end (both at 8 min) do not deadlock", async () => {
    const tripId = await create(rider);
    const start = clock.now.getTime();
    await worker.runDue();
    while (clock.now.getTime() < start + 470_000) await advance(10);
    clock.now = new Date(start + 479_000);
    await worker.runDue();
    clock.now = new Date(start + 480_000);
    await Promise.all([worker.runOne(), worker2.runOne()]);
    // A worker that found the trip busy retries 250 ms later (TimerBusy): move the clock past that.
    clock.now = new Date(start + 481_000);
    await worker.runDue();
    const trip = await database.db.selectFrom("trips").select(["status", "search_step"]).where("trip_id", "=", tripId).executeTakeFirstOrThrow();
    // The two timers are due at the same instant, so which instance wins decides whether the last step (w5) was
    // recorded before the search ended; either way nothing deadlocks and the search ends.
    expect({ warnings: warnings.join(), status: trip.status }).toEqual({ warnings: "", status: "expired" });
    expect(["w4", "w5"]).toContain((trip.search_step as { id: string } | null)?.id);
  });

  it("M1: two instances' rounds never give one free driver two open Exclusives", async () => {
    await create(rider);
    await create(rider2); // both ROUND timers due now, not run yet
    const hold = await database.pool.connect();
    await hold.query("BEGIN");
    await hold.query("SELECT 1 FROM drivers WHERE driver_id = $1 FOR UPDATE", [drivers.A.id]);
    const both = Promise.all([worker.runOne(), worker2.runOne()]);
    await sleep(400);
    await hold.query("COMMIT");
    hold.release();
    await both;
    const open = await database.db.selectFrom("offers").select(["trip_id", "kind"]).where("driver_id", "=", drivers.A.id).where("status", "=", "open").execute();
    expect(open.filter((o) => o.kind === "exclusive").length, warnings.join()).toBeLessThanOrEqual(1);
  });

  it("M2: the rider keeps seeing the keep_waiting question while the trip is offered", async () => {
    const tripId = await create(rider);
    const start = clock.now.getTime();
    await worker.runDue();
    const seen: Array<[string, string | undefined]> = [];
    while (clock.now.getTime() < start + 470_000) {
      await advance(5);
      for (const key of ["A", "B", "C"] as const) await call(app, "POST", "/driver/location", drivers[key].headers, { fixes: [{ ...SPOTS[key], accuracy: 5, measuredAt: clock.now.toISOString() }] });
      if (clock.now.getTime() >= start + 300_000) {
        const t = (await call(app, "GET", `/trips/${tripId}`, rider)).json();
        seen.push([t.status, t.searchStep?.id]);
      }
    }
    const offeredWithout = seen.filter(([status, step]) => status === "offered" && step === undefined);
    expect(offeredWithout.length, JSON.stringify(seen)).toBe(0);
   // ~94 simulated 5 s steps, each with 3 HTTP location posts: needs more than the default 20 s on a loaded runner.
  }, 120_000);

  it("M2b: the busy step's message shows on the expired trip", async () => {
    const tripId = await create(rider);
    const start = clock.now.getTime();
    await worker.runDue();
    while (clock.now.getTime() < start + 490_000) await advance(10);
    const t = (await call(app, "GET", `/trips/${tripId}`, rider)).json();
    expect(t.status).toBe("expired");
    expect(t.searchStep?.kind).toBe("busy");
  });

  it("M3: going offline withdraws the driver's offers, and an accept while offline is 409", async () => {
    await create(rider);
    await worker.runDue();
    const [offer] = await openOffers("A");
    const profile = (await call(app, "GET", "/driver/profile", drivers.A.headers)).json();
    const off = await call(app, "POST", "/driver/availability", drivers.A.headers, { expectedVersion: profile.version, onlineStatus: "offline" });
    expect(off.statusCode).toBe(200);
    const res = await call(app, "POST", `/offers/${offer!.offerId}/accept`, drivers.A.headers, { expectedVersion: offer!.version });
    await worker.runDue();
    const stillOpen = (await openOffers("A")).length;
    expect({ stillOpen, accept: res.statusCode }).toEqual({ stillOpen: 0, accept: 409 });
  });

  it("L1: the winner's own feed says the offer was claimed", async () => {
    await create(rider);
    await worker.runDue();
    const [offer] = await openOffers("A");
    await call(app, "POST", `/offers/${offer!.offerId}/accept`, drivers.A.headers, { expectedVersion: offer!.version });
    const last = await database.db.selectFrom("offer_events").select(["kind", "offer"]).where("driver_id", "=", drivers.A.id).orderBy("sequence", "desc").executeTakeFirstOrThrow();
    expect((last.offer as { status: string }).status).toBe("claimed");
  });
});
