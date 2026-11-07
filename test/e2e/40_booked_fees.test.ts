import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fakeOsrm, PLACES, Sim, type Admin, type Driver, type Json, type Rider } from "./harness.js";

/**
 * v0.18.51 §73 (owner 2026-11-07 "If rider cancel do booking fee and if driver cancel for no show its also booking fee
 * (for only reservation)", contract.json#bookedRide0_18_51.fees): on a booked ride a rider cancel after the driver
 * arrived costs the booked late-cancel fee (never the no-show fee), and a no-show costs the SAME booking fee.
 */
let sim: Sim;
let osrm: Awaited<ReturnType<typeof fakeOsrm>>;
let rider: Rider;
let a: Driver;
let owner: Admin;

beforeAll(async () => {
  osrm = await fakeOsrm({ distance: 8000, duration: 1080 });
  sim = await Sim.start({ osrmUrl: osrm.url, now: new Date("2026-11-05T05:00:00Z") });
  rider = await sim.rider(0);
  a = await sim.driver(1, PLACES.nearSergels);
});
afterAll(async () => {
  await sim.stop();
  await osrm.close();
});
beforeEach(async () => {
  await sim.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("status", "not in", ["completed", "cancelled_by_rider", "cancelled_by_admin", "expired", "cancelled_by_system", "no_show", "failed", "cancelled_by_driver"]).execute();
  await sim.db.updateTable("drivers").set({ online_status: "online" }).where("online_status", "=", "on_trip").execute();
  await sim.db.deleteFrom("rider_fees").execute();
  await jump(6 * 3600);
  owner = await sim.admin("super");
});

async function jump(seconds: number) {
  sim.clock.now = new Date(sim.clock.now.getTime() + seconds * 1000);
  if (a.position) await a.heartbeat();
  await sim.tick();
}
const minutes = (m: number) => new Date(sim.clock.now.getTime() + m * 60_000).toISOString();
const until = (at: string, plus = 0) => jump((Date.parse(at) - sim.clock.now.getTime()) / 1000 + plus);
const atT = (trip: Json, m: number) => new Date(Date.parse(trip.scheduledAt) + m * 60_000).toISOString();

/** The reservation cancel rule's fee on the booked fare, outside its free minutes (CONTRACT.md §6 FeeRule). */
function bookingFee(rule: Json, fareMinor: number): number {
  let fee = rule.type === "fixed" ? rule.value : Math.floor((fareMinor * rule.value * 2 + 100) / 200);
  if (rule.min) fee = Math.max(fee, rule.min.amountMinor);
  if (rule.max) fee = Math.min(fee, rule.max.amountMinor);
  return fee;
}

/** Booked at T; the driver takes it, starts at T−60 and arrives at T + arriveAtMin. */
async function arriveAt(arriveAtMin: number): Promise<{ trip: Json; arrived: Json; fee: number }> {
  const at = minutes(120);
  const quote = (await rider.quote({ categoryIds: ["economy"], kind: "scheduled", scheduledAt: at })).body.quotes[0];
  const made = await rider.post("/trips", { quoteId: quote.quoteId, categoryId: "economy", pickup: PLACES.sergels, dropoff: PLACES.medborgar, stops: [], kind: "scheduled", scheduledAt: at, paymentMethod: "cash" });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const trip = made.body;
  expect((await a.post(`/driver/reservations/${trip.tripId}/accept`, {})).status).toBe(200);
  await until(atT(trip, -60), 1);
  expect((await a.post(`/driver/reservations/${trip.tripId}/start`, {})).status).toBe(200);
  await until(atT(trip, arriveAtMin));
  const res = await a.command(trip.tripId, "arrive", { location: a.fix(PLACES.sergels) });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const rule = res.body.terms.cancelRule;
  expect(rule, "the economy booked ride has a reservation cancel rule").not.toBeNull();
  const fee = bookingFee(rule, res.body.quote.total.amountMinor);
  expect(fee).toBeGreaterThan(0);
  return { trip, arrived: res.body, fee };
}

describe("v0.18.51 §73 booked fees", () => {
  it("the driver's no-show confirm amount (waiting.noShowFee, terms.noShowFee) is the booking fee", async () => {
    const { arrived, fee } = await arriveAt(-2);
    expect(arrived.waiting.noShowFee.amountMinor).toBe(fee);
    expect(arrived.terms.noShowFee.amountMinor).toBe(fee);
    const share = arrived.terms.noShowDriverSharePct as number;
    expect(arrived.waiting.noShowDriverShare.amountMinor).toBe(Math.floor((fee * share * 2 + 100) / 200));
  });

  it("rider cancels after the free wait with the driver there: the booking late-cancel fee, feeKind cancel (not the no-show fee)", async () => {
    const { trip, arrived, fee } = await arriveAt(-2);
    await until(arrived.waiting.freeUntil, 60);
    const c = await rider.command(trip.tripId, "cancel", { reasonCode: "plans_changed" });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body.status).toBe("cancelled_by_rider");
    expect(c.body.cancellation).toMatchObject({ feeKind: "cancel", fee: { amountMinor: fee } });
    const owed = await sim.db.selectFrom("rider_fees").select(["kind", "amount_minor"]).where("trip_id", "=", trip.tripId).execute();
    expect(owed.map((r) => [r.kind, Number(r.amount_minor)])).toEqual([["cancel", fee]]);
  });

  it("driver marks a no-show: the same booking fee, status no_show, feeKind no_show", async () => {
    const { trip, arrived, fee } = await arriveAt(-2);
    await until(arrived.waiting.noShowAt);
    const ns = await a.command(trip.tripId, "no-show", { reasonCode: "rider_no_show" });
    expect(ns.status, JSON.stringify(ns.body)).toBe(200);
    expect(ns.body.status).toBe("no_show");
    expect(ns.body.cancellation).toMatchObject({ feeKind: "no_show", fee: { amountMinor: fee } });
    const owed = await sim.db.selectFrom("rider_fees").select(["kind", "amount_minor"]).where("trip_id", "=", trip.tripId).execute();
    expect(owed.map((r) => [r.kind, Number(r.amount_minor)])).toEqual([["no_show", fee]]);
  });

  it("admin marks a no-show on a booked ride: the same booking fee", async () => {
    const { trip, arrived, fee } = await arriveAt(-2);
    await until(arrived.waiting.noShowAt, 1);
    const version = (await a.trip(trip.tripId)).version;
    const ns = await owner.post(`/admin/trips/${trip.tripId}/no-show`, { expectedVersion: version, note: "rider not there" });
    expect(ns.status, JSON.stringify(ns.body)).toBe(200);
    expect(ns.body.cancellation).toMatchObject({ feeKind: "no_show", fee: { amountMinor: fee } });
  });
});
