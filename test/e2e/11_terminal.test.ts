import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bookAndAccept, drive, expiredBookedRide, fakeOsrm, PLACES, Sim, type Admin, type Driver, type Json, type Rider } from "./harness.js";

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

const TERMINAL = ["completed", "cancelled_by_rider", "cancelled_by_driver", "cancelled_by_admin", "no_show", "expired"];

/** Every command any app or the admin panel can send; none may bring a finished trip back. */
async function tryEverything(tripId: string, driver: Driver | null, offer: Json | null): Promise<void> {
  const before = await owner.trip(tripId);
  const v = before.version;
  const rejected = (res: { status: number; body: Json }, what: string) => {
    expect(res.status, `${what} on ${before.status}: ${JSON.stringify(res.body)}`).toBeGreaterThanOrEqual(400);
    expect(res.status, what).not.toBe(500);
  };
  for (const [path, body] of [
    ["cancel", { reasonCode: "plans_changed" }],
    ["raise-price", { increase: { amountMinor: 1000, currency: "SEK" } }],
    ["keep-waiting", { answer: "wait" }],
    ["end-early", { reasonCode: "plans_changed" }],
  ] as const) rejected(await rider.post(`/trips/${tripId}/${path}`, { expectedVersion: v, ...body }), `rider ${path}`);
  for (const d of [driver, a, b].filter((x): x is Driver => x !== null)) {
    for (const path of ["head-to-pickup", "arrive", "board", "start", "complete", "no-show", "cancel"]) {
      rejected(await d.post(`/trips/${tripId}/${path}`, { expectedVersion: v, reasonCode: path === "no-show" ? "rider_no_show" : "rider_requested_cancel" }), `driver ${path}`);
    }
  }
  if (offer && driver) rejected(await driver.accept(offer), "accept an old offer");
  for (const [path, body] of [
    ["assign", { driverId: b.id }],
    ["radar-group", { driverIds: [a.id, b.id] }],
    ["reassign", { reasonCode: "admin_operational", note: "x" }],
    ["cancel", { reasonCode: "admin_other", note: "x" }],
    ["no-show", { note: "x" }],
    ["complete", { note: "x" }],
  ] as const) rejected(await owner.tripCommand(tripId, path, { expectedVersion: v, ...body }), `admin ${path}`);
  await sim.advance(30);
  const after = await owner.trip(tripId);
  expect(after.status).toBe(before.status);
  expect(after.version).toBe(v);
  expect(after.fare).toEqual(before.fare);
  expect(TERMINAL).toContain(after.status);
  // No open offer for it, and the rider is free to book again.
  for (const d of [a, b]) expect(await d.offerFor(tripId)).toBeUndefined();
  expect((await rider.get("/rider/trips/active")).status).toBe(204);
}

describe("scenario 11: completed, cancelled and expired trips never become active again", () => {
  it("completed", async () => {
    const { tripId, driver } = await bookAndAccept(sim, rider, [a, b]);
    await drive(driver, tripId, "in_trip");
    await sim.advance(60);
    await driver.moveTo(PLACES.medborgar);
    expect((await driver.command(tripId, "complete")).body.status).toBe("completed");
    await tryEverything(tripId, driver, null);
    await driver.moveTo(PLACES.nearSergels);
  });

  it("cancelled by the rider after an offer went out", async () => {
    const { tripId } = await rider.book();
    await sim.tick();
    const holder = (await a.offerFor(tripId)) ? a : b;
    const offer = (await holder.offerFor(tripId))!;
    await rider.command(tripId, "cancel", { reasonCode: "plans_changed" });
    await tryEverything(tripId, holder, offer);
  });

  it("cancelled by the driver on board", async () => {
    const { tripId, driver } = await bookAndAccept(sim, rider, [a, b]);
    await drive(driver, tripId, "in_trip");
    await sim.advance(60);
    expect((await driver.command(tripId, "cancel", { reasonCode: "safety_concern_on_trip" })).body.status).toBe("cancelled_by_driver");
    await tryEverything(tripId, driver, null);
  });

  it("cancelled by an admin", async () => {
    const { tripId, driver } = await bookAndAccept(sim, rider, [a, b]);
    const v = (await owner.trip(tripId)).version;
    expect((await owner.tripCommand(tripId, "cancel", { expectedVersion: v, reasonCode: "admin_other", note: "test" })).body.status).toBe("cancelled_by_admin");
    await tryEverything(tripId, driver, null);
  });

  it("no-show", async () => {
    const { tripId, driver } = await bookAndAccept(sim, rider, [a, b]);
    await drive(driver, tripId, "arrived");
    await sim.advance(5 * 60 + 5);
    expect((await driver.command(tripId, "no-show", { reasonCode: "rider_no_show" })).body.status).toBe("no_show");
    await tryEverything(tripId, driver, null);
    await sim.db.updateTable("rider_fees").set({ status: "waived" }).where("status", "=", "owed").execute();
    // S5 J8 (debtModel.riderWallet): the unpaid fee is a negative wallet balance; the reset clears it too.
    await sim.db.updateTable("rider_wallets").set({ balance_minor: 0 }).where("balance_minor", "<", "0").execute();
    await sim.db.updateTable("riders").set({ outstanding_minor: 0, outstanding_source_trip_id: null }).execute();
  });

  it("expired", async () => {
    for (const d of [a, b]) {
      const p = (await d.get("/driver/profile")).body;
      await d.post("/driver/availability", { expectedVersion: p.version, onlineStatus: "offline" });
    }
    // v0.18.39 §63: a live search no longer ends by itself; a booked ride with no driver expires at pickup + 15 min (P17).
    const tripId = await expiredBookedRide(sim, rider);
    expect((await rider.trip(tripId)).status).toBe("expired");
    await a.goOnline(PLACES.nearSergels);
    await b.goOnline(PLACES.odenplan);
    await tryEverything(tripId, null, null);
  });
});
