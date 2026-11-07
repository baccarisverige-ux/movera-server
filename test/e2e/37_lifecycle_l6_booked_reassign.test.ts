import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { bookAndAccept, drive, fakeOsrm, PLACES, Sim, type Admin, type Driver, type Rider } from "./harness.js";

/**
 * Contract v0.18.50 §72, owner decisions on the trip lifecycle supervisor report (Rules
 * plan/finders-2026-11-07/LIFECYCLE.md; proof tests scratchpad lifecycle_sup.test.ts). L6: admin Reassign on a booked ride a driver holds = Reservations Unassign.
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

describe("L6: Reassign on a held booked ride", () => {
  it("back to the Scheduled rides list, the driver is told, no live search; like Unassign he may take it again (fail-before: live search + Exclusive to the same driver)", async () => {
    const at = new Date(sim.clock.now.getTime() + 240 * 60_000).toISOString();
    const quote = (await rider.quote({ categoryIds: ["economy"], kind: "scheduled", scheduledAt: at })).body["quotes"][0];
    const booked = await rider.post("/trips", { quoteId: quote.quoteId, categoryId: "economy", pickup: PLACES.sergels, dropoff: PLACES.medborgar, stops: [], kind: "scheduled", scheduledAt: at, paymentMethod: "cash" });
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    const tripId = booked.body.tripId as string;
    expect((await a.post(`/driver/reservations/${tripId}/accept`, { expectedVersion: (await rider.trip(tripId)).version })).status).toBe(200);
    const v = (await owner.get(`/admin/trips/${tripId}`)).body.version;
    const re = await owner.tripCommand(tripId, "reassign", { expectedVersion: v, reasonCode: "admin_operational", note: "check" });
    expect(re.status, JSON.stringify(re.body)).toBe(200);
    await sim.tick();
    const offers = await sim.db.selectFrom("offers").select(["driver_id", "kind", "status"]).where("trip_id", "=", tripId).execute();
    const told = (await notes("driver", a.id, tripId)).map((n) => n.kind);
    expect({ status: re.body.status, liveOffers: offers.filter((o) => o.kind !== "reservation").length, told: told.includes("reservation_unassigned") }).toEqual({ status: "requested", liveOffers: 0, told: true });
    // Owner 2026-11-07: as with Unassign he is not barred (re-offer allowed); it is on the list for him and others.
    const list = async (d: typeof a) => ((await d.get("/driver/reservations?scope=open")).body.items as Array<{ tripId: string }>).map((i) => i.tripId);
    expect((await sim.db.selectFrom("trips").select("cancelled_driver_ids").where("trip_id", "=", tripId).executeTakeFirstOrThrow()).cancelled_driver_ids).not.toContain(a.id);
    expect(await list(a)).toContain(tripId);
    expect(await list(b)).toContain(tripId);
    const audited = await sim.db.selectFrom("admin_audit").select("action").where("target_id", "=", tripId).execute();
    expect(audited.map((r) => r.action)).toContain("trip.reassign");
  });
});
