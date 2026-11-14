import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { summarize } from "../../src/admin/kpis.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver, insertRider, insertTrip } from "../support/seed.js";
import { call, testWorld } from "../support/world.js";

/**
 * S5 J5 supervisor must-fix 1 (contract v0.18.82 moneyBase.kpiMoney): Movera's later money on a trip of an OLDER, already
 * stored day (admin driver-pay, an admin bonus on a completed trip) re-sums that day at once, through the real admin
 * routes — like a refund. Before: the entry was written, the stored kpi_days row stayed wrong until the next re-sum.
 * Sweden (SEK) and Tunisia (TND, 3 decimals).
 */

let database: TestDatabase;
let app: FastifyInstance;
let admin: Record<string, string>;
const clock = { now: new Date("2026-11-13T10:00:00Z") };
const DAY = "2026-11-10";

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  admin = (await adminSession(app, database.db, "super", { now: clock.now })).headers;
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

/** A paid trip that ended on DAY (an older day), its earnings entry, and the day already stored in kpi_days. */
async function storedTrip(zone: string, currency: string) {
  const riderId = await insertRider(database.db);
  const driverId = await insertDriver(database.db);
  const tripId = await insertTrip(database.db, riderId, { status: "completed", driverId });
  await database.db.updateTable("trips").set({
    zone_id: zone, currency, fare_minor: 30_000, booked_fare_minor: 30_000, fare_lines: JSON.stringify([{ code: "base", amount: { amountMinor: 30_000, currency } }]),
    driver_earnings_minor: 24_000, commission_minor: 6_000, pickup_pay_minor: 0, driver_bonus_minor: 0, payment_method: "cash", payment_status: "captured",
    ended_at: new Date(`${DAY}T10:00:00Z`), updated_at: new Date(`${DAY}T10:00:00Z`),
  }).where("trip_id", "=", tripId).execute();
  await database.db.insertInto("earnings_entries").values({ entry_id: `ern_lm_${tripId}`, driver_id: driverId, trip_id: tripId, kind: "trip", currency, amount_minor: 24_000, gross_minor: 30_000, commission_minor: 6_000, cash_minor: 30_000, at: new Date(`${DAY}T10:00:00Z`) }).execute();
  await database.db.transaction().execute((trx) => summarize(trx, clock.now, DAY));
  return tripId;
}
const stored = async (zone: string) => {
  const row = await database.db.selectFrom("kpi_days").select(["movera_earnings_minor", "driver_bonus_minor"]).where("zone_id", "=", zone).where("day", "=", DAY).executeTakeFirstOrThrow();
  return { movera: Number(row.movera_earnings_minor), bonus: Number(row.driver_bonus_minor) };
};
const version = async (tripId: string) => (await database.db.selectFrom("trips").select("version").where("trip_id", "=", tripId).executeTakeFirstOrThrow()).version;

describe("S5 J5: a later money entry re-sums the trip's stored day (moneyBase.kpiMoney)", () => {
  for (const c of [{ zone: "Z001", currency: "SEK", change: 10_000 }, { zone: "TN-TC", currency: "TND", change: 5_000 }] as const) {
    it(`${c.currency}: POST /admin/trips/{id}/driver-pay on an older stored day → that day's Movera earnings drop by the change`, async () => {
      const tripId = await storedTrip(c.zone, c.currency);
      const before = await stored(c.zone);
      const res = await call(app, "POST", `/admin/trips/${tripId}/driver-pay`, admin, { expectedVersion: await version(tripId), change: { amountMinor: c.change, currency: c.currency }, reason: "Long wait" });
      expect(res.statusCode, res.body).toBe(200);
      expect((await stored(c.zone)).movera).toBe(before.movera - c.change);
    });
  }

  it("SEK: POST /admin/trips/{id}/driver-bonus on a completed trip of an older stored day → that day's driver bonus grows", async () => {
    const tripId = await storedTrip("Z001", "SEK");
    const before = await stored("Z001");
    const res = await call(app, "POST", `/admin/trips/${tripId}/driver-bonus`, admin, { expectedVersion: await version(tripId), amount: { amountMinor: 2_000, currency: "SEK" } });
    expect(res.statusCode, res.body).toBe(200);
    expect((await stored("Z001")).bonus).toBe(before.bonus + 2_000);
  });
});
