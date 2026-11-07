import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fakeOsrm, PLACES, Sim, type Driver, type Rider, type Stream } from "./harness.js";

/**
 * v0.18.51 §73 (S4 ISSUE 1, contract.json#driverReservationsLive.when): a booked ride's driver_reservations_changed goes
 * to the zone's driver streams only when the ride is created, accepted, released, cancelled, rescheduled or started —
 * never on each location fix (the S4 audit counted ~85 per ride: every driver app re-read its lists every 2 s).
 * Proof first written in Rules scratchpad s4/wt/test/e2e/90_s4_lifecycle_audit.test.ts.
 */
let sim: Sim;
let osrm: Awaited<ReturnType<typeof fakeOsrm>>;
let rider: Rider;
let a: Driver;
let b: Driver;

beforeAll(async () => {
  osrm = await fakeOsrm({ distance: 8000, duration: 1080 });
  sim = await Sim.start({ osrmUrl: osrm.url, now: new Date("2026-11-05T05:00:00Z") });
  rider = await sim.rider(0);
  a = await sim.driver(1, PLACES.nearSergels);
  b = await sim.driver(2, PLACES.odenplan);
});
afterAll(async () => {
  await sim.stop();
  await osrm.close();
});
beforeEach(async () => {
  await sim.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("status", "not in", ["completed", "cancelled_by_rider", "cancelled_by_admin", "expired", "cancelled_by_system", "no_show", "failed", "cancelled_by_driver"]).execute();
  await sim.db.updateTable("drivers").set({ online_status: "online" }).where("online_status", "=", "on_trip").execute();
  await jump(6 * 3600);
});
async function jump(seconds: number) {
  sim.clock.now = new Date(sim.clock.now.getTime() + seconds * 1000);
  for (const d of [a, b]) if (d.position) await d.heartbeat();
  await sim.tick();
}
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
const hints = (s: Stream, tripId: string) => s.events.filter((e) => e.data.kind === "driver_reservations_changed" && e.data.tripId === tripId).length;

describe("v0.18.51 §73 driver_reservations_changed only at the listed changes", () => {
  it("one booked ride from booking to completed: hints at created, accepted, started — none for location fixes or later steps", async () => {
    await a.moveTo(PLACES.nearSergels);
    // A driver of the zone who has nothing to do with this ride, and the driver who takes it.
    const bystander = await sim.stream("/driver/config/stream?zoneId=Z001", b.token);
    const named = await sim.stream("/driver/config/stream?zoneId=Z001", a.token);
    const at = new Date(sim.clock.now.getTime() + 120 * 60_000).toISOString();
    const quote = (await rider.quote({ categoryIds: ["economy"], kind: "scheduled", scheduledAt: at })).body.quotes[0];
    const made = await rider.post("/trips", { quoteId: quote.quoteId, categoryId: "economy", pickup: PLACES.sergels, dropoff: PLACES.medborgar, stops: [], kind: "scheduled", scheduledAt: at, paymentMethod: "cash" });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const tripId = made.body.tripId as string;
    await settle();
    const created = hints(bystander, tripId);
    expect(created, "created").toBeGreaterThanOrEqual(1);
    expect((await a.post(`/driver/reservations/${tripId}/accept`, {})).status).toBe(200);
    await settle();
    const accepted = hints(bystander, tripId);
    expect(accepted, "accepted").toBeGreaterThan(created);
    // The leave-time and reminder checks run while he holds it (no list change).
    await jump(2 * 60 + 5);
    await jump((Date.parse(at) - sim.clock.now.getTime()) / 1000 - 60 * 60 + 1);
    const leaveAt = Date.parse((await a.get(`/trips/${tripId}`)).body.reservation?.leaveAt ?? at);
    await jump(Math.max(1, (leaveAt - sim.clock.now.getTime()) / 1000 + 5));
    await settle();
    const held = hints(bystander, tripId);
    expect((await a.post(`/driver/reservations/${tripId}/start`, {})).status).toBe(200);
    await sim.tick();
    await settle();
    const started = hints(bystander, tripId);
    expect(started, "started").toBe(held + 1);
    // From here on: ETA ticks / location fixes on the way, arrive, board, start, the drive, complete.
    for (let i = 0; i < 10; i++) {
      await jump(30);
      await a.heartbeat();
    }
    await a.moveTo(PLACES.sergels);
    expect((await a.command(tripId, "arrive")).status).toBe(200);
    let board = await a.command(tripId, "board");
    if (board.status !== 200) {
      await jump(Math.max(1, (Date.parse(at) - sim.clock.now.getTime()) / 1000 + 5));
      board = await a.command(tripId, "board");
    }
    expect(board.status, JSON.stringify(board.body)).toBe(200);
    expect((await a.command(tripId, "start")).status).toBe(200);
    for (let i = 0; i < 10; i++) {
      await sim.advance(60);
      await a.heartbeat();
    }
    await a.moveTo(PLACES.medborgar);
    await sim.advance(10 * 60);
    await a.moveTo(PLACES.medborgar);
    expect((await a.command(tripId, "complete")).status).toBe(200);
    await settle();
    const locations = (await sim.db.selectFrom("trip_events").select("kind").where("trip_id", "=", tripId).execute()).filter((e) => e.kind === "location").length;
    expect(locations, "the ride had location events").toBeGreaterThan(5);
    expect(hints(bystander, tripId), `bystander hints after start (location events: ${locations})`).toBe(started);
    expect(hints(named, tripId), "the named driver gets the same, no more").toBe(started);
    expect(started, "contract: only created/accepted/released/cancelled/rescheduled/started").toBeLessThanOrEqual(6);
    bystander.close();
    named.close();
  });

  it("released and cancelled still reach the zone's drivers", async () => {
    const bystander = await sim.stream("/driver/config/stream?zoneId=Z001", b.token);
    const at = new Date(sim.clock.now.getTime() + 180 * 60_000).toISOString();
    const quote = (await rider.quote({ categoryIds: ["economy"], kind: "scheduled", scheduledAt: at })).body.quotes[0];
    const made = await rider.post("/trips", { quoteId: quote.quoteId, categoryId: "economy", pickup: PLACES.sergels, dropoff: PLACES.medborgar, stops: [], kind: "scheduled", scheduledAt: at, paymentMethod: "cash" });
    const tripId = made.body.tripId as string;
    expect((await a.post(`/driver/reservations/${tripId}/accept`, {})).status).toBe(200);
    await settle();
    const before = hints(bystander, tripId);
    const released = await a.command(tripId, "cancel", { reasonCode: (await scheduledReason()) });
    expect(released.status, JSON.stringify(released.body)).toBe(200);
    expect(released.body.status).toBe("requested");
    await settle();
    expect(hints(bystander, tripId), "released").toBe(before + 1);
    const cancelled = await rider.command(tripId, "cancel", { reasonCode: "plans_changed" });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    await settle();
    expect(hints(bystander, tripId), "cancelled").toBe(before + 2);
    bystander.close();
  });
});

async function scheduledReason(): Promise<string> {
  const cfg = (await a.get("/driver/config?zoneId=Z001")).body;
  const codes = (cfg.cancelReasons?.scheduled ?? []) as string[];
  return codes[0] ?? "vehicle_problem";
}
