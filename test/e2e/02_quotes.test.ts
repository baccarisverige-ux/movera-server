import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { fakeOsrm, PLACES, Sim, type Rider } from "./harness.js";

const fares = JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/fares.json`, "utf8")) as { cases: Array<{ id: string; expect: { total: { amountMinor: number }; fareLines: unknown[] } }> };
const plain = fares.cases.find((c) => c.id === "economy_plain")!;

describe("scenario 2: quote, category, pickup and destination validation, route with and without OSRM", () => {
  describe("with Movera's OSRM (a fake one answering 8 km / 18 min)", () => {
    let sim: Sim;
    let osrm: Awaited<ReturnType<typeof fakeOsrm>>;
    let rider: Rider;
    beforeAll(async () => {
      osrm = await fakeOsrm({ distance: 8000, duration: 1080 });
      sim = await Sim.start({ osrmUrl: osrm.url });
      rider = await sim.rider(0);
    });
    afterAll(async () => {
      await sim.stop();
      await osrm.close();
    });

    it("prices every category from the zone's published pricing; economy matches fixtures/fares.json economy_plain", async () => {
      const res = await rider.quote();
      expect(res.status).toBe(201);
      expect(osrm.calls.some((c) => c.startsWith("/route/v1/driving/18.064900,59.332600;18.073500,59.314300"))).toBe(true);
      expect(res.body["zoneId"]).toBe("Z001");
      const economy = res.body["quotes"].find((q: { categoryId: string }) => q.categoryId === "economy");
      expect(economy.total).toEqual({ amountMinor: plain.expect.total.amountMinor, currency: "SEK" });
      expect(economy.fareLines).toEqual(plain.expect.fareLines);
      // The rider never sees the driver's share.
      expect(economy).not.toHaveProperty("driverEarnings");
      const stored = await sim.db.selectFrom("quotes").select(["route_source", "distance_meters", "driver_earnings_minor"]).where("quote_id", "=", economy.quoteId).executeTakeFirstOrThrow();
      expect(stored).toMatchObject({ route_source: "osrm", distance_meters: 8000, driver_earnings_minor: "15760" });
    });

    it("one category on request; an unknown category is refused", async () => {
      const one = await rider.quote({ categoryIds: ["premium"] });
      expect(one.body["quotes"].map((q: { categoryId: string }) => q.categoryId)).toEqual(["premium"]);
      const unknown = await rider.quote({ categoryIds: ["helicopter"] });
      expect(unknown.status).toBe(400);
      expect(unknown.body["reason"]).toBe("category_not_offered");
    });

    it("pickup outside every open zone: not available here; a bad coordinate or a missing destination: 400", async () => {
      const sea = await rider.quote({ pickup: PLACES.atSea });
      expect(sea.status).toBe(403);
      expect(sea.body["reason"]).toBe("service_not_available");
      const bad = await rider.quote({ pickup: { address: "x", lat: 123, lng: 18 } });
      expect(bad.status).toBe(400);
      expect(bad.body["reason"]).toBe("invalid_body");
      const noDropoff = await rider.post("/quotes", { pickup: PLACES.sergels, stops: [] });
      expect(noDropoff.status).toBe(400);
    });

    it("the booking must match its quote and be in time; a quote is used once", async () => {
      const quote = (await rider.quote({ categoryIds: ["economy"] })).body["quotes"][0];
      const base = { quoteId: quote.quoteId, categoryId: "economy", pickup: PLACES.sergels, dropoff: PLACES.medborgar, stops: [], kind: "live", paymentMethod: "cash" };
      const moved = await rider.post("/trips", { ...base, dropoff: PLACES.nearSergels });
      expect(moved.body["reason"]).toBe("quote_mismatch");
      const other = await rider.post("/trips", { ...base, categoryId: "premium" });
      expect(other.body["reason"]).toBe("quote_mismatch");
      const booked = await rider.post("/trips", base);
      expect(booked.status).toBe(201);
      expect(booked.body).toMatchObject({ status: "searching", fare: { amountMinor: 21700 } });
      const again = await rider.post("/trips", base);
      expect(again.status).toBe(409);
      expect(again.body["reason"]).toBe("quote_used");
      await rider.command(booked.body["tripId"], "cancel", { reasonCode: "plans_changed" });

      const late = (await rider.quote({ categoryIds: ["economy"] })).body["quotes"][0];
      await sim.advance(301);
      const expired = await rider.post("/trips", { ...base, quoteId: late.quoteId });
      expect(expired.status).toBe(409);
      expect(expired.body["reason"]).toBe("quote_expired");
    });

    it("OSRM down: the quote is still given, from the straight-line estimate", async () => {
      osrm.set("down");
      try {
        const res = await rider.quote({ categoryIds: ["economy"] });
        expect(res.status).toBe(201);
        const stored = await sim.db.selectFrom("quotes").select(["route_source"]).where("quote_id", "=", res.body["quotes"][0].quoteId).executeTakeFirstOrThrow();
        expect(stored.route_source).toBe("estimate");
      } finally {
        osrm.set({ distance: 8000, duration: 1080 });
      }
    });

    it("v0.18.163 (owner: no OpenStreetMap): POST /routes answers the server's router; the OSRM proxy is not used", async () => {
      const route = { mode: "driving", from: { lat: PLACES.sergels.lat, lng: PLACES.sergels.lng }, to: { lat: PLACES.medborgar.lat, lng: PLACES.medborgar.lng } };
      const res = await rider.post("/routes", route);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ distanceMeters: 8000, durationSeconds: 1080 });
    });
  });

  describe("without OSRM (no OSRM_URL: the server estimates)", () => {
    let sim: Sim;
    beforeAll(async () => {
      sim = await Sim.start();
    });
    afterAll(async () => sim.stop());

    it("quotes from the estimate and books", async () => {
      const rider = await sim.rider(0);
      const { trip, quote } = await rider.book();
      expect(trip.status).toBe("searching");
      const stored = await sim.db.selectFrom("quotes").select(["route_source"]).where("quote_id", "=", quote.quoteId).executeTakeFirstOrThrow();
      expect(stored.route_source).toBe("estimate");
    });
  });
});
