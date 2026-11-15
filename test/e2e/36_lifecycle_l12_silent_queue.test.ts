import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { bookAndAccept, drive, fakeOsrm, PLACES, Sim, type Driver, type Rider } from "./harness.js";

/**
 * Contract v0.18.50 §72, owner decisions on the trip lifecycle supervisor report (Rules
 * plan/finders-2026-11-07/LIFECYCLE.md; proof tests scratchpad lifecycle_sup.test.ts). L12: a live trip queued behind a trip that failed for silence goes back to dispatch without that driver.
 */
let sim: Sim;
let osrm: Awaited<ReturnType<typeof fakeOsrm>>;
let rider: Rider;
let a: Driver;
let b: Driver;

beforeAll(async () => {
  osrm = await fakeOsrm({ distance: 8000, duration: 1080 });
  sim = await Sim.start({ osrmUrl: osrm.url });
  rider = await sim.rider(0);
  a = await sim.driver(1, PLACES.nearSergels);
  b = await sim.driver(2, PLACES.odenplan);
});
afterAll(async () => {
  await sim.stop();
  await osrm.close();
});
afterEach(async () => {
  await sim.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("status", "not in", ["completed", "cancelled_by_rider", "cancelled_by_admin", "expired", "cancelled_by_system", "no_show", "failed", "cancelled_by_driver"]).execute();
  await sim.db.updateTable("offers").set({ status: "withdrawn" }).where("status", "=", "open").execute();
  await sim.db.updateTable("drivers").set({ online_status: "online" }).where("online_status", "=", "on_trip").execute();
  await sim.db.updateTable("rider_fees").set({ status: "waived", settled_in_wallet: true }).where("status", "=", "owed").execute();
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

describe("L12: the queued trip of a silent failed trip", () => {
  it("goes back to dispatch without him; the rider is told a new driver is being found (fail-before: it started for him)", async () => {
    await sim.db.updateTable("drivers").set({ online_status: "offline" }).where("driver_id", "=", b.id).execute();
    const NEAR_DROP = { lat: 59.318, lng: 18.0718 };
    try {
      const other = await sim.rider(1);
      const cur = await other.book();
      await sim.tick();
      expect((await a.accept((await a.offerFor(cur.tripId))!)).status).toBe(200);
      await drive(a, cur.tripId, "in_trip");
      await a.moveTo(NEAR_DROP);
      const next = await rider.book();
      await sim.tick();
      const offer = await a.offerFor(next.tripId);
      expect(offer?.["kind"]).toBe("exclusive");
      expect((await a.accept(offer!)).status).toBe(200);
      expect((await sim.db.selectFrom("trips").select("next_after_trip_id").where("trip_id", "=", next.tripId).executeTakeFirstOrThrow()).next_after_trip_id).toBe(cur.tripId);
      // The car went silent 4 h ago with the rider on board: the silence check fails the current trip (3 h rule).
      const longAgo = new Date(sim.clock.now.getTime() - 4 * 3600_000);
      await sim.db.updateTable("driver_locations").set({ received_at: longAgo }).where("driver_id", "=", a.id).execute();
      await sim.db.updateTable("trips").set({ boarded_at: longAgo }).where("trip_id", "=", cur.tripId).execute();
      await sim.db.updateTable("timers").set({ due_at: sim.clock.now }).where("kind", "=", "driver_silence").where("ref_id", "=", cur.tripId).execute();
      await sim.tick();
      expect((await sim.db.selectFrom("trips").select("status").where("trip_id", "=", cur.tripId).executeTakeFirstOrThrow()).status).toBe("failed");
      const row = await sim.db.selectFrom("trips").select(["status", "driver_id", "next_after_trip_id", "cancelled_driver_ids"]).where("trip_id", "=", next.tripId).executeTakeFirstOrThrow();
      expect({ status: row.status, driver: row.driver_id, queued: row.next_after_trip_id }).toEqual({ status: "searching", driver: null, queued: null });
      expect(row.cancelled_driver_ids).toContain(a.id);
      const moments = (await sim.db.selectFrom("notifications").select("data").where("trip_id", "=", next.tripId).where("audience", "=", "rider").where("kind", "=", "trip_update").execute()).map((n) => (n.data as { moment?: string }).moment);
      expect(moments).toContain("driver_changed");
      // Not counted on his cancel record: the server sent it back, not him.
      expect(await sim.db.selectFrom("driver_cancels").select("reason_code").where("trip_id", "=", next.tripId).execute()).toEqual([]);
    } finally {
      await sim.db.updateTable("drivers").set({ online_status: "online" }).where("driver_id", "=", b.id).execute();
    }
  });
});
