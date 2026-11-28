import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fakeOsrm, PLACES, Sim, type Json, type Rider } from "../e2e/harness.js";

/**
 * v0.18.174 (contract.json#priceChangeAsk; owner 2026-11-28 "When price more allways show", "No popup, book lower";
 * Rules plan/PLAN-0.18.174-price-change-tolerance.md §6): a booking that sends agreedQuoteId is compared with the
 * fresh quote on minor units. A drop or the same price books silently at the fresh price; ANY rise is 409
 * price_changed_ask until priceAccepted true. The fare is always the fresh quote row. Without agreedQuoteId (older
 * apps) nothing changes. Amounts as in the plan: 79,30 € = 7930 minor units (the test zone prices in SEK; only the
 * minor units matter here).
 */

let sim: Sim;
let osrm: Awaited<ReturnType<typeof fakeOsrm>>;
let rider: Rider;
let other: Rider;

beforeAll(async () => {
  osrm = await fakeOsrm({ distance: 8000, duration: 1080 });
  sim = await Sim.start({ osrmUrl: osrm.url, now: new Date("2026-11-05T05:00:00Z") });
  rider = await sim.rider(0);
  other = await sim.rider(2);
});
afterAll(async () => {
  await sim.stop();
  await osrm.close();
});
const clearTrips = () =>
  sim.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("status", "not in", ["completed", "cancelled_by_rider", "cancelled_by_admin", "expired", "cancelled_by_system", "no_show", "failed", "cancelled_by_driver"]).execute();
beforeEach(clearTrips);

const at = (m: number) => new Date(sim.clock.now.getTime() + m * 60_000).toISOString();

async function quote(who: Rider = rider, extra: Json = {}): Promise<Json> {
  const res = await who.quote({ categoryIds: ["economy"], ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body["quotes"][0];
}
const setTotal = (quoteId: string, minor: number) => sim.db.updateTable("quotes").set({ total_minor: minor }).where("quote_id", "=", quoteId).execute();
async function pair(agreedMinor: number, freshMinor: number, extra: Json = {}): Promise<{ agreed: Json; fresh: Json }> {
  const agreed = await quote(rider, extra);
  const fresh = await quote(rider, extra);
  await setTotal(agreed["quoteId"], agreedMinor);
  await setTotal(fresh["quoteId"], freshMinor);
  return { agreed, fresh };
}
const book = (fresh: Json, extra: Json = {}, who: Rider = rider) =>
  who.post("/trips", { quoteId: fresh["quoteId"], categoryId: "economy", pickup: PLACES.sergels, dropoff: PLACES.medborgar, stops: [], kind: "live", paymentMethod: "cash", ...extra });
const fareOf = async (tripId: string) => Number((await sim.db.selectFrom("trips").select("fare_minor").where("trip_id", "=", tripId).executeTakeFirstOrThrow()).fare_minor);
const tripsOf = async () => (await sim.db.selectFrom("trips").select("trip_id").where("rider_id", "=", rider.id).where("status", "not in", ["cancelled_by_admin"]).execute()).length;

describe("v0.18.174 price change at booking", () => {
  it("1. a drop 79,30 → 79,20 books silently at the fresh (lower) price", async () => {
    const { agreed, fresh } = await pair(7930, 7920);
    const res = await book(fresh, { agreedQuoteId: agreed["quoteId"] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body["fare"]).toMatchObject({ amountMinor: 7920 });
    expect(await fareOf(res.body["tripId"])).toBe(7920);
  });

  it("2. a rise of 1 cent (79,30 → 79,31) is asked; accepted it books at 79,31", async () => {
    const { agreed, fresh } = await pair(7930, 7931);
    const before = await tripsOf();
    const asked = await book(fresh, { agreedQuoteId: agreed["quoteId"] });
    expect(asked.status, JSON.stringify(asked.body)).toBe(409);
    expect(asked.body).toMatchObject({ code: "conflict", reason: "price_changed_ask" });
    expect(await tripsOf()).toBe(before);
    // The fresh quote stays unused: the same quote books once accepted.
    const yes = await book(fresh, { agreedQuoteId: agreed["quoteId"], priceAccepted: true });
    expect(yes.status, JSON.stringify(yes.body)).toBe(201);
    expect(await fareOf(yes.body["tripId"])).toBe(7931);
  });

  it("3. a rise 79,30 → 81,50 is asked (also with priceAccepted false); accepted books 81,50; the same price books", async () => {
    const { agreed, fresh } = await pair(7930, 8150);
    expect((await book(fresh, { agreedQuoteId: agreed["quoteId"] })).body).toMatchObject({ reason: "price_changed_ask" });
    expect((await book(fresh, { agreedQuoteId: agreed["quoteId"], priceAccepted: false })).body).toMatchObject({ reason: "price_changed_ask" });
    const yes = await book(fresh, { agreedQuoteId: agreed["quoteId"], priceAccepted: true });
    expect(yes.status).toBe(201);
    expect(await fareOf(yes.body["tripId"])).toBe(8150);

    await clearTrips();
    const same = await pair(7930, 7930);
    const booked = await book(same.fresh, { agreedQuoteId: same.agreed["quoteId"] });
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    expect(await fareOf(booked.body["tripId"])).toBe(7930);
  });

  it("4. a forged client price is invalid_body; another rider's agreed quote is quote_mismatch; the fare is the quote row", async () => {
    const { agreed, fresh } = await pair(7930, 8150);
    for (const field of ["total", "fareMinor", "price", "totalMinor", "amountMinor"]) {
      const res = await book(fresh, { agreedQuoteId: agreed["quoteId"], priceAccepted: true, [field]: 100 });
      expect(res.status, field).toBe(400);
      expect(res.body, field).toMatchObject({ code: "invalid_request", reason: "invalid_body" });
    }
    const theirs = await quote(other);
    const mismatch = await book(fresh, { agreedQuoteId: theirs["quoteId"], priceAccepted: true });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body).toMatchObject({ reason: "quote_mismatch" });
    const yes = await book(fresh, { agreedQuoteId: agreed["quoteId"], priceAccepted: true });
    expect(await fareOf(yes.body["tripId"])).toBe(8150);
  });

  it("5. the booked ride's re-quote (reschedule): +1 cent asks, a drop books lower", async () => {
    const first = await quote(rider, { kind: "scheduled", scheduledAt: at(180) });
    const booked = await rider.post("/trips", { quoteId: first["quoteId"], categoryId: "economy", pickup: PLACES.sergels, dropoff: PLACES.medborgar, stops: [], kind: "scheduled", scheduledAt: at(180), paymentMethod: "cash" });
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    const tripId = booked.body["tripId"];
    const reschedule = async (fresh: Json, extra: Json) => rider.post(`/trips/${tripId}/reschedule`, { quoteId: fresh["quoteId"], expectedVersion: (await rider.trip(tripId)).version, ...extra });

    const up = await pair(7930, 7931, { kind: "scheduled", scheduledAt: at(240) });
    const asked = await reschedule(up.fresh, { agreedQuoteId: up.agreed["quoteId"] });
    expect(asked.status, JSON.stringify(asked.body)).toBe(409);
    expect(asked.body).toMatchObject({ reason: "price_changed_ask" });
    expect(await fareOf(tripId)).toBe(Number(first["total"]["amountMinor"]));
    expect((await reschedule(up.fresh, { agreedQuoteId: up.agreed["quoteId"], fareMinor: 1 })).body).toMatchObject({ reason: "invalid_body" });

    const down = await pair(7930, 7920, { kind: "scheduled", scheduledAt: at(300) });
    const saved = await reschedule(down.fresh, { agreedQuoteId: down.agreed["quoteId"] });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(await fareOf(tripId)).toBe(7920);
  });

  it("6. the agreed quote EXPIRED: a rise is asked, a drop books at the lower fresh price", async () => {
    const up = await pair(7930, 8150);
    await sim.db.updateTable("quotes").set({ expires_at: new Date(sim.clock.now.getTime() - 60_000) }).where("quote_id", "=", up.agreed["quoteId"]).execute();
    expect((await book(up.fresh, { agreedQuoteId: up.agreed["quoteId"] })).body).toMatchObject({ reason: "price_changed_ask" });
    const down = await pair(7930, 7920);
    await sim.db.updateTable("quotes").set({ expires_at: new Date(sim.clock.now.getTime() - 60_000) }).where("quote_id", "=", down.agreed["quoteId"]).execute();
    const res = await book(down.fresh, { agreedQuoteId: down.agreed["quoteId"] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await fareOf(res.body["tripId"])).toBe(7920);
  });

  it("7. the agreed quote MISSING (deleted / unknown id) is asked; accepted books at the fresh quote", async () => {
    const { agreed, fresh } = await pair(7930, 7920);
    await sim.db.deleteFrom("quotes").where("quote_id", "=", agreed["quoteId"]).execute();
    expect((await book(fresh, { agreedQuoteId: agreed["quoteId"] })).body).toMatchObject({ reason: "price_changed_ask" });
    expect((await book(fresh, { agreedQuoteId: "quo_unknown_0000000000" })).body).toMatchObject({ reason: "price_changed_ask" });
    const yes = await book(fresh, { agreedQuoteId: agreed["quoteId"], priceAccepted: true });
    expect(yes.status, JSON.stringify(yes.body)).toBe(201);
    expect(await fareOf(yes.body["tripId"])).toBe(7920);
  });

  it("8. an older app (no agreedQuoteId) books as today, never price_changed_ask", async () => {
    const { fresh } = await pair(7930, 8150);
    const res = await book(fresh);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await fareOf(res.body["tripId"])).toBe(8150);
  });
});
