import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { dispatchHandlers } from "../../src/dispatch/runtime.js";
import { seedDriver, setAvailability } from "../../src/drivers/service.js";
import { driverPerformance } from "../../src/drivers/performance.js";
import { countsAsIgnored } from "../../src/dispatch/autoOffline.js";
import { lockAndRecheck } from "../../src/dispatch/runtime/candidates.js";
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
const versionOf = async (key: "A" | "B" | "C") => (await call(app, "GET", "/driver/profile", drivers[key].headers)).json().version as number;
const offersOf = (id: string) => database.db.selectFrom("offers").select(["offer_id", "status", "kind", "sent_at"]).where("driver_id", "=", id).execute();

// PROOF (owner 2026-11-28, decisions/session-2026-11-06.md end): going offline from the radar withdraws a pending
// offer at once, it goes to the next driver at once, and it never counts as a decline or a miss.
describe("0.18.176 offline: no offers (server regression)", () => {
  it("(a) a pending offer is withdrawn at once on offline and re-dispatched without waiting for its timeout; no penalty", async () => {
    const tripId = await book();
    const [offerA] = await openOffers("A");
    expect(offerA).toMatchObject({ tripId, kind: "exclusive", status: "open" });
    const before = await driverPerformance(database.db, drivers.A.id, clock.now);
    const off = await call(app, "POST", "/driver/availability", drivers.A.headers, { expectedVersion: await versionOf("A"), onlineStatus: "offline" });
    expect(off.statusCode).toBe(200);
    // No clock advance: only the jobs due NOW run (the 15 s offer timeout has not passed).
    await worker.runDue();
    const rows = await offersOf(drivers.A.id);
    expect(rows.map((r) => r.status)).toEqual(["withdrawn"]);
    expect(await openOffers("A")).toEqual([]);
    const [offerB] = await openOffers("B");
    expect(offerB).toMatchObject({ tripId, status: "open" });
    // No decline / miss: acceptance counts unchanged, the auto-offline run does not count a withdrawn offer.
    const after = await driverPerformance(database.db, drivers.A.id, clock.now);
    expect(after.offersAnswerable).toBe(before.offersAnswerable);
    expect(after.acceptancePct).toBe(before.acceptancePct);
    expect(countsAsIgnored("withdrawn")).toBe(false);
    const events = await database.db.selectFrom("offer_events").select("kind").where("driver_id", "=", drivers.A.id).orderBy("sequence").execute();
    expect(events.slice(-2).map((e) => e.kind)).toEqual(["offer_created", "offer_withdrawn"]);
  });

  it("(b1) a dispatch round that runs while the offline request holds the driver row never offers him", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const held = new Promise<void>((r) => { locked = r; });
    const version = await versionOf("A");
    // The offline request, its transaction still open (row locked, not committed).
    const offline = database.db.transaction().execute(async (trx) => {
      await setAvailability(trx, drivers.A.id, { expectedVersion: version, onlineStatus: "offline" }, clock.now);
      locked();
      await gate;
    });
    await held;
    const tripId = await book(); // the round runs now (NOWAIT on A's row → busy, tried again)
    release();
    await offline;
    for (let i = 0; i < 4; i += 1) await advance(1);
    expect((await offersOf(drivers.A.id)).filter((r) => r.status === "open")).toEqual([]);
    expect((await offersOf(drivers.A.id)).length).toBe(0);
    const open = [...(await openOffers("B")), ...(await openOffers("C"))];
    expect(open.some((o: { tripId: string }) => o.tripId === tripId)).toBe(true);
  });

  it("(b2) a round that read the pool before offline committed re-checks under the lock and leaves him out", async () => {
    await database.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("status", "not in", ["completed", "cancelled_by_admin", "cancelled_by_rider", "expired"]).execute();
    await database.db.deleteFrom("offers").execute();
    // Pool read (A online) happens first; then offline commits; then the round locks the chosen drivers.
    const off = await call(app, "POST", "/driver/availability", drivers.A.headers, { expectedVersion: await versionOf("A"), onlineStatus: "offline" });
    expect(off.statusCode).toBe(200);
    const gone = await database.db.transaction().execute((trx) => lockAndRecheck(trx, [drivers.A.id, drivers.B.id]));
    expect([...gone]).toEqual([drivers.A.id]);
  });
});
