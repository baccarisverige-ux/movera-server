import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TripRow } from "../../src/db/tripLog.js";
import { redactProjection } from "../../src/realtime/events.js";
import { commissionOf } from "../../src/rules/commission.js";
import { tripProjection } from "../../src/trips/projection.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver, insertRider, insertTrip } from "../support/seed.js";
import { call, testWorld } from "../support/world.js";

/**
 * BQ-M24 (contract v0.18.89 finish.debt.moneySplit + moneyBase.commissionRow.admin "while the trip is not paid yet (no
 * moneySplit) it shows TripProjection.commission"): the admin "Who gets what" (moneySplit) is sent only on a paid trip end
 * (completed, the rider's early end, the driver's end on board, admin complete: the same isPaidEnd as moveraKeepsNow and the
 * KPI PAID_END). A free cancel, a cancel / no-show with a fee and a trip still under way have no moneySplit (before: riderPaid
 * = fare although the rider paid nothing). Sweden (SEK), France (EUR), Tunisia (TND, 3 decimals).
 */

let database: TestDatabase;
let app: FastifyInstance;
let admin: Record<string, string>;
let riderId: string;
let driverId: string;
const now = new Date("2026-11-14T10:00:00Z");
const clock = { now };

type Row = { status: string; currency: string; fare: number; earnings?: number; commission?: number; paid?: boolean; endedBy?: string | null; boarded?: boolean; cancellation?: unknown };
async function trip(m: Row): Promise<TripRow> {
  const id = await insertTrip(database.db, riderId, { status: m.status, driverId });
  const lines = [{ code: m.status.startsWith("cancelled") || m.status === "no_show" ? (m.fare === 0 ? "base" : "cancel_fee") : "base", amount: { amountMinor: m.fare, currency: m.currency } }];
  const earnings = m.earnings ?? 0;
  const ended = m.status !== "in_trip";
  await database.db.updateTable("trips").set({
    currency: m.currency, fare_minor: m.fare, booked_fare_minor: m.fare, fare_lines: JSON.stringify(lines), driver_earnings_minor: earnings, pickup_pay_minor: 0, driver_bonus_minor: 0,
    commission_minor: m.commission ?? commissionOf(m.fare, lines, earnings, 0, 0), payment_method: "cash", accepted_at: new Date(now.getTime() - 30 * 60_000),
    boarded_at: m.boarded ? new Date(now.getTime() - 20 * 60_000) : null, ended_at: ended ? now : null, ended_by_command: m.endedBy ?? null, payment_status: m.paid ? "captured" : null,
    cash_collected_minor: m.paid ? m.fare : null, cancellation: m.cancellation ? JSON.stringify(m.cancellation) : null,
  }).where("trip_id", "=", id).execute();
  return (await database.db.selectFrom("trips").selectAll().where("trip_id", "=", id).executeTakeFirstOrThrow()) as unknown as TripRow;
}

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  admin = (await adminSession(app, database.db, "super", { now })).headers;
  riderId = await insertRider(database.db);
  driverId = await insertDriver(database.db);
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

describe("BQ-M24: moneySplit only on a paid trip end (contract: unpaid trips have no moneySplit)", () => {
  it("SEK free rider cancel: no moneySplit and no moveraKeepsNow; GET /admin/trips/{id} the same; the stored commission stays", async () => {
    const t = await trip({ status: "cancelled_by_rider", currency: "SEK", fare: 25_000, endedBy: "cancel", cancellation: { actor: "rider", reasonCode: "plans_changed", fee: null } });
    const view = tripProjection(t, "admin", { now });
    expect(view["moneySplit"]).toBeUndefined();
    // v0.18.92 (supervisor G1): the admin row is what Movera keeps on this end — 0 on a free cancel, never the quote's commission.
    expect(view["moveraKeepsNow"]).toEqual({ amountMinor: 0, currency: "SEK" });
    expect(tripProjection(t, "driver", { now })["moveraKeepsNow"]).toBeUndefined();
    const got = await call(app, "GET", `/admin/trips/${t.trip_id}`, admin);
    expect(got.statusCode, got.body).toBe(200);
    expect(got.json().moneySplit).toBeUndefined();
    expect(got.json().commission).toEqual({ amountMinor: 25_000, currency: "SEK" });
    expect(got.json().moveraKeepsNow).toEqual({ amountMinor: 0, currency: "SEK" });
  });

  it("EUR rider cancel with an owed 5,00 € fee (feeColumns: fare = the fee): no moneySplit (the rider paid nothing yet)", async () => {
    const t = await trip({ status: "cancelled_by_rider", currency: "EUR", fare: 500, earnings: 400, commission: 100, endedBy: "cancel", cancellation: { actor: "rider", reasonCode: "plans_changed", fee: { amountMinor: 500, currency: "EUR" }, feeStatus: "owed", feeKind: "cancel" } });
    expect(tripProjection(t, "admin", { now })["moneySplit"]).toBeUndefined();
    // v0.18.92: the admin row = Movera's share of the fee (1,00 €).
    expect(tripProjection(t, "admin", { now })["moveraKeepsNow"]).toEqual({ amountMinor: 100, currency: "EUR" });
    // The fee and its split stay where the contract puts them (cancellation, driverTotal / commission).
    expect(tripProjection(t, "admin", { now })["cancellation"]).toMatchObject({ fee: { amountMinor: 500, currency: "EUR" } });
  });

  it("TND no-show with a 5.000 DT fee, an admin cancel and a trip still under way: no moneySplit", async () => {
    const noShow = await trip({ status: "no_show", currency: "TND", fare: 5_000, earnings: 2_500, commission: 2_500, endedBy: "no_show", cancellation: { actor: "driver", reasonCode: "rider_no_show", fee: { amountMinor: 5_000, currency: "TND" }, feeStatus: "owed", feeKind: "no_show" } });
    const byAdmin = await trip({ status: "cancelled_by_admin", currency: "TND", fare: 20_000, endedBy: "cancel" });
    const underWay = await trip({ status: "in_trip", currency: "TND", fare: 20_000, earnings: 16_000, boarded: true });
    const keeps = new Map<string, unknown>([[noShow.trip_id, { amountMinor: 2_500, currency: "TND" }], [byAdmin.trip_id, { amountMinor: 0, currency: "TND" }], [underWay.trip_id, undefined]]);
    for (const t of [noShow, byAdmin, underWay]) {
      const view = tripProjection(t, "admin", { now });
      expect(view["moneySplit"], t.status).toBeUndefined();
      // v0.18.92: on an end with no paid ride the admin row = Movera's fee share (2.500 DT; 0 on the admin cancel); still running: absent.
      expect(view["moveraKeepsNow"], t.status).toEqual(keeps.get(t.trip_id));
      expect(tripProjection(t, "driver", { now })["moveraKeepsNow"], t.status).toBeUndefined();
      expect(redactProjection(view, "driver")["moveraKeepsNow"], t.status).toBeUndefined();
      // The admin keeps his other money fields (the driver's one number, the stored commission).
      expect(view["driverTotal"], t.status).toBeDefined();
    }
  });

  it("TND paid end (3 decimals): moneySplit adds up and moveraKeepsNow = moneySplit.movera (22.000 DT, driver 16.000 DT, Movera 6.000 DT)", async () => {
    const t = await trip({ status: "completed", currency: "TND", fare: 22_000, earnings: 16_000, paid: true, endedBy: "complete" });
    const view = tripProjection(t, "admin", { now }) as { moneySplit: Record<string, { amountMinor: number; currency: string }>; moveraKeepsNow: unknown };
    expect(view.moneySplit["riderPaid"]).toEqual({ amountMinor: 22_000, currency: "TND" });
    expect(view.moneySplit["driverTotal"]).toEqual({ amountMinor: 16_000, currency: "TND" });
    expect(view.moneySplit["movera"]).toEqual({ amountMinor: 6_000, currency: "TND" });
    expect(view.moveraKeepsNow).toEqual(view.moneySplit["movera"]);
  });

  it("SEK driver's end with the rider on board (payment captured, cancelled_by_driver) is a paid end: moneySplit is sent", async () => {
    const t = await trip({ status: "cancelled_by_driver", currency: "SEK", fare: 18_000, earnings: 14_000, paid: true, endedBy: "cancel", boarded: true });
    const view = tripProjection(t, "admin", { now }) as { moneySplit?: { riderPaid: unknown } };
    expect(view.moneySplit?.riderPaid).toEqual({ amountMinor: 18_000, currency: "SEK" });
  });

  it("v0.18.92 SEK admin cancel with a 40 kr lost-driver payment: admin lostDriverPaid 40 kr, row −40 kr; never to the driver or rider", async () => {
    const t = await trip({ status: "cancelled_by_admin", currency: "SEK", fare: 25_000, endedBy: "cancel" });
    await database.db.updateTable("trips").set({ lost_driver_paid_minor: 4_000 }).where("trip_id", "=", t.trip_id).execute();
    const r = (await database.db.selectFrom("trips").selectAll().where("trip_id", "=", t.trip_id).executeTakeFirstOrThrow()) as unknown as TripRow;
    const view = tripProjection(r, "admin", { now });
    expect(view["lostDriverPaid"]).toEqual({ amountMinor: 4_000, currency: "SEK" });
    expect(view["moveraKeepsNow"]).toEqual({ amountMinor: -4_000, currency: "SEK" });
    for (const out of [tripProjection(r, "driver", { now }), tripProjection(r, "rider", { now }), redactProjection(view, "driver"), redactProjection(view, "rider")]) {
      expect(JSON.stringify(out)).not.toContain("lostDriverPaid");
      expect(out["moveraKeepsNow"]).toBeUndefined();
    }
  });

  it("privacy: the rider and the driver never get moneySplit (GET views and the stream), paid or not", async () => {
    const paid = await trip({ status: "completed", currency: "SEK", fare: 20_000, earnings: 15_000, paid: true, endedBy: "complete" });
    const stored = tripProjection(paid, "admin", { now });
    expect(stored["moneySplit"]).toBeDefined();
    for (const viewer of ["rider", "driver"] as const) {
      expect(tripProjection(paid, viewer, { now })["moneySplit"], viewer).toBeUndefined();
      expect(redactProjection(stored, viewer)["moneySplit"], viewer).toBeUndefined();
    }
  });
});
