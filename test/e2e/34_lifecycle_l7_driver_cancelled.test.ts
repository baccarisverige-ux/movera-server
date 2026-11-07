import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { bookAndAccept, drive, fakeOsrm, PLACES, Sim, type Admin, type Driver, type Rider } from "./harness.js";

/**
 * Contract v0.18.50 §72, owner decisions on the trip lifecycle supervisor report (Rules
 * plan/finders-2026-11-07/LIFECYCLE.md; proof tests scratchpad lifecycle_sup.test.ts). L7: a driver's give-back is the rider-stream kind driver_cancelled; an admin reassign stays trip_projection.
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
  await sim.db.updateTable("riders").set({ outstanding_minor: 0, outstanding_source_trip_id: null }).execute();
  await sim.advance(5);
  await a.moveTo(PLACES.nearSergels);
  await b.moveTo(PLACES.odenplan);
});

const notes = async (audience: "rider" | "driver", subjectId: string, tripId: string) =>
  await sim.db.selectFrom("notifications").select(["kind", "data", "title", "body", "bell", "deep_link"]).where("audience", "=", audience).where("subject_id", "=", subjectId).where("trip_id", "=", tripId).where("kind", "!=", "new_offer").orderBy("created_at").execute();
void notes; void drive; void bookAndAccept; void expect;

describe("L7: the rider can tell a driver cancel from an admin reassign", () => {
  it("driver cancel → event kind driver_cancelled; admin reassign → trip_projection (fail-before: both trip_projection)", async () => {
    const shape = async (tripId: string) => {
      const items = (await rider.get(`/trips/${tripId}/events?after=0`)).body.items as Array<{ kind: string; projection?: { status?: string } }>;
      const last = items.filter((e) => e.projection?.status === "searching").pop()!;
      return { kind: last.kind, status: last.projection?.status };
    };
    const one = await bookAndAccept(sim, rider, a);
    expect((await a.command(one.tripId, "cancel", { reasonCode: "vehicle_issue_before_start" })).status).toBe(200);
    expect(await shape(one.tripId)).toEqual({ kind: "driver_cancelled", status: "searching" });
    await rider.command(one.tripId, "cancel", { reasonCode: "plans_changed" });
    await sim.advance(5);
    const two = await bookAndAccept(sim, rider, [a, b]);
    const v = (await owner.get(`/admin/trips/${two.tripId}`)).body.version;
    expect((await owner.tripCommand(two.tripId, "reassign", { expectedVersion: v, reasonCode: "admin_operational", note: "x" })).status).toBe(200);
    expect(await shape(two.tripId)).toEqual({ kind: "trip_projection", status: "searching" });
  });
});
