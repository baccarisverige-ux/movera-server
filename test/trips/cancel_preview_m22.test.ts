import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TripRow } from "../../src/db/tripLog.js";
import { redactProjection } from "../../src/realtime/events.js";
import { riderCancelFee } from "../../src/trips/ride.js";
import { tripProjection } from "../../src/trips/projection.js";
import { riderCancel } from "../../src/trips/service.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver, insertRider, insertTrip } from "../support/seed.js";

/**
 * BQ-M22 part 1 (contract v0.18.89 §90, contract.json#priceDisplay.cancelPreview): TripProjection.cancelPreview { feeNow,
 * kind, freeUntil?, feeAfterFree?, kindAfterFree? } on the rider and admin views (never the driver's, nor his stream), while
 * the rider can cancel a trip a driver has (accepted, driver_to_pickup, arrived) and on a booked ride before pickup; not while
 * searching, not on an ended trip; absent with no cancel rule. feeNow is exactly what POST /trips/{tripId}/cancel charges at
 * that moment (riderCancelFee), and feeAfterFree what it charges from freeUntil on. Sweden (SEK), France (EUR), Tunisia
 * (TND, 3 decimals).
 */

let database: TestDatabase;
const T0 = new Date("2026-11-14T10:00:00Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
type Money = { amountMinor: number; currency: string };
type Preview = { feeNow: Money; kind: string; freeUntil?: string; feeAfterFree?: Money; kindAfterFree?: string };

type Setup = {
  currency: string; status: string; kind?: "live" | "scheduled"; fare: number; withDriver?: boolean; acceptedMin?: number | null; scheduledMin?: number; createdMin?: number;
  rule: { freeMin: number; type: "fixed" | "percent"; value: number; min: Money | null; max: Money | null } | null; noShowOn?: boolean; noShowFee?: number;
  waiting?: { arrivedMin: number; freeUntilMin: number }; queued?: boolean; chainFreeMin?: number; noRules?: boolean;
  /** Not heading to the pickup since this minute (the zone default: free after 2 min in a row). */
  notHeadingFromMin?: number;
};
async function trip(s: Setup): Promise<TripRow> {
  const withDriver = s.withDriver ?? true;
  // One live trip per rider and one open trip per driver: each trip has its own.
  const riderId = await insertRider(database.db);
  const driverId = await insertDriver(database.db);
  const id = await insertTrip(database.db, riderId, { status: s.status, kind: s.kind ?? "live", driverId: withDriver ? driverId : null });
  const noShowFee = { amountMinor: s.noShowFee ?? 0, currency: s.currency };
  const rules = {
    cancelRule: s.rule, cancelDriverSharePct: 50, noShowDriverSharePct: 50, waitDriverSharePct: 100, cancelAfterArrivedIsNoShow: s.noShowOn ?? true,
    waiting: { freeWaitMin: 5, perMin: { amountMinor: 100, currency: s.currency }, noShowAfterMin: 5, noShowFee },
  };
  const waiting = s.waiting ? { arrivedAt: at(s.waiting.arrivedMin).toISOString(), freeUntil: at(s.waiting.freeUntilMin).toISOString(), noShowAt: at(s.waiting.freeUntilMin + 5).toISOString(), chargedSeconds: 0, noShowFee } : null;
  await database.db.updateTable("trips").set({
    zone_id: "Z001", currency: s.currency, fare_minor: s.fare, booked_fare_minor: s.fare, fare_lines: JSON.stringify([{ code: "base", amount: { amountMinor: s.fare, currency: s.currency } }]),
    booking_rules: s.noRules ? null : JSON.stringify(rules), accepted_at: withDriver && s.acceptedMin !== null ? at(s.acceptedMin ?? 0) : null,
    scheduled_at: s.scheduledMin !== undefined ? at(s.scheduledMin) : null, created_at: at(s.createdMin ?? -60), waiting: waiting ? JSON.stringify(waiting) : null,
    heading_check: s.notHeadingFromMin !== undefined ? JSON.stringify({ heading: false, checkedAt: at(s.notHeadingFromMin + 1).toISOString(), notHeadingSince: at(s.notHeadingFromMin).toISOString(), freeAfter: at(s.notHeadingFromMin + 2).toISOString(), meters: 3_000 }) : null,
    next_after_trip_id: s.queued ? "trp_before" : null, chained: s.chainFreeMin !== undefined, chain_free_cancel_at: s.chainFreeMin !== undefined ? at(s.chainFreeMin) : null,
  }).where("trip_id", "=", id).execute();
  return (await database.db.selectFrom("trips").selectAll().where("trip_id", "=", id).executeTakeFirstOrThrow()) as unknown as TripRow;
}
const preview = (t: TripRow, now: Date, viewer: "rider" | "admin" = "rider") => tripProjection(t, viewer, { now })["cancelPreview"] as Preview | undefined;
/** What the real cancel would charge at `now` (0 when free). */
async function charged(t: TripRow, now: Date): Promise<{ fee: Money; kind: string }> {
  const fee = await riderCancelFee(database.db, t, now);
  return fee ? { fee: fee.fee, kind: fee.kind } : { fee: { amountMinor: 0, currency: t.currency }, kind: "cancel" };
}
/** feeNow / kind equal the real fee now; feeAfterFree / kindAfterFree equal the real fee just after freeUntil. */
async function sameAsCancel(t: TripRow, now: Date): Promise<Preview> {
  const p = preview(t, now)!;
  expect(p, "cancelPreview").toBeDefined();
  const real = await charged(t, now);
  expect({ feeNow: p.feeNow, kind: p.kind }).toEqual({ feeNow: real.fee, kind: real.kind });
  if (p.freeUntil) {
    const after = await charged(t, new Date(Date.parse(p.freeUntil) + 1));
    expect({ feeAfterFree: p.feeAfterFree, kindAfterFree: p.kindAfterFree }).toEqual({ feeAfterFree: after.fee, kindAfterFree: after.kind });
    const before = await charged(t, new Date(Date.parse(p.freeUntil) - 1));
    expect(before).toEqual(real);
  }
  expect(preview(t, now, "admin")).toEqual(p);
  return p;
}

beforeAll(async () => {
  database = await freshDatabase();
});
afterAll(async () => {
  await database.drop();
});

const SEK_RULE = { freeMin: 2, type: "fixed" as const, value: 3_500, min: null, max: null };

describe("BQ-M22: TripProjection.cancelPreview (priceDisplay.cancelPreview)", () => {
  it("SEK live, accepted: free for 2 min (feeNow 0, freeUntil = accept + 2 min, feeAfterFree 35,00 kr), then 35,00 kr with no freeUntil", async () => {
    const t = await trip({ currency: "SEK", status: "accepted", fare: 25_000, rule: SEK_RULE });
    const free = await sameAsCancel(t, at(1));
    expect(free).toEqual({ feeNow: { amountMinor: 0, currency: "SEK" }, kind: "cancel", freeUntil: at(2).toISOString(), feeAfterFree: { amountMinor: 3_500, currency: "SEK" }, kindAfterFree: "cancel" });
    const late = await sameAsCancel(t, at(3));
    expect(late).toEqual({ feeNow: { amountMinor: 3_500, currency: "SEK" }, kind: "cancel" });
  });

  it("EUR live, arrived with cancel-after-arrival = no-show: 5,00 € cancel now, 8,00 € no-show from the free waiting's end", async () => {
    const rule = { freeMin: 2, type: "fixed" as const, value: 500, min: null, max: null };
    const t = await trip({ currency: "EUR", status: "arrived", fare: 2_400, rule, noShowFee: 800, waiting: { arrivedMin: 8, freeUntilMin: 13 } });
    const before = await sameAsCancel(t, at(10));
    expect(before).toEqual({ feeNow: { amountMinor: 500, currency: "EUR" }, kind: "cancel", freeUntil: at(13).toISOString(), feeAfterFree: { amountMinor: 800, currency: "EUR" }, kindAfterFree: "no_show" });
    const after = await sameAsCancel(t, at(14));
    expect(after).toEqual({ feeNow: { amountMinor: 800, currency: "EUR" }, kind: "no_show" });
    // The zone switch off: the cancel fee stays, no step.
    const off = await trip({ currency: "EUR", status: "arrived", fare: 2_400, rule, noShowOn: false, noShowFee: 800, waiting: { arrivedMin: 8, freeUntilMin: 13 } });
    expect(await sameAsCancel(off, at(14))).toEqual({ feeNow: { amountMinor: 500, currency: "EUR" }, kind: "cancel" });
  });

  it("TND booked ride with no driver yet (3 decimals): free until 60 min before pickup, then 10 % of 20.000 DT = 2.000 DT", async () => {
    const rule = { freeMin: 60, type: "percent" as const, value: 10, min: null, max: null };
    const t = await trip({ currency: "TND", status: "requested", kind: "scheduled", withDriver: false, fare: 20_000, scheduledMin: 180, createdMin: -600, rule });
    const free = await sameAsCancel(t, at(0));
    expect(free).toEqual({ feeNow: { amountMinor: 0, currency: "TND" }, kind: "cancel", freeUntil: at(120).toISOString(), feeAfterFree: { amountMinor: 2_000, currency: "TND" }, kindAfterFree: "cancel" });
    expect(await sameAsCancel(t, at(150))).toEqual({ feeNow: { amountMinor: 2_000, currency: "TND" }, kind: "cancel" });
    // Booked 3 min ago, already inside the fee window: the 5 min grace first, then the fee.
    const fresh = await trip({ currency: "TND", status: "requested", kind: "scheduled", withDriver: false, fare: 20_000, scheduledMin: 30, createdMin: -3, rule });
    expect(await sameAsCancel(fresh, at(0))).toEqual({ feeNow: { amountMinor: 0, currency: "TND" }, kind: "cancel", freeUntil: at(2).toISOString(), feeAfterFree: { amountMinor: 2_000, currency: "TND" }, kindAfterFree: "cancel" });
  });

  it("stays free: a queued trip, a chained trip past freeCancelAt (feeNow 0, no freeUntil)", async () => {
    const queued = await trip({ currency: "SEK", status: "accepted", fare: 25_000, rule: SEK_RULE, queued: true });
    expect(await sameAsCancel(queued, at(1))).toEqual({ feeNow: { amountMinor: 0, currency: "SEK" }, kind: "cancel" });
    const chained = await trip({ currency: "SEK", status: "driver_to_pickup", fare: 25_000, rule: SEK_RULE, chainFreeMin: 5 });
    expect(await sameAsCancel(chained, at(3))).toEqual({ feeNow: { amountMinor: 3_500, currency: "SEK" }, kind: "cancel" });
    expect(await sameAsCancel(chained, at(6))).toEqual({ feeNow: { amountMinor: 0, currency: "SEK" }, kind: "cancel" });
  });

  it("supervisor S1 SEK: the heading check makes the cancel free (not heading for 2 min in a row) — feeNow 0, as the real cancel", async () => {
    const t = await trip({ currency: "SEK", status: "driver_to_pickup", fare: 25_000, rule: SEK_RULE, notHeadingFromMin: 3 });
    // Still inside the 2 min of not heading: the fee.
    expect(await sameAsCancel(t, at(4))).toEqual({ feeNow: { amountMinor: 3_500, currency: "SEK" }, kind: "cancel" });
    // From freeAfter (3 + 2 min) on: free.
    expect(await sameAsCancel(t, at(6))).toEqual({ feeNow: { amountMinor: 0, currency: "SEK" }, kind: "cancel" });
  });

  it("not sent: live while searching, an ended trip, a trip with no cancel rule or no kept rules", async () => {
    const searching = await trip({ currency: "SEK", status: "searching", fare: 25_000, withDriver: false, acceptedMin: null, rule: SEK_RULE });
    expect(preview(searching, at(1))).toBeUndefined();
    const ended = await trip({ currency: "SEK", status: "cancelled_by_rider", fare: 25_000, rule: SEK_RULE });
    expect(preview(ended, at(1))).toBeUndefined();
    expect(preview(await trip({ currency: "SEK", status: "accepted", fare: 25_000, rule: null }), at(5))).toBeUndefined();
    expect(preview(await trip({ currency: "SEK", status: "accepted", fare: 25_000, rule: SEK_RULE, noRules: true }), at(5))).toBeUndefined();
  });

  it("privacy: never on the driver's view nor his stream; the rider's stream keeps it", async () => {
    const t = await trip({ currency: "SEK", status: "driver_to_pickup", fare: 25_000, rule: SEK_RULE });
    expect(tripProjection(t, "driver", { now: at(3) })["cancelPreview"]).toBeUndefined();
    const stored = tripProjection(t, "admin", { now: at(3) });
    expect(stored["cancelPreview"]).toBeDefined();
    expect(redactProjection(stored, "driver")["cancelPreview"]).toBeUndefined();
    expect(redactProjection(stored, "rider")["cancelPreview"]).toEqual(stored["cancelPreview"]);
  });

  it("SEK: the real rider cancel charges exactly feeNow", async () => {
    const t = await trip({ currency: "SEK", status: "accepted", fare: 25_000, rule: SEK_RULE });
    const p = preview(t, at(4))!;
    const done = await database.db.transaction().execute((trx) => riderCancel(trx, t.rider_id, t.trip_id, { expectedVersion: t.version, reasonCode: "plans_changed" }, at(4)));
    expect((done.cancellation as { fee: Money }).fee).toEqual(p.feeNow);
    expect(p.feeNow).toEqual({ amountMinor: 3_500, currency: "SEK" });
  });
});
