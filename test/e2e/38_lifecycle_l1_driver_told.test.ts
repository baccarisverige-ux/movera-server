import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { bookAndAccept, drive, fakeOsrm, PLACES, Sim, type Admin, type Driver, type Rider } from "./harness.js";

/**
 * Contract v0.18.50 §72, owner decisions on the trip lifecycle supervisor report (Rules
 * plan/finders-2026-11-07/LIFECYCLE.md; proof tests scratchpad lifecycle_sup.test.ts). L1: the driver gets a push + bell when the rider cancels or ends early, or an admin cancels, reassigns or marks a no-show.
 */
let sim: Sim;
let osrm: Awaited<ReturnType<typeof fakeOsrm>>;
let rider: Rider;
let a: Driver;
let b: Driver;
let owner: Admin;

beforeAll(async () => {
  osrm = await fakeOsrm({ distance: 8000, duration: 1080 });
  sim = await Sim.start({ osrmUrl: osrm.url });
  rider = await sim.rider(0);
  a = await sim.driver(1, PLACES.nearSergels);
  b = await sim.driver(2, PLACES.odenplan);
  owner = await sim.owner();
});
afterAll(async () => {
  await sim.stop();
  await osrm.close();
});
afterEach(async () => {
  await sim.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("status", "not in", ["completed", "cancelled_by_rider", "cancelled_by_admin", "expired", "cancelled_by_system", "no_show", "failed", "cancelled_by_driver"]).execute();
  await sim.db.updateTable("offers").set({ status: "withdrawn" }).where("status", "=", "open").execute();
  await sim.db.updateTable("drivers").set({ online_status: "online" }).where("online_status", "=", "on_trip").execute();
  await sim.db.updateTable("rider_fees").set({ status: "waived" }).where("status", "=", "owed").execute();
  // S5 J8 (debtModel.riderWallet): the unpaid fee is a negative wallet balance; the reset clears it too.
  await sim.db.updateTable("rider_wallets").set({ balance_minor: 0 }).where("balance_minor", "<", "0").execute();
  await sim.db.updateTable("riders").set({ outstanding_minor: 0, outstanding_source_trip_id: null }).execute();
  await sim.advance(5);
  await a.moveTo(PLACES.nearSergels);
  await b.moveTo(PLACES.odenplan);
});

const notes = async (audience: "rider" | "driver", subjectId: string, tripId: string) =>
  await sim.db.selectFrom("notifications").select(["kind", "data", "title", "body", "bell", "deep_link"]).where("audience", "=", audience).where("subject_id", "=", subjectId).where("trip_id", "=", tripId).where("kind", "!=", "new_offer").orderBy("created_at").execute();
void notes; void drive; void bookAndAccept; void expect;

const told = async (tripId: string) => (await notes("driver", a.id, tripId)).filter((n) => n.kind === "driver_trip_update");
const version = async (tripId: string) => (await owner.get(`/admin/trips/${tripId}`)).body.version as number;

describe("L1: the driver is told when the trip is taken from him (fail-before: no driver notice at all)", () => {
  it("the rider cancels while he drives to the pickup: « Course annulée », his share of the fee, bell, trips/{id} link", async () => {
    await sim.db.updateTable("drivers").set({ language: "fr" }).where("driver_id", "=", a.id).execute();
    try {
      const { tripId } = await bookAndAccept(sim, rider, a);
      await drive(a, tripId, "driver_to_pickup");
      await sim.advance(5 * 60); // after the free minutes: a cancel fee
      const res = await rider.command(tripId, "cancel", { reasonCode: "plans_changed" });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const got = await told(tripId);
      expect(got).toHaveLength(1);
      expect(got[0]).toMatchObject({ title: "Course annulée", bell: true, deep_link: `movera-driver://trips/${tripId}` });
      expect((got[0]!.data as { moment: string }).moment).toBe("rider_cancelled");
      // His share of the cancel fee (the sample economy rule: 35 kr, 100 % to the driver).
      expect(got[0]!.body).toBe("Le passager a annulé la course. Vous recevez 35,00 kr.");
      expect((got[0]!.data as { fee?: unknown }).fee).toEqual({ amountMinor: 3500, currency: "SEK" });
    } finally {
      await sim.db.updateTable("drivers").set({ language: null }).where("driver_id", "=", a.id).execute();
    }
  });

  it("an admin reassigns, an admin cancels: admin_reassigned, admin_cancelled", async () => {
    const one = await bookAndAccept(sim, rider, a);
    await drive(a, one.tripId, "driver_to_pickup");
    expect((await owner.tripCommand(one.tripId, "reassign", { expectedVersion: await version(one.tripId), reasonCode: "admin_operational", note: "x" })).status).toBe(200);
    expect((await told(one.tripId)).map((n) => (n.data as { moment: string }).moment)).toEqual(["admin_reassigned"]);
    await rider.command(one.tripId, "cancel", { reasonCode: "plans_changed" });
    await sim.advance(5);
    const two = await bookAndAccept(sim, rider, a);
    await drive(a, two.tripId, "driver_to_pickup");
    expect((await owner.tripCommand(two.tripId, "cancel", { expectedVersion: await version(two.tripId), reasonCode: "admin_operational", note: "x" })).status).toBe(200);
    expect((await told(two.tripId)).map((n) => (n.data as { moment: string }).moment)).toEqual(["admin_cancelled"]);
  });

  it("the rider ends early on board: rider_ended_early; the driver's own steps send nothing", async () => {
    const { tripId } = await bookAndAccept(sim, rider, a);
    await drive(a, tripId, "in_trip");
    expect(await told(tripId)).toEqual([]);
    await sim.advance(120);
    await a.moveTo(PLACES.odenplan);
    expect((await rider.command(tripId, "end-early", { reasonCode: "plans_changed" })).status).toBe(200);
    expect((await told(tripId)).map((n) => (n.data as { moment: string }).moment)).toEqual(["rider_ended_early"]);
  });

  it("an admin marks a no-show: admin_no_show with his share", async () => {
    const { tripId } = await bookAndAccept(sim, rider, a);
    await drive(a, tripId, "arrived");
    await sim.advance(30 * 60);
    await a.moveTo(PLACES.sergels);
    const res = await owner.tripCommand(tripId, "no-show", { expectedVersion: await version(tripId), note: "rider not there" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const got = await told(tripId);
    expect(got.map((n) => (n.data as { moment: string }).moment)).toEqual(["admin_no_show"]);
    const fee = (got[0]!.data as { fee?: { amountMinor: number } }).fee;
    if (fee) expect(fee.amountMinor).toBeGreaterThan(0);
  });
});
