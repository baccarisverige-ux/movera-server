import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { bookAndAccept, drive, fakeOsrm, PLACES, Sim, type Admin, type Driver, type Rider } from "./harness.js";

let sim: Sim;
let osrm: Awaited<ReturnType<typeof fakeOsrm>>;
let rider: Rider;
let a: Driver;
let b: Driver;
let owner: Admin;
let dispatcher: Admin;
let finance: Admin;

beforeAll(async () => {
  osrm = await fakeOsrm({ distance: 8000, duration: 1080 });
  sim = await Sim.start({ osrmUrl: osrm.url });
  rider = await sim.rider(0);
  a = await sim.driver(1, PLACES.nearSergels);
  b = await sim.driver(2, PLACES.odenplan);
  owner = await sim.owner();
  dispatcher = await sim.admin("dispatcher");
  finance = await sim.admin("finance");
});
afterAll(async () => {
  await sim.stop();
  await osrm.close();
});
afterEach(async () => {
  const active = await rider.get("/rider/trips/active");
  if (active.status === 200 && ["searching", "offered", "accepted", "driver_to_pickup"].includes(active.body.status)) await rider.command(active.body.tripId, "cancel", { reasonCode: "plans_changed" });
  // A case that blocked a driver or a car and failed half-way leaves them usable for the next one.
  await sim.db.updateTable("drivers").set({ account_status: "active" }).execute();
  await sim.db.updateTable("vehicles").set({ status: "approved" }).execute();
  await sim.advance(5);
  for (const [d, at] of [[a, PLACES.nearSergels], [b, PLACES.odenplan]] as const) {
    const p = (await d.get("/driver/profile")).body;
    if (p.onlineStatus === "offline" && p.accountStatus === "active") await d.goOnline(at);
    else await d.moveTo(at);
  }
});

async function completeAtDropoff(driver: Driver, tripId: string, body: Record<string, unknown> = {}) {
  await drive(driver, tripId, "in_trip");
  await sim.advance(60);
  await driver.moveTo(PLACES.medborgar);
  return driver.command(tripId, "complete", body);
}

describe("scenario 9: admin actions (what the server exposes)", () => {
  it("manual booking by an admin is not served (404 operation_not_enabled); assigning a searching trip to a chosen driver is", async () => {
    const none = await owner.post("/admin/trips", { riderId: rider.id });
    expect(none.status).toBe(404);
    expect(none.body.reason).toBe("operation_not_enabled");

    const { tripId } = await rider.book();
    const trip = await dispatcher.trip(tripId);
    const assigned = await dispatcher.tripCommand(tripId, "assign", { expectedVersion: trip.version, driverId: b.id });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
    const offer = await b.offerFor(tripId);
    expect(offer).toMatchObject({ tripId });
    expect((await b.accept(offer!)).body).toMatchObject({ status: "accepted", driver: { driverId: b.id } });
  });

  it("reassign an accepted trip: the driver is taken off (their stream closes), the trip searches again without them", async () => {
    const { tripId } = await bookAndAccept(sim, rider, a);
    const driverEvents = await a.events(tripId);
    const riderEvents = await rider.events(tripId);
    const trip = await dispatcher.trip(tripId);
    const res = await dispatcher.tripCommand(tripId, "reassign", { expectedVersion: trip.version, reasonCode: "admin_operational", note: "car broke down" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe("searching");
    await riderEvents.reach("searching");
    expect(await (async () => {
      for (let i = 0; i < 100 && !driverEvents.ended; i++) await new Promise((r) => setTimeout(r, 20));
      return driverEvents.ended;
    })()).toBe(true);
    expect((await a.get(`/trips/${tripId}`)).status).toBe(404);
    expect((await a.command(tripId, "head-to-pickup", { expectedVersion: trip.version + 1 })).status).toBe(404);
    await sim.tick();
    expect(await a.offerFor(tripId)).toBeUndefined();
    expect(await b.offerFor(tripId)).toBeDefined();
    riderEvents.close();
  });

  it("admin cancel mid-trip: cancelled_by_admin, the driver is free, a dispatcher outside the trip's zone may not", async () => {
    const { tripId } = await bookAndAccept(sim, rider, a);
    await drive(a, tripId, "arrived");
    const trip = await owner.trip(tripId);
    const outsider = await sim.admin("dispatcher", ["Z002"]);
    const refused = await outsider.tripCommand(tripId, "cancel", { expectedVersion: trip.version, reasonCode: "admin_safety", note: "x" });
    expect(refused.status).toBe(403);
    const res = await dispatcher.tripCommand(tripId, "cancel", { expectedVersion: trip.version, reasonCode: "admin_safety", note: "rider called" });
    expect(res.body).toMatchObject({ status: "cancelled_by_admin", cancellation: { actor: "admin" } });
    expect((await rider.trip(tripId)).status).toBe("cancelled_by_admin");
    expect((await a.get("/driver/profile")).body.onlineStatus).toBe("online");
  });

  it("refund: a finance admin's refund runs at once (v0.7.2, one admin is enough), so does the Super admin's; never more than was paid", async () => {
    const { tripId } = await bookAndAccept(sim, rider, a);
    const done = await completeAtDropoff(a, tripId);
    expect(done.body.status).toBe("completed");
    let version = (await owner.trip(tripId)).version;
    const byFinance = await finance.tripCommand(tripId, "refund", { expectedVersion: version, amount: { amountMinor: 5000, currency: "SEK" }, reason: "detour" });
    expect(byFinance.status, JSON.stringify(byFinance.body)).toBe(201);
    expect(byFinance.body.status).toBe("done");
    version = (await owner.trip(tripId)).version;
    const direct = await owner.tripCommand(tripId, "refund", { expectedVersion: version, amount: { amountMinor: 5000, currency: "SEK" }, reason: "sorry" });
    expect(direct.status, JSON.stringify(direct.body)).toBe(201);
    version = (await owner.trip(tripId)).version;
    const tooMuch = await owner.tripCommand(tripId, "refund", { expectedVersion: version, amount: { amountMinor: 21700 - 10000 + 1, currency: "SEK" }, reason: "x" });
    expect(tooMuch.body.reason).toBe("refund_too_large");
    expect(tooMuch.body.message).toBe("At most 117,00 kr is left to refund."); // BQ-O17: whole amounts keep their decimals
    const refunds = (await rider.get("/rider/refunds")).body;
    expect(JSON.stringify(refunds)).toContain("5000");
  });

  it("blocking a driver mid-trip: the trip goes on to the end, then they are offline and get no new offers (finding P3-3)", async () => {
    const { tripId } = await bookAndAccept(sim, rider, a);
    await drive(a, tripId, "in_trip");
    const profile = (await owner.get(`/admin/drivers/${a.id}`)).body;
    const blocked = await owner.post(`/admin/drivers/${a.id}/status`, { expectedVersion: profile.version, accountStatus: "suspended", note: "complaint" });
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(200);
    await sim.tick();
    expect((await rider.trip(tripId)).status).toBe("in_trip");
    await sim.advance(60);
    await a.moveTo(PLACES.medborgar);
    expect((await a.command(tripId, "complete")).body.status).toBe("completed");
    const after = (await a.get("/driver/profile")).body;
    expect(after.accountStatus).toBe("suspended");
    expect(after.onlineStatus).not.toBe("online");
    const goOnline = await a.post("/driver/availability", { expectedVersion: after.version, onlineStatus: "online" });
    expect(goOnline.body.reason).toBe("account_not_active");
    const next = await rider.book();
    await sim.tick();
    expect(await a.offerFor(next.tripId)).toBeUndefined();
    await rider.command(next.tripId, "cancel", { reasonCode: "plans_changed" });
    const back = (await owner.get(`/admin/drivers/${a.id}`)).body;
    await owner.post(`/admin/drivers/${a.id}/status`, { expectedVersion: back.version, accountStatus: "active", note: "cleared" });
  });

  it("blocking the car mid-trip: the trip goes on to the end, then the driver is offline and gets no offers with that car (finding P3-3)", async () => {
    const { tripId } = await bookAndAccept(sim, rider, a);
    await drive(a, tripId, "in_trip");
    const vehicleId = (await a.get("/driver/profile")).body.vehicleId as string;
    const car = await sim.db.selectFrom("vehicles").select("version").where("vehicle_id", "=", vehicleId).executeTakeFirstOrThrow();
    const blocked = await owner.post(`/admin/vehicles/${vehicleId}/review`, { expectedVersion: car.version, decision: "blocked", note: "papers" });
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(200);
    await sim.tick();
    await sim.advance(60);
    await a.moveTo(PLACES.medborgar);
    expect((await a.command(tripId, "complete")).body.status).toBe("completed");
    expect((await a.get("/driver/profile")).body.onlineStatus).toBe("offline");
    await a.moveTo(PLACES.nearSergels);
    const next = await rider.book();
    await sim.tick();
    expect(await a.offerFor(next.tripId)).toBeUndefined();
    await rider.command(next.tripId, "cancel", { reasonCode: "plans_changed" });
    await sim.db.updateTable("vehicles").set({ status: "approved" }).where("vehicle_id", "=", vehicleId).execute();
  });

  it("a driver's reported cash cannot pass the fare, so the refund room stays the fare (finding P3-2)", async () => {
    const { tripId } = await bookAndAccept(sim, rider, a);
    const res = await completeAtDropoff(a, tripId, { cashCollected: { amountMinor: 100_000_000, currency: "SEK" } });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe("cash_above_fare");
    expect(res.body.message).toBe("At most 217,00 kr is collected in cash on this trip."); // BQ-O17
    // The exact fare (what the driver app's complete sends by default) completes.
    const ok = await a.command(tripId, "complete", { cashCollected: { amountMinor: 21700, currency: "SEK" } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const version = (await owner.trip(tripId)).version;
    const refund = await owner.tripCommand(tripId, "refund", { expectedVersion: version, amount: { amountMinor: 21700 + 1, currency: "SEK" }, reason: "x" });
    expect(refund.body.reason).toBe("refund_too_large");
  });
});
