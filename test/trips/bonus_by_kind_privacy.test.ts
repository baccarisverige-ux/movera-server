import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TripRow } from "../../src/db/tripLog.js";
import { redactProjection } from "../../src/realtime/events.js";
import { hideDriverMoney, hidePinFromDriver, tripProjection } from "../../src/trips/projection.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver, insertRider, insertTrip } from "../support/seed.js";
import { call, testWorld } from "../support/world.js";

/**
 * Post-merge re-check f71adcf (Rules audits/impact/server-p89-fields-supervisor.md): TripProjection.driverBonusByKind is
 * "Admin view only" (contract openapi TripProjection.driverBonusByKind / admin driver-bonus text). The stored trip event
 * carries the admin projection, so the rider's and the driver's streams must drop it (hideDriverMoney / hidePinFromDriver).
 * Sweden (SEK) and Tunisia (TND, 3 decimals).
 */

let database: TestDatabase;
let app: FastifyInstance;
let admin: Record<string, string>;
const now = new Date("2026-11-14T10:00:00Z");
const clock = { now };

async function trip(currency: string, status: string, withDriver: boolean): Promise<TripRow> {
  // One active trip per rider / driver: a fresh rider (and driver) per trip.
  const id = await insertTrip(database.db, await insertRider(database.db), { status, driverId: withDriver ? await insertDriver(database.db) : null });
  await database.db.updateTable("trips").set({
    currency, fare_minor: 20_000, booked_fare_minor: 20_000, fare_lines: JSON.stringify([{ code: "base", amount: { amountMinor: 20_000, currency } }]),
    driver_earnings_minor: 16_000, pickup_pay_minor: 0, driver_bonus_minor: 3_000, commission_minor: 1_000, payment_method: "cash",
    bonus_exclusive_minor: 3_000, bonus_radar_minor: 1_500, priority: true,
  } as never).where("trip_id", "=", id).execute();
  return (await database.db.selectFrom("trips").selectAll().where("trip_id", "=", id).executeTakeFirstOrThrow()) as unknown as TripRow;
}

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  admin = (await adminSession(app, database.db, "super", { now })).headers;
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

describe("driverBonusByKind is admin only (rider and driver views and streams)", () => {
  for (const currency of ["SEK", "TND"]) {
    it(`${currency}: the admin view has it; the rider and driver views, hideDriverMoney, hidePinFromDriver and both streams do not`, async () => {
      const r = await trip(currency, "searching", false);
      const stored = tripProjection(r, "admin", { now });
      expect(stored["driverBonusByKind"]).toEqual({
        exclusive: { amountMinor: 3_000, currency, priority: true },
        radar: { amountMinor: 1_500, currency, priority: true },
      });
      for (const [name, out] of Object.entries({
        riderView: tripProjection(r, "rider", { now }),
        driverView: tripProjection(r, "driver", { now }),
        hideDriverMoney: hideDriverMoney(stored),
        hidePinFromDriver: hidePinFromDriver(stored),
        riderStream: redactProjection(stored, "rider"),
        driverStream: redactProjection(stored, "driver"),
      })) expect(out["driverBonusByKind"], name).toBeUndefined();
      expect(redactProjection(stored, "admin")["driverBonusByKind"]).toEqual(stored["driverBonusByKind"]);
    });
  }

  it("SEK real route: POST /admin/trips/{id}/driver-bonus stores an event whose rider and driver streams carry no driverBonusByKind", async () => {
    const r = await trip("SEK", "accepted", true);
    const view = (await call(app, "GET", `/admin/trips/${r.trip_id}`, admin)).json();
    const res = await call(app, "POST", `/admin/trips/${r.trip_id}/driver-bonus`, admin, { expectedVersion: view.version, amount: { amountMinor: 2_000, currency: "SEK" } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().driverBonusByKind).toBeDefined();
    const last = await database.db.selectFrom("trip_events").select(["projection"]).where("trip_id", "=", r.trip_id).orderBy("sequence", "desc").limit(1).executeTakeFirstOrThrow();
    const stored = last.projection as Record<string, unknown>;
    expect(stored["driverBonusByKind"]).toBeDefined();
    expect(redactProjection(stored, "rider")["driverBonusByKind"]).toBeUndefined();
    expect(redactProjection(stored, "driver")["driverBonusByKind"]).toBeUndefined();
  });
});
