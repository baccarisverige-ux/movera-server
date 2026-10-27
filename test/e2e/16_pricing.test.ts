import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { drive, fakeOsrm, PLACES, Sim, type Admin, type Driver, type Json, type Rider } from "./harness.js";

/**
 * Contract v0.6.0 pricing rework (owner 2026-10-27, the admin demo Pricing section): the quote prices what the
 * rider asked for (seats, airport, fixed route), the surge in force reaches the quote, the completed fare prices
 * the booked extras again, and publishing pricing keeps the app documents' waiting, no-show and pickup fee in step.
 */

let sim: Sim;
let osrm: Awaited<ReturnType<typeof fakeOsrm>>;
let rider: Rider;
let a: Driver;
let owner: Admin;

beforeAll(async () => {
  osrm = await fakeOsrm({ distance: 8000, duration: 1080 });
  sim = await Sim.start({ osrmUrl: osrm.url });
  rider = await sim.rider(0);
  a = await sim.driver(1, PLACES.nearSergels);
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
});

const sek = (amountMinor: number) => ({ amountMinor, currency: "SEK" });
const line = (fare: Json, code: string) => (fare["fareLines"] as Array<{ code: string; amount: unknown }>).find((l) => l.code === code);
const route = { pickup: PLACES.sergels, dropoff: PLACES.medborgar, stops: [] };
// Inside the ARN airport zone (migration 0005).
const ARLANDA = { address: "Arlanda", lat: 59.649, lng: 17.929 };

describe("pricing v0.6.0", () => {
  it("v0.7.1: an airport drop-off is decided by the server from the airport zones and charged again on the completed fare", async () => {
    await sim.publish(owner, "pricing", "Z001", (doc) => ({ ...doc, fees: { ...doc["fees"], airportDropoff: sek(3000) } }));
    // The rider's own flag no longer adds anything: Medborgarplatsen is not an airport.
    const flagged = (await rider.quote({ categoryIds: ["economy"], airportDropoff: true })).body["quotes"][0];
    expect(line(flagged, "airport")).toBeUndefined();
    expect(flagged.total).toEqual(sek(21700));

    const toArlanda = { pickup: PLACES.sergels, dropoff: ARLANDA, stops: [] };
    const quoted = await rider.quote({ ...toArlanda, categoryIds: ["economy"] });
    expect(quoted.status, JSON.stringify(quoted.body)).toBe(201);
    const quote = quoted.body["quotes"][0];
    // economy_plain (217 kr) + the 30 kr airport line + its 10 % app fee: 250 kr.
    expect(line(quote, "airport")).toEqual({ code: "airport", amount: sek(3000) });
    expect(quote.total).toEqual(sek(25000));

    const booked = await rider.post("/trips", { quoteId: quote.quoteId, categoryId: "economy", ...toArlanda, kind: "live", paymentMethod: "cash" });
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    const tripId = booked.body["tripId"];
    await sim.tick();
    const offer = await a.offerFor(tripId);
    expect(offer).toBeTruthy();
    expect((await a.accept(offer!)).status).toBe(200);
    await drive(a, tripId, "in_trip");
    await sim.advance(18 * 60);
    await a.moveTo(ARLANDA);
    const done = await a.command(tripId, "complete");
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.fare).toEqual(sek(25000));
    expect(line(done.body, "airport")).toEqual({ code: "airport", amount: sek(3000) });
    await sim.publish(owner, "pricing", "Z001", (doc) => ({ ...doc, fees: { ...doc["fees"], airportDropoff: sek(0) } }));
  });

  it("v0.7.1: a Child Seat trip always includes its one seat; a seat on another car type is refused; a fixed route prices only its category", async () => {
    await sim.publish(owner, "pricing", "Z001", (doc) => ({ ...doc, fixedRoutes: [{ id: "R1", from: "Sergels torg", to: "Medborgarplatsen", categoryId: "economy", price: sek(39900) }] }));
    const child = (await rider.quote({ categoryIds: ["child_seat"] })).body["quotes"][0];
    expect(line(child, "extras")).toEqual({ code: "extras", amount: sek(1500) });
    // The old seat counts change nothing on Child Seat (read for one release).
    const counted = (await rider.quote({ categoryIds: ["child_seat"], babySeats: 1, childSeats: 2 })).body["quotes"][0];
    expect(line(counted, "extras")).toEqual({ code: "extras", amount: sek(1500) });
    expect(counted.total).toEqual(child.total);
    const refused = await rider.quote({ categoryIds: ["economy"], childSeats: 1 });
    expect(refused.status).toBe(400);
    expect(refused.body.reason).toBe("seat_not_offered");
    expect((await rider.quote({ babySeats: 1 })).body.reason).toBe("seat_not_offered");
    const economy = (await rider.quote({ categoryIds: ["economy"] })).body["quotes"][0];
    expect(line(economy, "extras")).toBeUndefined();
    expect(economy.total).toEqual(sek(21700));

    const fixed = await rider.quote({ categoryIds: ["economy", "comfort"], fixedRouteId: "R1" });
    const [fe, fc] = fixed.body["quotes"];
    expect(line(fe, "fixed_route")).toEqual({ code: "fixed_route", amount: sek(39900) });
    expect(line(fe, "base")).toBeUndefined();
    expect(line(fc, "fixed_route")).toBeUndefined();
    expect(line(fc, "base")).toBeDefined();
    const mismatch = await rider.post("/trips", { quoteId: fe.quoteId, categoryId: "economy", ...route, kind: "live", paymentMethod: "cash" });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.reason).toBe("quote_mismatch");
    await sim.publish(owner, "pricing", "Z001", (doc) => ({ ...doc, fixedRoutes: [] }));
  });

  it("a scheduled surge window in force prices the quote, within the admin's maximum", async () => {
    const now = sim.clock.now.getTime();
    const window = { id: "s1", name: "Concert", multiplier: 1.5, startsAt: new Date(now - 3_600_000).toISOString(), endsAt: new Date(now + 3_600_000).toISOString() };
    await sim.publish(owner, "pricing", "Z001", (doc) => ({ ...doc, surge: { ...doc["surge"], scheduled: [window] } }));
    const surged = (await rider.quote({ categoryIds: ["economy"] })).body["quotes"][0];
    // economy_plain: ride part 197 kr × 0.5 = 98.50 kr surge.
    expect(surged).toMatchObject({ surgeMultiplier: 1.5, surge: { multiplier: 1.5, until: window.endsAt } });
    expect(line(surged, "surge")).toEqual({ code: "surge", amount: sek(9850) });

    await sim.publish(owner, "pricing", "Z001", (doc) => ({ ...doc, surge: { ...doc["surge"], maxMultiplier: 1.2, scheduled: [window] } }));
    expect((await rider.quote({ categoryIds: ["economy"] })).body["quotes"][0].surgeMultiplier).toBe(1.2);

    await sim.publish(owner, "pricing", "Z001", (doc) => ({ ...doc, surge: { ...doc["surge"], maxMultiplier: 3, scheduled: [{ ...window, endsAt: new Date(now - 60_000).toISOString() }] } }));
    const after = (await rider.quote({ categoryIds: ["economy"] })).body["quotes"][0];
    expect(after.surgeMultiplier).toBe(1);
    expect(after).not.toHaveProperty("surge");
    await sim.publish(owner, "pricing", "Z001", (doc) => ({ ...doc, surge: { ...doc["surge"], scheduled: [] } }));
  });

  it("publishing pricing updates the rider and driver documents' waiting, no-show fee and pickup fee", async () => {
    const riderBefore = (await rider.get("/rider/config?zoneId=Z001")).body;
    const driverBefore = (await a.get("/driver/config?zoneId=Z001")).body;
    await sim.publish(owner, "pricing", "Z001", (doc) => {
      const economy = doc["categories"]["economy"];
      return { ...doc, categories: { ...doc["categories"], economy: { ...economy, waiting: { ...economy.waiting, noShowFee: sek(7000) }, riderPickupFee: { live: sek(1500), reservation: null } } } };
    });
    const riderAfter = (await rider.get("/rider/config?zoneId=Z001")).body;
    const driverAfter = (await a.get("/driver/config?zoneId=Z001")).body;
    expect(riderAfter.version).toBe(riderBefore.version + 1);
    expect(driverAfter.version).toBe(driverBefore.version + 1);
    expect(riderAfter.waiting.noShowFee).toEqual(sek(7000));
    expect(riderAfter.waiting.byCategory.economy.noShowFee).toEqual(sek(7000));
    expect(driverAfter.waiting.byCategory.economy.noShowFee).toEqual(sek(7000));
    expect(riderAfter.pickupFee.byCategory.economy).toEqual({ live: sek(1500), reservation: null });
    expect(driverAfter.pickupPay.byCategory.economy.riderFee).toEqual({ live: sek(1500), reservation: null });
    // Everything else stays as published.
    expect(riderAfter.tips).toEqual(riderBefore.tips);
    expect(driverAfter.offers).toEqual(driverBefore.offers);
    // A later app publish starts from a draft that already has the pricing values.
    await sim.publish(owner, "rider_app_config", "Z001", (doc) => doc);
    expect((await rider.get("/rider/config?zoneId=Z001")).body.waiting.noShowFee).toEqual(sek(7000));
    await sim.publish(owner, "pricing", "Z001", (doc) => {
      const economy = doc["categories"]["economy"];
      return { ...doc, categories: { ...doc["categories"], economy: { ...economy, waiting: { ...economy.waiting, noShowFee: sek(6500) }, riderPickupFee: { live: null, reservation: null } } } };
    });
  });
});
