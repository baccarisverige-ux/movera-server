import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TripRow } from "../../src/db/tripLog.js";
import { endHandler, stopBookedNoDriver } from "../../src/dispatch/runtime/end.js";
import { END } from "../../src/dispatch/runtime/shared.js";
import { commissionOf } from "../../src/rules/commission.js";
import { applyCommand } from "../../src/trips/commands.js";
import { tripProjection } from "../../src/trips/projection.js";
import { driverCancel } from "../../src/trips/ride/cancel.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver, insertRider, insertTrip } from "../support/seed.js";
import { call, testWorld } from "../support/world.js";

/**
 * BQ-M27 (M24 supervisor N2, Rules audits/impact/server-m24-m22-supervisor.md:181; contract v0.18.92
 * moneyBase.commissionRow.admin): an end with no paid ride and no fee pays nobody. v0.18.92 G1 wrote FREE_END_COLUMNS
 * (driver_earnings / pickup_pay / driver_bonus / commission = 0) on a free rider cancel and an admin cancel; the other
 * unpaid ends still kept the quote's pay and commission in the raw columns, so the admin `commission` / `driverEarnings`
 * fields showed money nobody got:
 * - a driver cancel before pickup that then ends with no driver (the search runs out: system expire),
 * - a booked ride that finds no driver (system expire, stopBookedNoDriver),
 * - a system cancel (transition system_cancel → cancelled_by_system).
 * Now every expire and system cancel writes FREE_END_COLUMNS (one place: applyCommand, commands.ts). Sweden (SEK) and
 * Tunisia (TND, 3 decimals).
 */

let database: TestDatabase;
let app: FastifyInstance;
let admin: Record<string, string>;
const now = new Date("2026-11-14T10:00:00Z");
const clock = { now };
const SE = { zone_id: "Z001", currency: "SEK" };
const TN = { zone_id: "TN-TC", currency: "TND" };
type Zone = typeof SE;

const row = (tripId: string) => database.db.selectFrom("trips").selectAll().where("trip_id", "=", tripId).executeTakeFirstOrThrow() as Promise<TripRow>;

/** A trip in `status` carrying a quote's money: fare, driver pay, pickup pay, a bonus and the commission. */
async function quotedTrip(zone: Zone, status: string, m: { fare: number; earnings: number; pickup?: number; bonus?: number; driverId?: string | null; kind?: "live" | "scheduled" }) {
  const id = await insertTrip(database.db, await insertRider(database.db), { status, driverId: m.driverId ?? null, kind: m.kind ?? "live" });
  const lines = [{ code: "base", amount: { amountMinor: m.fare, currency: zone.currency } }];
  await database.db.updateTable("trips").set({
    zone_id: zone.zone_id, currency: zone.currency, payment_method: "cash", fare_minor: m.fare, booked_fare_minor: m.fare, fare_lines: JSON.stringify(lines),
    driver_earnings_minor: m.earnings, pickup_pay_minor: m.pickup ?? 0, driver_bonus_minor: m.bonus ?? 0, commission_minor: commissionOf(m.fare, lines, m.earnings, m.pickup ?? 0, m.bonus ?? 0),
    accepted_at: m.driverId ? new Date(now.getTime() - 5 * 60_000) : null, search_started_at: new Date(now.getTime() - 10 * 60_000),
    ...(m.kind === "scheduled" ? { scheduled_at: new Date(now.getTime() - 20 * 60_000) } : {}),
  }).where("trip_id", "=", id).execute();
  return id;
}

/** The four money columns of the trip row and what the admin route shows. */
async function moneyOf(tripId: string) {
  const r = await row(tripId);
  const got = await call(app, "GET", `/admin/trips/${tripId}`, admin);
  expect(got.statusCode, got.body).toBe(200);
  const view = got.json() as Record<string, { amountMinor: number } | undefined>;
  return {
    status: r.status,
    columns: [Number(r.driver_earnings_minor), Number(r.pickup_pay_minor), Number(r.driver_bonus_minor), Number(r.commission_minor)],
    adminCommission: view["commission"]?.amountMinor ?? 0,
    adminDriverEarnings: view["driverEarnings"]?.amountMinor ?? 0,
    adminKeeps: view["moveraKeepsNow"]?.amountMinor ?? 0,
  };
}

const timer = (tripId: string) => ({ timerId: `tmr_m27_${tripId}`, kind: END, refId: tripId, dueAt: now, payload: null, attempts: 0, firedAt: now });

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  admin = (await adminSession(app, database.db, "super", { now })).headers;
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

describe("BQ-M27: every unpaid end with no fee keeps no quoted driver pay or commission (FREE_END_COLUMNS)", () => {
  it("SEK driver cancel before pickup, then the search runs out (expired): pay, pickup pay, bonus and commission 0", async () => {
    const driverId = await insertDriver(database.db);
    const id = await quotedTrip(SE, "accepted", { fare: 25_000, earnings: 20_000, pickup: 1_500, bonus: 2_000, driverId });
    const before = await row(id);
    await database.db.transaction().execute((trx) => driverCancel(trx, driverId, id, { expectedVersion: before.version, reasonCode: "vehicle_issue_before_start" }, now));
    // Back to dispatch: the trip is still under way, so the next driver's quoted pay stays on it (correct, not an end).
    const back = await row(id);
    expect(back.status).toBe("searching");
    expect(back.driver_id).toBeNull();
    expect(Number(back.driver_earnings_minor)).toBe(20_000);
    // The search ends with no driver: system expire.
    await database.db.transaction().execute((trx) => endHandler(trx, timer(id) as never));
    const m = await moneyOf(id);
    expect(m.status).toBe("expired");
    expect(m.columns).toEqual([0, 0, 0, 0]);
    expect(m.adminCommission).toBe(0);
    expect(m.adminDriverEarnings).toBe(0);
    expect(m.adminKeeps).toBe(0);
  });

  it("TND booked ride with no driver at pickup (stopBookedNoDriver, expired): 0.000 DT pay and commission, not the quoted 30.000 / 12.000 DT", async () => {
    const id = await quotedTrip(TN, "searching", { fare: 42_000, earnings: 30_000, kind: "scheduled" });
    expect(Number((await row(id)).commission_minor)).toBe(12_000);
    await database.db.transaction().execute(async (trx) => {
      const locked = await trx.selectFrom("trips").selectAll().where("trip_id", "=", id).forUpdate().executeTakeFirstOrThrow();
      await stopBookedNoDriver(trx, locked as TripRow, now, async () => {});
    });
    const m = await moneyOf(id);
    expect(m.status).toBe("expired");
    expect(m.columns).toEqual([0, 0, 0, 0]);
    expect(m.adminCommission).toBe(0);
    expect(m.adminKeeps).toBe(0);
  });

  it("SEK system cancel of an accepted trip (cancelled_by_system): 0 pay and commission; the driver view's driverTotal is 0", async () => {
    const driverId = await insertDriver(database.db);
    const id = await quotedTrip(SE, "accepted", { fare: 30_000, earnings: 24_000, pickup: 1_000, driverId });
    await database.db.transaction().execute(async (trx) => {
      const locked = (await trx.selectFrom("trips").selectAll().where("trip_id", "=", id).forUpdate().executeTakeFirstOrThrow()) as TripRow;
      await applyCommand(trx, locked, { command: "system_cancel", actor: "system", now, set: { ended_by_command: "system_cancel", ended_at: now, cancellation: JSON.stringify({ actor: "system", reasonCode: "system_error", at: now.toISOString(), fee: null }) } });
    });
    const m = await moneyOf(id);
    expect(m.status).toBe("cancelled_by_system");
    expect(m.columns).toEqual([0, 0, 0, 0]);
    expect(m.adminCommission).toBe(0);
    expect(tripProjection(await row(id), "driver", { now })["driverTotal"]).toEqual({ amountMinor: 0, currency: "SEK" });
  });

  it("TND system cancel that carries its own money keeps it (a caller's set wins over the free-end zeros)", async () => {
    const id = await quotedTrip(TN, "searching", { fare: 42_000, earnings: 30_000 });
    await database.db.transaction().execute(async (trx) => {
      const locked = (await trx.selectFrom("trips").selectAll().where("trip_id", "=", id).forUpdate().executeTakeFirstOrThrow()) as TripRow;
      await applyCommand(trx, locked, { command: "system_cancel", actor: "system", now, set: { ended_by_command: "system_cancel", ended_at: now, driver_earnings_minor: 4_000, commission_minor: 1_000 } });
    });
    const r = await row(id);
    expect([Number(r.driver_earnings_minor), Number(r.commission_minor)]).toEqual([4_000, 1_000]);
  });
});
