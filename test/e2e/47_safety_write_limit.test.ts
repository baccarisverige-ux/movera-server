import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bookAndAccept, Driver, fakeOsrm, PLACES, Sim, type Admin, type Rider } from "./harness.js";

/**
 * B1.22 (owner W1 Q82, 2026-11-11 "Yes"): the general write limit (contract.json#rateLimit) never refuses a signed-in
 * SOS, ride-check answer or trip cancel (rider, driver, admin), and the apps' telemetry lines (logs, analytics, crash
 * reports) count against their own budget, so a crash loop cannot use up the writes an SOS needs. Every other write
 * still counts. The budget here is the production one: 120 writes per user per minute.
 */

const BUDGET = 120;
let sim: Sim;
let osrm: Awaited<ReturnType<typeof fakeOsrm>>;
let rider: Rider;
let a: Driver;
let dispatcher: Admin;

const GPS = { lat: 59.3331, lng: 18.0651, accuracyM: 8, at: "2026-10-27T10:00:30Z" };

/** Plain writes (an unknown route: 404, but counted) until the caller's budget answers 429. */
async function useUpWrites(who: Rider | Driver | Admin): Promise<number> {
  for (let n = 1; n <= BUDGET + 5; n++) {
    const res = await who.post("/limit-probe", {});
    if (res.status === 429) return n;
  }
  throw new Error("the write limit never answered 429");
}

beforeAll(async () => {
  osrm = await fakeOsrm({ distance: 8000, duration: 1080 });
  sim = await Sim.start({ osrmUrl: osrm.url, env: { RATE_LIMIT_WRITES_PER_USER_PER_MINUTE: String(BUDGET) } });
  rider = await sim.rider(0);
  a = await sim.driver(1, PLACES.nearSergels);
  dispatcher = await sim.admin("dispatcher", ["Z001"]);
});
afterAll(async () => {
  await sim.stop();
  await osrm.close();
});
beforeEach(async () => {
  // A new one-minute window for every caller.
  await sim.advance(61);
  await a.moveTo(PLACES.nearSergels);
});

afterEach(async () => {
  // Each test ends with no open trip, whatever it proved (a fresh window first, so the clean-up is never refused).
  await sim.advance(61);
  const active = await rider.get("/rider/trips/active");
  const tripId = active.status === 200 ? (active.body["tripId"] as string | undefined) : undefined;
  if (tripId) {
    const version = (await dispatcher.get(`/admin/trips/${tripId}`)).body["version"];
    await dispatcher.post(`/admin/trips/${tripId}/cancel`, { expectedVersion: version, reasonCode: "admin_other", note: "clean-up" });
  }
});

describe("B1.22: safety writes are never refused by the write limit", () => {
  it("rider and driver: SOS and ride-check answers pass after the budget is used up; other writes stay refused", async () => {
    const { tripId } = await bookAndAccept(sim, rider, a);
    for (const who of [rider, a] as const) {
      const side = who instanceof Driver ? "driver" : "rider";
      expect(await useUpWrites(who)).toBeLessThanOrEqual(BUDGET + 1);
      const sos = await who.post(`/${side}/trips/${tripId}/sos`, { at: sim.clock.now.toISOString(), position: GPS });
      expect(sos.status, JSON.stringify(sos.body)).toBe(200);
      const check = await who.post(`/${side}/trips/${tripId}/ride-check`, { checkId: `rc-b122-${side}`, trigger: "long_stop", at: sim.clock.now.toISOString(), answer: "ok", position: GPS });
      expect(check.status, JSON.stringify(check.body)).toBe(200);
      // Every other write still counts and is refused until the window ends.
      const other = await who.post("/limit-probe", {});
      expect(other.status).toBe(429);
      expect(other.body).toMatchObject({ code: "rate_limited", reason: "too_many_requests" });
    }
    expect((await rider.post(`/trips/${tripId}/cancel-reason`, { reasonCode: "plans_changed" })).status).toBe(429);
  });

  it("rider cancel (and the /rides alias) passes after the budget is used up", async () => {
    const { tripId } = await bookAndAccept(sim, rider, a);
    await useUpWrites(rider);
    const version = (await rider.trip(tripId))["version"];
    const res = await rider.post(`/rides/${tripId}/cancel`, { expectedVersion: version, reasonCode: "plans_changed" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body["status"]).toBe("cancelled_by_rider");
  });

  it("driver cancel passes after the budget is used up", async () => {
    const { tripId } = await bookAndAccept(sim, rider, a);
    await useUpWrites(a);
    const res = await a.command(tripId, "cancel", { reasonCode: "rider_not_at_pickup" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it("admin trip cancel passes after the budget is used up", async () => {
    const { tripId } = await bookAndAccept(sim, rider, a);
    await useUpWrites(dispatcher);
    const version = (await dispatcher.get(`/admin/trips/${tripId}`)).body["version"];
    const res = await dispatcher.post(`/admin/trips/${tripId}/cancel`, { expectedVersion: version, reasonCode: "admin_other", note: "B1.22" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it("telemetry lines have their own budget: a crash loop does not use up the writes a later SOS needs", async () => {
    const { tripId } = await bookAndAccept(sim, rider, a);
    const statuses: number[] = [];
    for (let i = 0; i < BUDGET; i++) statuses.push((await rider.post("/telemetry/crashes", { error: `StateError ${i}`, stack: "at main.dart:1", app: "rider", kind: "error" })).status);
    expect(statuses.every((status) => status === 202)).toBe(true);
    // The telemetry budget (per address) is used up; its own refusal, not the general one.
    const over = await rider.post("/telemetry/logs", { level: "error", event: "again" });
    expect(over.status).toBe(429);
    expect(over.body).toMatchObject({ code: "rate_limited", reason: "telemetry_too_many" });
    // The rider's write budget is untouched: SOS and an ordinary write both pass.
    const sos = await rider.post(`/rider/trips/${tripId}/sos`, { at: sim.clock.now.toISOString(), position: GPS });
    expect(sos.status, JSON.stringify(sos.body)).toBe(200);
    expect((await rider.post("/limit-probe", {})).status).toBe(404);
  });

  it("without a valid token an SOS still counts against the address budget (no free anonymous writes)", async () => {
    let refused = 0;
    for (let i = 0; i < 700 && refused === 0; i++) {
      const res = await sim.request("POST", "/rider/trips/trp_none/sos", undefined, { at: sim.clock.now.toISOString() });
      if (res.status === 429) refused = i + 1;
    }
    expect(refused).toBeGreaterThan(0);
  });
});
