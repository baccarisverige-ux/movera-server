import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { Kysely, PostgresDialect } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { cacheLiveDocuments } from "../../src/config/service.js";
import type { Database } from "../../src/db/schema.js";
import type { Db } from "../../src/db/db.js";
import { dispatchHandlers, FeedQueue, ROUND, runRound } from "../../src/dispatch/runtime.js";
import { seedDriver } from "../../src/drivers/service.js";
import { scheduleTimer, TimerWorker } from "../../src/jobs/timers.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { call, NORRMALM, SODERMALM, signIn, testWorld } from "../support/world.js";

/**
 * B1.29 (S4-W1 recheck Q89, owner "A) Yes" — no behaviour change; AUDIT-S01 A5): a dispatch round that can only wait
 * (here: every driver in reach already let reaskLimit offers of this trip pass) does not read the per-driver facts
 * (open offers, papers, driving limit, score counts, blocks, category off). It waits exactly as before.
 */
let database: TestDatabase;
let app: FastifyInstance;
let worker: TimerWorker;
let traced: Kysely<Database>;
let seen: string[] = [];
const clock = { now: new Date("2026-10-24T12:00:00Z") };
const sample = (name: string) => JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/${name}.json`, "utf8"));
const SPOTS = { A: { lat: 59.3335, lng: 18.0655 }, B: { lat: 59.336, lng: 18.07 }, C: { lat: 59.34, lng: 18.075 } };
const drivers: Record<"A" | "B" | "C", { id: string; headers: Record<string, string> }> = {} as never;
let rider: Record<string, string>;
const FACT_TABLES = ["driver_cancels", "blocked_pairs", "driver_phone_data", 'from "documents"'];

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  await database.db.insertInto("config_live").values({ doc: "dispatch", zone_id: "Z001", version: 1, document: JSON.stringify(sample("dispatch_document")), published_at: clock.now, published_by: null }).execute();
  await database.db.insertInto("config_live").values({ doc: "driver_app_config", zone_id: "Z001", version: 1, document: JSON.stringify(sample("driver_app_config")), published_at: clock.now, published_by: null }).execute();
  traced = new Kysely<Database>({ dialect: new PostgresDialect({ pool: database.pool }), log: (e) => { if (e.level === "query") seen.push(e.query.sql); } });
  worker = new TimerWorker(traced as unknown as Db, { handlers: dispatchHandlers, logger: { warn: () => undefined, error: (d, m) => console.error(m, d) }, clock: () => clock.now });
  const phones = { A: TEST_PHONES[1]!, B: TEST_PHONES[2]!, C: TEST_PHONES[3]! };
  for (const key of ["A", "B", "C"] as const) {
    const made = await database.db.transaction().execute((trx) =>
      seedDriver(trx, { phone: phones[key], firstName: `Driver ${key}`, make: "Volvo", model: "V60", year: 2021, color: "Black", plate: `TSW00${key}`, categoryIds: ["economy"], zoneIds: ["Z001", "Z002"] }, clock.now),
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

/** A live ride whose search took its far step and repeats, with A, B and C each past reaskLimit (2) for it. */
async function spentSearch(): Promise<string> {
  const tripId = await book();
  await database.db.deleteFrom("timers").execute();
  const search = await database.db.selectFrom("searches").selectAll().where("trip_id", "=", tripId).executeTakeFirstOrThrow();
  const trip = await database.db.selectFrom("trips").selectAll().where("trip_id", "=", tripId).executeTakeFirstOrThrow();
  let n = 0;
  for (const key of ["A", "B", "C"] as const) for (let i = 0; i < 2; i++) {
    n++;
    const at = new Date(search.started_at.getTime() + n * 1000);
    await database.db.insertInto("offers").values({
      offer_id: `ofr_b129_${tripId}_${n}`, trip_id: tripId, driver_id: drivers[key].id, kind: "exclusive", status: "expired", round: n, group_id: null, reason_code: null,
      currency: trip.currency, fare_minor: Number(trip.fare_minor), driver_earnings_minor: 0, pickup_pay_minor: 0, pickup_meters: 500, pickup_eta_seconds: 60,
      sent_at: at, expires_at: new Date(at.getTime() + 15_000), answered_at: new Date(at.getTime() + 15_000), decline_reason: null, rider_rating: null, driver_on_trip: false,
    }).execute();
  }
  const state = { cur: "exclusive", step: 2, tried: 0, asked: [drivers.A.id, drivers.B.id, drivers.C.id], switched: ["radar", "exclusive"], repeat: true, far: true };
  await database.db.updateTable("searches").set({ state: JSON.stringify(state), rounds: 6 }).where("trip_id", "=", tripId).execute();
  await database.db.updateTable("trips").set({ status: "searching" }).where("trip_id", "=", tripId).execute();
  return tripId;
}

const roundDue = (tripId: string) => database.db.transaction().execute((trx) => scheduleTimer(trx, { kind: ROUND, refId: tripId, dueAt: clock.now, payload: {} }));

describe("B1.29 wait round skips the driver facts", () => {
  it("B1.29: a wait round with only spent drivers in reach reads no driver facts", async () => {
    const tripId = await spentSearch();
    await roundDue(tripId);
    seen = [];
    await worker.runDue();
    // Same wait as before: no offer, the round counted, the next round after radar.seconds (15 s).
    const offers = await database.db.selectFrom("offers").select("status").where("trip_id", "=", tripId).execute();
    expect(offers.every((o) => o.status === "expired")).toBe(true);
    const search = await database.db.selectFrom("searches").select(["rounds", "state"]).where("trip_id", "=", tripId).executeTakeFirstOrThrow();
    expect(search.rounds).toBe(7);
    const timer = await database.db.selectFrom("timers").select("due_at").where("kind", "=", "dispatch_round").where("ref_id", "=", tripId).executeTakeFirstOrThrow();
    expect(timer.due_at.getTime()).toBe(clock.now.getTime() + 15_000);
    // The box read ran (the drivers are there), the per-driver facts did not.
    expect(seen.some((q) => q.includes('"driver_locations"'))).toBe(true);
    expect(seen.filter((q) => FACT_TABLES.some((t) => q.includes(t)))).toEqual([]);
  });

  it("B1.29: the same wait leaves the same state as the full read", async () => {
    const tripId = await spentSearch();
    const outcome = async (full: boolean) => {
      let got: unknown;
      await database.db.transaction().execute(async (trx) => {
        await runRound(trx, tripId, clock.now, new FeedQueue(), { readFactsAlways: full } as never);
        const search = await trx.selectFrom("searches").select(["state", "rounds", "document"]).where("trip_id", "=", tripId).executeTakeFirstOrThrow();
        const timers = await trx.selectFrom("timers").select(["kind", "due_at", "payload"]).where("ref_id", "=", tripId).orderBy("kind").execute();
        const offers = await trx.selectFrom("offers").select(["driver_id", "status"]).where("trip_id", "=", tripId).orderBy("offer_id").execute();
        const trip = await trx.selectFrom("trips").select(["status", "version"]).where("trip_id", "=", tripId).executeTakeFirstOrThrow();
        got = { search, timers, offers, trip };
        throw new Rollback();
      }).catch((e: unknown) => { if (!(e instanceof Rollback)) throw e; });
      return got;
    };
    const fast = await outcome(false);
    const full = await outcome(true);
    expect(fast).toEqual(full);
    expect((fast as { search: { rounds: number } }).search.rounds).toBe(7);
  });

  it("B1.29: a driver who is not spent still gets his offer (the fast path never hides a real one)", async () => {
    const tripId = await spentSearch();
    // C's offers fall out of this search: he may be asked again.
    await database.db.deleteFrom("offers").where("trip_id", "=", tripId).where("driver_id", "=", drivers.C.id).execute();
    await roundDue(tripId);
    await worker.runDue();
    const open = await database.db.selectFrom("offers").select(["driver_id", "status"]).where("trip_id", "=", tripId).where("status", "=", "open").execute();
    expect(open.map((o) => o.driver_id)).toContain(drivers.C.id);
  });
});

class Rollback extends Error {}
