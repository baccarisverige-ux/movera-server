import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { bookAndAccept, drive, fakeOsrm, PLACES, Sim, type Driver, type Rider } from "./harness.js";

/**
 * Contract v0.18.50 §72, owner decisions on the trip lifecycle supervisor report (Rules
 * plan/finders-2026-11-07/LIFECYCLE.md; proof tests scratchpad lifecycle_sup.test.ts). L4: the driver cancels a queued next trip with a driverNextTrip reason.
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

describe("L4: a queued next trip can be cancelled by its driver", () => {
  it("driverNextTrip reason → back to dispatch without him, rider keeps searching, no fee, current trip untouched, counted (fail-before: 400 invalid_reason_code)", async () => {
    await sim.db.updateTable("drivers").set({ online_status: "offline" }).where("driver_id", "=", b.id).execute();
    const NEAR_DROP = { lat: 59.318, lng: 18.0718 }; // ~80 % of the way: on-trip Exclusives are allowed
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
      expect(await sim.db.selectFrom("trips").select(["status", "next_after_trip_id"]).where("trip_id", "=", next.tripId).executeTakeFirstOrThrow()).toEqual({ status: "accepted", next_after_trip_id: cur.tripId });

      const res = await a.command(next.tripId, "cancel", { reasonCode: "next_trip_pickup_too_far" });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const row = await sim.db.selectFrom("trips").select(["status", "driver_id", "next_after_trip_id", "cancelled_driver_ids", "fare_lines"]).where("trip_id", "=", next.tripId).executeTakeFirstOrThrow();
      expect(row).toMatchObject({ status: "searching", driver_id: null, next_after_trip_id: null });
      expect(row.cancelled_driver_ids).toContain(a.id);
      const seen = await rider.trip(next.tripId);
      expect(seen["status"]).toBe("searching");
      expect(seen["cancellation"]?.["fee"] ?? null).toBeNull();
      expect(await sim.db.selectFrom("rider_fees").select("kind").where("trip_id", "=", next.tripId).execute()).toEqual([]);
      // His current trip goes on; the give-back counts on his record.
      expect(["in_trip", "approaching_dropoff"]).toContain((await sim.db.selectFrom("trips").select("status").where("trip_id", "=", cur.tripId).executeTakeFirstOrThrow()).status);
      expect((await a.get("/driver/profile")).body["activeTripId"]).toBe(cur.tripId);
      expect((await sim.db.selectFrom("driver_cancels").select("reason_code").where("trip_id", "=", next.tripId).execute()).map((r) => r.reason_code)).toEqual(["next_trip_pickup_too_far"]);
      // A driverNextTrip code is not a reason for his current trip.
      const wrong = await a.command(cur.tripId, "cancel", { reasonCode: "next_trip_other" });
      expect([wrong.status, wrong.body["reason"]]).toEqual([400, "invalid_reason_code"]);
    } finally {
      await sim.db.updateTable("drivers").set({ online_status: "online" }).where("driver_id", "=", b.id).execute();
    }
  });
});
