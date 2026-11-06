import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { expiredBookedRide, fakeOsrm, PLACES, Sim, type Admin, type Driver, type Rider } from "./harness.js";

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
  const active = await rider.get("/rider/trips/active");
  if (active.status === 200) await rider.command(active.body.tripId, "cancel", { reasonCode: "plans_changed" });
  await sim.advance(5);
  await a.moveTo(PLACES.nearSergels);
  await b.moveTo(PLACES.odenplan);
});

const sek = (amountMinor: number) => ({ amountMinor, currency: "SEK" });
const raise = (tripId: string, amountMinor: number, currency = "SEK") => rider.command(tripId, "raise-price", { increase: { amountMinor, currency } });

describe("scenario 6: the rider raises the price (N4)", () => {
  it("while searching: the fare and the driver's earnings grow by the raise; Movera's share is unchanged", async () => {
    const { tripId, trip } = await rider.book();
    const before = await owner.trip(tripId);
    const res = await raise(tripId, 5000);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ status: "searching", version: trip.version + 1, fare: sek(21700 + 5000) });
    expect(res.body.fareLines).toEqual(expect.arrayContaining([{ code: "rider_raise", amount: sek(5000) }]));
    const after = await owner.trip(tripId);
    expect(after.driverEarnings).toEqual(sek(before.driverEarnings.amountMinor + 5000));
    expect(after.fare.amountMinor - after.driverEarnings.amountMinor).toBe(before.fare.amountMinor - before.driverEarnings.amountMinor);
  });

  it("while offered: the open offer is withdrawn and a new one at the new price goes out; a driver who declined is asked again", async () => {
    const { tripId } = await rider.book();
    await sim.tick();
    const holder = (await a.offerFor(tripId)) ? a : b;
    const first = (await holder.offerFor(tripId))!;
    expect((await holder.decline(first)).status).toBe(200);
    await sim.tick();
    const other = holder === a ? b : a;
    const second = await other.offerFor(tripId);
    expect(second).toBeDefined();
    expect((await rider.trip(tripId)).status).toBe("offered");
    const res = await raise(tripId, 10000);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe("searching");
    // The old offer is gone; accepting it is refused.
    expect((await other.accept(second!)).status).toBe(409);
    await sim.tick();
    const fresh = [await a.offerFor(tripId), await b.offerFor(tripId)].filter(Boolean);
    expect(fresh.length).toBeGreaterThan(0);
    for (const offer of fresh) expect(offer!.driverEarnings.amountMinor).toBe(second!.driverEarnings.amountMinor + 10000);
    // Keep declining until the driver who declined first is offered again at the new price.
    let askedAgain = await holder.offerFor(tripId);
    for (let i = 0; i < 6 && !askedAgain; i++) {
      const out = await other.offerFor(tripId);
      if (out) await other.decline(out);
      await sim.advance(5);
      askedAgain = await holder.offerFor(tripId);
    }
    expect(askedAgain).toBeDefined();
    const won = await holder.accept(askedAgain!);
    expect(won.body).toMatchObject({ status: "accepted", fare: sek(21700 + 10000) });
  });

  it("at most 2 × the quoted fare; another currency or nothing is refused", async () => {
    const { tripId } = await rider.book();
    expect((await raise(tripId, 21700 + 100)).body).toMatchObject({ code: "invalid_request", reason: "raise_too_high" });
    expect((await raise(tripId, 100, "EUR")).body.reason).toBe("currency_mismatch");
    expect((await raise(tripId, 0)).status).toBe(400);
    // Exactly the cap is allowed, then nothing more.
    expect((await raise(tripId, 21700)).body.fare).toEqual(sek(43400));
    expect((await raise(tripId, 100)).body.reason).toBe("raise_too_high");
  });

  it("after the search expired, or once accepted, raising is refused (409 invalid_transition)", async () => {
    const { tripId } = await rider.book();
    await sim.tick();
    const holder = (await a.offerFor(tripId)) ? a : b;
    await holder.accept((await holder.offerFor(tripId))!);
    expect((await raise(tripId, 5000)).body).toMatchObject({ code: "invalid_transition", projection: { status: "accepted" } });
    await rider.command(tripId, "cancel", { reasonCode: "plans_changed" });

    // No driver: v0.18.39 §63, a live search never runs out; a booked ride with no driver expires at pickup + 15 min (P17).
    for (const d of [a, b]) {
      const profile = (await d.get("/driver/profile")).body;
      await d.post("/driver/availability", { expectedVersion: profile.version, onlineStatus: "offline" });
    }
    try {
      const lonely = { tripId: await expiredBookedRide(sim, rider) };
      expect((await rider.trip(lonely.tripId)).status).toBe("expired");
      const late = await raise(lonely.tripId, 5000);
      expect(late.status).toBe(409);
      expect(late.body).toMatchObject({ code: "invalid_transition", projection: { status: "expired" } });
    } finally {
      await a.goOnline(PLACES.nearSergels);
      await b.goOnline(PLACES.odenplan);
    }
  });

  it("a quote of 0 cannot be published: every ride starts at a real price (admin demo A-O2, contract v0.6.0; was finding P3-1)", async () => {
    // The admin demo's publish check (validateZoneBook) refuses a 0 base fare, so the 0-quote case of P3-1 cannot happen.
    await expect(
      sim.publish(owner, "pricing", "Z001", (doc) => {
        const free = { ...doc["categories"]["economy"], base: sek(0), perKm: sek(0), perMin: sek(0), minimum: sek(0), appFeePct: 0 };
        return { ...doc, categories: { ...doc["categories"], economy: free } };
      }),
    ).rejects.toThrow(/base fare must be above 0/);
  });
});
