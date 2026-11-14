import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TripRow } from "../../src/db/tripLog.js";
import { riderCancelFee } from "../../src/trips/ride.js";
import type { Waiting } from "../../src/trips/ride/shared.js";
import { awayFrom, backAt } from "../../src/trips/ride/waitingClock.js";
import { tripProjection } from "../../src/trips/projection.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver, insertRider, insertTrip } from "../support/seed.js";

/**
 * C9 supervisor gap (contract v0.18.93 contract.json#autoArrive.riderCancel + priceDisplay.cancelPreview): the rider's
 * cancel preview follows the real cancel while the driver is away from the pickup. Away (waiting.away.since set): feeNow 0,
 * kind cancel, no freeUntil / feeAfterFree (the owner, Rules decisions/driver-g15.md:64: "if driver drive away from
 * pickup ... if rider cancel he got no cancellation fee"), also past the free waiting's end. Back at the pickup
 * (autoArrive.back: freeUntil moved later by the stopped time): the cancel fee, then the no-show fee from the moved
 * freeUntil, as before. Each preview equals what POST /trips/{tripId}/cancel charges (riderCancelFee). SEK and TND.
 */

let database: TestDatabase;
const T0 = new Date("2026-11-14T10:00:00Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
type Money = { amountMinor: number; currency: string };
type Preview = { feeNow: Money; kind: string; freeUntil?: string; feeAfterFree?: Money; kindAfterFree?: string };

/** An arrived live trip: accepted at 0, arrived at 8, free waiting until 13, cancel rule (2 free min, fixed fee), no-show fee. */
async function arrivedTrip(currency: string, fare: number, cancelFee: number, noShowFee: number): Promise<TripRow> {
  const riderId = await insertRider(database.db);
  const driverId = await insertDriver(database.db);
  const id = await insertTrip(database.db, riderId, { status: "arrived", kind: "live", driverId });
  const noShow = { amountMinor: noShowFee, currency };
  const rules = {
    cancelRule: { freeMin: 2, type: "fixed", value: cancelFee, min: null, max: null }, cancelDriverSharePct: 50, noShowDriverSharePct: 50, waitDriverSharePct: 100,
    cancelAfterArrivedIsNoShow: true, waiting: { freeWaitMin: 5, perMin: { amountMinor: 100, currency }, noShowAfterMin: 5, noShowFee: noShow },
  };
  const waiting: Waiting = { arrivedAt: at(8).toISOString(), freeUntil: at(13).toISOString(), noShowAt: at(18).toISOString(), chargedSeconds: 0, noShowFee: noShow, arrivedBy: "auto" };
  await database.db.updateTable("trips").set({
    zone_id: "Z001", currency, fare_minor: fare, booked_fare_minor: fare, fare_lines: JSON.stringify([{ code: "base", amount: { amountMinor: fare, currency } }]),
    booking_rules: JSON.stringify(rules), accepted_at: at(0), created_at: at(-60), waiting: JSON.stringify(waiting),
  }).where("trip_id", "=", id).execute();
  return read(id);
}
async function read(id: string): Promise<TripRow> {
  return (await database.db.selectFrom("trips").selectAll().where("trip_id", "=", id).executeTakeFirstOrThrow()) as unknown as TripRow;
}
async function setWaiting(t: TripRow, waiting: Waiting): Promise<TripRow> {
  await database.db.updateTable("trips").set({ waiting: JSON.stringify(waiting) }).where("trip_id", "=", t.trip_id).execute();
  return read(t.trip_id);
}
async function charged(t: TripRow, now: Date): Promise<{ fee: Money; kind: string }> {
  const fee = await riderCancelFee(database.db, t, now);
  return fee ? { fee: fee.fee, kind: fee.kind } : { fee: { amountMinor: 0, currency: t.currency }, kind: "cancel" };
}
/** The rider's preview, the admin's equal to it, feeNow / feeAfterFree equal to the real cancel. */
async function sameAsCancel(t: TripRow, now: Date): Promise<Preview> {
  const p = tripProjection(t, "rider", { now })["cancelPreview"] as Preview;
  expect(p, "cancelPreview").toBeDefined();
  expect(tripProjection(t, "admin", { now })["cancelPreview"]).toEqual(p);
  const real = await charged(t, now);
  expect({ feeNow: p.feeNow, kind: p.kind }).toEqual({ feeNow: real.fee, kind: real.kind });
  if (p.freeUntil) {
    const after = await charged(t, new Date(Date.parse(p.freeUntil) + 1));
    expect({ feeAfterFree: p.feeAfterFree, kindAfterFree: p.kindAfterFree }).toEqual({ feeAfterFree: after.fee, kindAfterFree: after.kind });
  }
  return p;
}

beforeAll(async () => {
  database = await freshDatabase();
});
afterAll(async () => {
  await database.drop();
});

const cases = [
  // Sweden: 250 kr fare, 35 kr cancel fee, 65 kr no-show fee.
  { currency: "SEK", fare: 25_000, cancelFee: 3_500, noShowFee: 6_500 },
  // Tunisia (3 decimals): 20.000 DT fare, 3.000 DT cancel fee, 5.500 DT no-show fee.
  { currency: "TND", fare: 20_000, cancelFee: 3_000, noShowFee: 5_500 },
];

describe("C9 supervisor gap: TripProjection.cancelPreview while the driver is away from the pickup", () => {
  for (const c of cases) {
    const zero = { amountMinor: 0, currency: c.currency };
    const cancelFee = { amountMinor: c.cancelFee, currency: c.currency };
    const noShowFee = { amountMinor: c.noShowFee, currency: c.currency };

    it(`${c.currency}: control — at the pickup the cancel fee now, the no-show fee from freeUntil`, async () => {
      const t = await arrivedTrip(c.currency, c.fare, c.cancelFee, c.noShowFee);
      expect(await sameAsCancel(t, at(10))).toEqual({ feeNow: cancelFee, kind: "cancel", freeUntil: at(13).toISOString(), feeAfterFree: noShowFee, kindAfterFree: "no_show" });
      expect(await sameAsCancel(t, at(14))).toEqual({ feeNow: noShowFee, kind: "no_show" });
    });

    it(`${c.currency}: away (clock stopped at minute 10) — feeNow 0, no freeUntil / feeAfterFree, also past the free waiting's end`, async () => {
      const arrived = await arrivedTrip(c.currency, c.fare, c.cancelFee, c.noShowFee);
      const t = await setWaiting(arrived, awayFrom(arrived.waiting as Waiting, at(10), at(10)));
      expect((t.waiting as Waiting).away).toEqual({ since: at(10).toISOString() });
      for (const minute of [11, 13, 20]) {
        const p = await sameAsCancel(t, at(minute));
        expect(p, `minute ${minute}`).toEqual({ feeNow: zero, kind: "cancel" });
        expect(p).not.toHaveProperty("freeUntil");
        expect(p).not.toHaveProperty("feeAfterFree");
      }
    });

    it(`${c.currency}: back at the pickup at minute 15 — freeUntil moved 5 min later (18), then the no-show fee as before`, async () => {
      const arrived = await arrivedTrip(c.currency, c.fare, c.cancelFee, c.noShowFee);
      const away = await setWaiting(arrived, awayFrom(arrived.waiting as Waiting, at(10), at(10)));
      const t = await setWaiting(away, backAt(away.waiting as Waiting, at(15), at(15)));
      expect((t.waiting as Waiting).away).toBeUndefined();
      expect((t.waiting as Waiting).freeUntil).toBe(at(18).toISOString());
      expect(await sameAsCancel(t, at(16))).toEqual({ feeNow: cancelFee, kind: "cancel", freeUntil: at(18).toISOString(), feeAfterFree: noShowFee, kindAfterFree: "no_show" });
      expect(await sameAsCancel(t, at(19))).toEqual({ feeNow: noShowFee, kind: "no_show" });
    });
  }
});
