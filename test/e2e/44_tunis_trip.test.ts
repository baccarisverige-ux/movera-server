import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prepareTestWeek } from "../../src/testWeek.js";
import { fakeOsrm, Sim, type Admin, type Driver, type Json, type Rider } from "./harness.js";

/**
 * Owner 2026-11-10 ("Make test check all trip process in Tunisia"): one whole cash trip in Grand Tunis (TN-TC, TND with
 * 3 decimals) through the three apps, the way tools/livecheck/tunis_trip.mjs runs it on staging. The zone is opened
 * by the admin, then the server's start step runs again (as on staging's restart): the test drivers get TN-TC and
 * the sample TN settings are published.
 */

const TUNIS = { lat: 36.8065, lng: 10.1815 };
const PICKUP = { address: "Avenue Habib Bourguiba, Tunis", lat: 36.8008, lng: 10.18 };
const DROPOFF = { address: "Aéroport Tunis-Carthage", lat: 36.851, lng: 10.2272 };
const STEP = 50; // TND prices in 50 millimes (src/config/seedConfig.ts)

let sim: Sim;
let osrm: Awaited<ReturnType<typeof fakeOsrm>>;
let rider: Rider;
let driver: Driver;
let owner: Admin;

const tnd = (m: Json | undefined) => {
  expect(m).toMatchObject({ currency: "TND", amountMinor: expect.any(Number) });
  expect(Number.isInteger(m!["amountMinor"])).toBe(true);
};
const amountsIn = (o: unknown, out: Json[] = []): Json[] => {
  if (o && typeof o === "object") {
    if ("amountMinor" in o && "currency" in o) out.push(o as Json);
    else for (const v of Object.values(o)) amountsIn(v, out);
  }
  return out;
};

beforeAll(async () => {
  osrm = await fakeOsrm({ distance: 7500, duration: 900 });
  sim = await Sim.start({ osrmUrl: osrm.url });
  owner = await sim.owner();
  const zone = ((await owner.get("/admin/zones")).body["zones"] as Json[]).find((z) => z["zoneId"] === "TN-TC")!;
  const opened = await owner.post("/admin/zones/TN-TC/open", { expectedVersion: zone["version"] });
  if (opened.status !== 200) throw new Error(`open TN-TC ${opened.status} ${JSON.stringify(opened.body)}`);
  // The server's start step again: drivers in every open zone, sample settings for the new zone.
  await prepareTestWeek(sim.db, sim.env, { info: () => undefined }, { now: sim.clock.now });
  rider = await sim.rider(0);
  driver = await sim.driver(1, TUNIS);
});
afterAll(async () => {
  await sim.stop();
  await osrm.close();
});

describe("Grand Tunis: quote → cash trip → receipt, earnings, admin, tip, ratings (all TND)", () => {
  it("runs the whole trip in TND with 3-decimal amounts on the price step", async () => {
    expect(((await driver.get("/driver/profile")).body["zoneIds"] as string[])).toContain("TN-TC");
    const zones = (await rider.get("/rider/zones?country=TN")).body["zones"] as Json[];
    expect(zones.find((z) => z["zoneId"] === "TN-TC")).toMatchObject({ currency: "TND", open: true, names: { fr: "Grand Tunis" } });

    const quoted = await rider.quote({ pickup: PICKUP, dropoff: DROPOFF, categoryIds: ["economy"] });
    expect(quoted.status, JSON.stringify(quoted.body)).toBe(201);
    expect(quoted.body["zoneId"]).toBe("TN-TC");
    const all = amountsIn(quoted.body);
    expect(all.length).toBeGreaterThan(0);
    for (const m of all) tnd(m);
    const quote = quoted.body["quotes"][0];
    expect(quote.total.amountMinor % STEP).toBe(0);

    const feed = await driver.offerFeed();
    const booked = await rider.post("/trips", { quoteId: quote.quoteId, categoryId: "economy", pickup: PICKUP, dropoff: DROPOFF, stops: [], kind: "live", paymentMethod: "cash" });
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    const tripId = booked.body["tripId"] as string;
    expect(booked.body).toMatchObject({ status: "searching", zoneId: "TN-TC", fare: quote.total });
    const riderEvents = await rider.events(tripId);
    await sim.tick();

    const offered = await feed.waitFor((e) => e.data["offer"]?.["tripId"] === tripId);
    const offer = offered.data["offer"];
    tnd(offer.driverEarnings);
    const accepted = await driver.accept(offer);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(await riderEvents.reach("accepted")).not.toHaveProperty("driverEarnings");

    for (const [path, status] of [["head-to-pickup", "driver_to_pickup"], ["arrive", "arrived"], ["board", "rider_onboard"], ["start", "in_trip"]] as const) {
      if (path === "arrive") await driver.moveTo(PICKUP);
      const res = await driver.command(tripId, path);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body["status"]).toBe(status);
    }
    for (const at of [{ lat: 36.82, lng: 10.2 }, { lat: 36.842, lng: 10.219 }, DROPOFF]) {
      await sim.advance(300);
      await driver.moveTo(at);
    }

    const preview = (await driver.get(`/driver/trips/${tripId}/complete-preview`)).body;
    tnd(preview["cashDue"]);
    expect(preview["cashDue"].amountMinor % STEP).toBe(0);
    const done = await driver.command(tripId, "complete", { previewId: preview["previewId"], cashCollected: preview["cashDue"] });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ status: "completed", fare: preview["cashDue"] });
    const fare = done.body["fare"] as Json;
    const earnings = done.body["driverEarnings"] as Json;
    tnd(fare);
    tnd(earnings);
    expect(fare["amountMinor"] % STEP).toBe(0);

    // Rider: cash captured, receipt in TND whose lines add up to the total.
    const seen = await rider.trip(tripId);
    expect(seen).toMatchObject({ status: "completed", paymentMethod: "cash", fare });
    expect(seen).not.toHaveProperty("driverEarnings");
    const receipt = (await rider.get(`/trips/${tripId}/receipt`)).body;
    expect(receipt).toMatchObject({ tripId, zoneId: "TN-TC", country: "TN", currency: "TND", paymentMethod: "cash", total: fare, cashPaid: fare });
    const lines = receipt["fareLines"] as Array<{ amount: Json }>;
    for (const l of lines) tnd(l.amount);
    expect(lines.reduce((s, l) => s + Number(l.amount["amountMinor"]), 0)).toBe(fare["amountMinor"]);
    expect((await driver.get(`/driver/trips/${tripId}/receipt`)).body).toMatchObject({ currency: "TND", total: fare });

    // Driver: the trip in the TND ledger and the day report.
    const entry = await sim.db.selectFrom("earnings_entries").selectAll().where("trip_id", "=", tripId).where("kind", "=", "trip").executeTakeFirstOrThrow();
    expect(Number(entry.amount_minor)).toBe(earnings["amountMinor"]);
    expect(Number(entry.cash_minor)).toBe(fare["amountMinor"]);
    const driverView = await driver.trip(tripId);
    const pickupPay = driverView["pickupPay"]?.amountMinor ?? 0;
    const [day] = (await driver.get("/driver/earnings?period=day&currency=TND")).body["periods"];
    // v0.18.82 S5 J5 (contract.json#moneyBase.commission): the trip's one commission, pickup pay out (was fare − earnings).
    expect(day).toMatchObject({ tripCount: 1, gross: fare, cashCollected: fare, commission: { amountMinor: fare["amountMinor"] - earnings["amountMinor"] - pickupPay, currency: "TND" } });
    expect(day.commission).toEqual(driverView["commission"]);
    expect(day.net).toEqual({ amountMinor: earnings["amountMinor"] + pickupPay, currency: "TND" });

    // Admin: the trip in TN-TC, completed, the same money.
    const list = (await owner.get("/admin/trips?zoneId=TN-TC&status=completed")).body["items"] as Json[];
    expect(list.find((t) => t["tripId"] === tripId)).toMatchObject({ status: "completed", zoneId: "TN-TC", fare });
    expect(await owner.trip(tripId)).toMatchObject({ status: "completed", zoneId: "TN-TC", fare, driverEarnings: earnings });

    // Tip 1 DT, 100 % to the driver; both rate; nobody is left on a trip.
    const tip = await rider.post(`/trips/${tripId}/tip`, { amount: { amountMinor: 1000, currency: "TND" }, method: "cash" });
    expect(tip.status, JSON.stringify(tip.body)).toBe(201);
    expect(tip.body).toMatchObject({ amount: { amountMinor: 1000, currency: "TND" }, driverShare: { amountMinor: 1000, currency: "TND" } });
    expect((await rider.post(`/trips/${tripId}/rating`, { stars: 5 })).status).toBeLessThan(300);
    expect((await driver.post(`/trips/${tripId}/rating`, { stars: 5 })).status).toBeLessThan(300);
    expect((await rider.get("/rider/trips/active")).status).toBe(204);
    expect((await driver.get("/driver/profile")).body["onlineStatus"]).toBe("online");
  });
});
