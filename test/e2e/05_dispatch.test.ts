import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fakeOsrm, PLACES, Sim, type Admin, type Driver, type Rider } from "./harness.js";

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
beforeEach(async () => {
  await sim.advance(5);
  await a.moveTo(PLACES.nearSergels);
  await b.moveTo(PLACES.odenplan);
});

afterEach(async () => {
  // A case that failed half-way leaves no ride going for the next one.
  const active = await rider.get("/rider/trips/active");
  if (active.status === 200) await rider.command(active.body.tripId, "cancel", { reasonCode: "plans_changed" });
});

async function setOnline(driver: Driver, online: boolean) {
  const profile = (await driver.get("/driver/profile")).body;
  const res = await driver.post("/driver/availability", { expectedVersion: profile.version, onlineStatus: online ? "online" : "offline", location: driver.fix(PLACES.odenplan) });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

describe("scenario 5: decline, offer timeout, reassignment, no drivers, search expiry", () => {
  it("A declines: the next driver is offered the trip at once and accepts", async () => {
    const { tripId } = await rider.book();
    await sim.tick();
    const first = await a.offerFor(tripId);
    expect(first).toBeDefined();
    expect(await b.offerFor(tripId)).toBeUndefined();
    expect((await a.decline(first!)).status).toBe(200);
    await sim.tick();
    const second = await b.offerFor(tripId);
    expect(second).toBeDefined();
    expect((await b.accept(second!)).body).toMatchObject({ status: "accepted", driver: { driverId: b.id } });
    await rider.command(tripId, "cancel", { reasonCode: "plans_changed" });
  });

  it("the offered driver lets the 15 s exclusive offer run out: it expires, accepting it later is refused, the other gets the trip", async () => {
    const { tripId } = await rider.book();
    await sim.tick();
    const holders = [];
    for (const d of [a, b]) if (await d.offerFor(tripId)) holders.push(d);
    // Exclusive: exactly one driver holds an offer.
    expect(holders).toHaveLength(1);
    const first = holders[0]!;
    const other = first === a ? b : a;
    const feed = await first.offerFeed();
    const offer = (await first.offerFor(tripId))!;
    expect(Date.parse(offer.expiresAt) - sim.clock.now.getTime()).toBe(15_000);
    await sim.advance(16);
    await feed.waitFor((e) => e.data["offer"]?.["offerId"] === offer.offerId && e.data["kind"] !== "offer_created");
    expect(await first.offerFor(tripId)).toBeUndefined();
    const late = await first.accept(offer);
    expect(late.status).toBe(409);
    expect((await rider.trip(tripId)).status).not.toBe("accepted");
    const next = await other.offerFor(tripId);
    expect(next).toBeDefined();
    expect((await other.accept(next!)).body).toMatchObject({ status: "accepted", driver: { driverId: other.id } });
    feed.close();
  });

  it("no driver online: the rider waits through the steps; the sample document ends the search at 8 min as busy", async () => {
    await setOnline(a, false);
    await setOnline(b, false);
    try {
      const { tripId } = await rider.book();
      const events = await rider.events(tripId);
      await sim.advance(3 * 60 + 5);
      expect((await rider.trip(tripId)).searchStep).toMatchObject({ kind: "alert_admin" });
      await sim.advance(2 * 60);
      expect((await rider.trip(tripId)).searchStep).toMatchObject({ kind: "keep_waiting" });
      await sim.advance(3 * 60);
      const ended = await rider.trip(tripId);
      expect(ended.status).toBe("expired");
      expect(ended.searchStep).toMatchObject({ kind: "busy" });
      await events.reach("expired");
      events.close();
    } finally {
      await setOnline(a, true);
      await setOnline(b, true);
    }
  });

  it("with only the search end (no busy step), the search expires after exactly 10 minutes, not before", async () => {
    await sim.publish(owner, "dispatch", "Z001", (doc) => ({ ...doc, waiting: doc["waiting"].map((w: { kind: string }) => (w.kind === "busy" || w.kind === "keep_waiting" ? { ...w, on: false } : w)) }));
    await setOnline(a, false);
    await setOnline(b, false);
    try {
      const { tripId } = await rider.book();
      await sim.advance(10 * 60 - 5);
      expect(["searching", "offered"]).toContain((await rider.trip(tripId)).status);
      await sim.advance(10);
      const ended = await rider.trip(tripId);
      expect(ended.status).toBe("expired");
      // An expired trip is not active: the rider can book again.
      expect((await rider.get("/rider/trips/active")).status).toBe(204);
      // Keep waiting on an expired trip is refused.
      const late = await rider.command(tripId, "keep-waiting", { answer: "wait" });
      expect(late.status).toBe(409);
    } finally {
      await setOnline(a, true);
      await setOnline(b, true);
    }
  });

  it("keep waiting (+3 min) moves the end", async () => {
    await sim.publish(owner, "dispatch", "Z001", (doc) => ({ ...doc, waiting: doc["waiting"].map((w: { kind: string }) => (w.kind === "busy" ? { ...w, on: false } : { ...w, on: w.kind === "keep_waiting" || w.kind === "alert_admin" })) }));
    await setOnline(a, false);
    await setOnline(b, false);
    try {
      const { tripId } = await rider.book();
      await sim.advance(5 * 60 + 5);
      expect((await rider.trip(tripId)).searchStep).toMatchObject({ kind: "keep_waiting" });
      expect((await rider.command(tripId, "keep-waiting", { answer: "wait" })).status).toBe(200);
      await sim.advance(5 * 60);
      expect(["searching", "offered"]).toContain((await rider.trip(tripId)).status);
      await sim.advance(3 * 60);
      expect((await rider.trip(tripId)).status).toBe("expired");
    } finally {
      await setOnline(a, true);
      await setOnline(b, true);
    }
  });
});
