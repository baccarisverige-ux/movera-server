import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { maxPickupKm, type DispatchDoc } from "../../src/dispatch/engine.js";
import { candidatesFor } from "../../src/dispatch/runtime/candidates.js";
import { seedDriver } from "../../src/drivers/service.js";
import { insertRider, insertTrip } from "../support/seed.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { NORRMALM, SODERMALM, testWorld } from "../support/world.js";

/**
 * S01 A1: a live ride's round reads free drivers boxed on their position and on-trip drivers boxed on their drop-off.
 * The pool must be exactly the one of the old single read (no box for live rides, then km ≤ reachKm): the reference
 * below is the very same function without reachKm, cut at reachKm.
 */
let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-11-11T12:00:00Z") };
const sample = (name: string) => JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/${name}.json`, "utf8"));
const doc = sample("dispatch_document") as DispatchDoc;
const reachKm = maxPickupKm(doc);
// Near, at the edge and far (Uppsala-ish, Södertälje-ish) positions and drop-offs.
const NEAR = { lat: 59.3335, lng: 18.0655 };
const EDGE = { lat: NORRMALM.lat + (reachKm * 0.9) / (111.32 * 1.25), lng: NORRMALM.lng };
const OUT = { lat: NORRMALM.lat + (reachKm * 1.1) / (111.32 * 1.25), lng: NORRMALM.lng };
const FAR = { lat: 59.86, lng: 17.64 };
type Spot = { lat: number; lng: number };
// [driver position, on-trip drop-off (null = free), route km, rider not on board yet]
const CASES: Array<[Spot, Spot | null, number, boolean]> = [
  [NEAR, null, 0, false], [EDGE, null, 0, false], [OUT, null, 0, false], [FAR, null, 0, false],
  [NEAR, NEAR, 10, false], // on trip, drop-off near, 90 % done
  [FAR, NEAR, 300, false], // far away himself, drop-off near: must stay (km is from the drop-off)
  [NEAR, FAR, 80, false], // near himself, drop-off far: out in both versions
  [FAR, FAR, 80, false], // far away, drop-off far: out in both
  [EDGE, EDGE, 10, false], [OUT, OUT, 10, false],
  [NEAR, NEAR, 10, true], // still driving to his pickup: never a candidate
  [EDGE, NEAR, 2, false], // 7 km left of a 2 km route: under minRouteDonePct
];
const ids: string[] = [];

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  await database.db.insertInto("config_live").values({ doc: "dispatch", zone_id: "Z001", version: 1, document: JSON.stringify(doc), published_at: clock.now, published_by: null }).execute();
  for (const [i, [at, drop, km, two]] of CASES.entries()) {
    const made = await database.db.transaction().execute((trx) =>
      seedDriver(trx, { phone: `+467099900${String(i).padStart(2, "0")}`, firstName: `Box ${i}`, make: "Volvo", model: "V60", year: 2021, color: "Black", plate: `BOX${String(i).padStart(3, "0")}`, categoryIds: ["economy"], zoneIds: ["Z001", "Z002"] }, clock.now),
    );
    ids.push(made.driverId);
    await database.db.updateTable("drivers").set({ online_status: drop ? "on_trip" : "online", last_free_at: clock.now }).where("driver_id", "=", made.driverId).execute();
    await database.db.insertInto("driver_locations").values({ driver_id: made.driverId, ...at, accuracy: 5, measured_at: clock.now, received_at: clock.now })
      .onConflict((c) => c.column("driver_id").doUpdateSet({ ...at, measured_at: clock.now, received_at: clock.now })).execute();
    if (!drop) continue;
    {
      const t = await insertTrip(database.db, await insertRider(database.db), { status: "in_trip" });
      await database.db.updateTable("trips").set({ zone_id: "Z001", category_id: "economy", driver_id: made.driverId, status: two ? "driver_to_pickup" : "in_trip", dropoff: JSON.stringify({ address: "Drop", ...drop }), distance_meters: Math.round(km * 1000) }).where("trip_id", "=", t).execute();
    }
  }
  await database.db.deleteFrom("timers").execute();
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

describe("candidates read in two boxed reads (S01 A1)", () => {
  for (const kind of ["live", "scheduled"] as const) {
    it(`${kind}: same candidates, km and on-trip facts as the unboxed read`, async () => {
      const tripId = await insertTrip(database.db, await insertRider(database.db), { status: "searching" });
      await database.db.updateTable("trips").set({ zone_id: "Z001", category_id: "economy", pickup: JSON.stringify(NORRMALM), dropoff: JSON.stringify(SODERMALM), distance_meters: 3000 }).where("trip_id", "=", tripId).execute();
      if (kind === "scheduled") await database.db.updateTable("trips").set({ kind: "scheduled", scheduled_at: new Date(clock.now.getTime() + 20 * 60_000) }).where("trip_id", "=", tripId).execute();
      const trip = (await database.db.selectFrom("trips").selectAll().where("trip_id", "=", tripId).executeTakeFirstOrThrow()) as unknown as Parameters<typeof candidatesFor>[1];
      const [boxed, all] = await database.db.transaction().execute(async (trx) => [
        await candidatesFor(trx, trip, doc, clock.now, { reachKm }),
        await candidatesFor(trx, trip, doc, clock.now),
      ]);
      const want = all.candidates.filter((c) => c.km <= reachKm);
      const key = (cs: typeof want) => cs.map((c) => JSON.stringify(c)).sort();
      expect(key(boxed.candidates)).toEqual(key(want));
      expect([...boxed.bookedNext].sort()).toEqual([...all.bookedNext].filter((id) => want.some((c) => c.driverId === id)).sort());
      for (const c of want) expect(boxed.meta.get(c.driverId)).toEqual(all.meta.get(c.driverId));
      const got = new Set(boxed.candidates.map((c) => c.driverId));
      // Free near/edge drivers always; the out and far ones never.
      expect(got.has(ids[0]!) && got.has(ids[1]!)).toBe(true);
      expect(got.has(ids[2]!) || got.has(ids[3]!)).toBe(false);
      expect(got.has(ids[6]!) || got.has(ids[7]!) || got.has(ids[9]!) || got.has(ids[10]!) || got.has(ids[11]!)).toBe(false);
      if (kind === "live") {
        // On-trip drivers whose drop-off is in reach stay, wherever they are themselves.
        expect(got.has(ids[4]!) && got.has(ids[5]!) && got.has(ids[8]!)).toBe(true);
        expect(all.candidates.some((c) => c.driverId === ids[7])).toBe(true); // far ones exist in the unboxed read
      }
    });
  }
});
