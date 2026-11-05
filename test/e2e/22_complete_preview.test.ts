import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { bookAndAccept, drive, fakeOsrm, PLACES, Sim, type Driver, type Json, type Rider } from "./harness.js";

/**
 * Contract v0.18.1 §26 (owner 2026-10-29, live bug A, "Server's final price (Recommended)"): the driver app asks
 * GET /driver/trips/{tripId}/complete-preview before Collect cash, and the amount it shows is the fare complete sets.
 * Owner decision 28: completing farther than 300 m from the drop-off is an early end (what was driven + minimum).
 */

let sim: Sim;
let osrm: Awaited<ReturnType<typeof fakeOsrm>>;
let rider: Rider;
let a: Driver;
let b: Driver;

beforeAll(async () => {
  osrm = await fakeOsrm({ distance: 8000, duration: 1080 });
  sim = await Sim.start({ osrmUrl: osrm.url });
  rider = await sim.rider(0);
  a = await sim.driver(1, PLACES.nearSergels);
  b = await sim.driver(2, null);
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

/** A live cash ride with a middle stop, accepted by A (as test/e2e/17_pricing_v071.test.ts). */
async function bookWithStop(): Promise<string> {
  const trip = { pickup: PLACES.sergels, dropoff: PLACES.medborgar, stops: [{ address: "Odenplan", ...PLACES.odenplan }] };
  const quoted = await rider.quote({ ...trip, categoryIds: ["economy"] });
  const booked = await rider.post("/trips", { quoteId: quoted.body["quotes"][0].quoteId, categoryId: "economy", ...trip, kind: "live", paymentMethod: "cash" });
  expect(booked.status, JSON.stringify(booked.body)).toBe(201);
  const tripId = booked.body["tripId"];
  await sim.tick();
  const offer = await a.offerFor(tripId);
  expect((await a.accept(offer!)).status).toBe(200);
  return tripId;
}

const preview = (driver: Driver, tripId: string) => driver.get(`/driver/trips/${tripId}/complete-preview`);
/** `km` due north of the drop-off (1° of latitude = 111.195 km on the contract's earth). */
const nearDropoff = (km: number) => ({ lat: PLACES.medborgar.lat + km / 111.19508, lng: PLACES.medborgar.lng });
const stored = (tripId: string) => sim.db.selectFrom("trips").select(["fare_minor", "cash_collected_minor", "wallet_applied_minor"]).where("trip_id", "=", tripId).executeTakeFirstOrThrow();
const sum = (lines: Json[]) => lines.reduce((total: number, l: Json) => total + l["amount"]["amountMinor"], 0);

describe("complete-preview (contract v0.18.1 §26)", () => {
  it("one fix at the pickup, 0 km, far from the drop-off: early end at the category minimum, and complete charges the same", async () => {
    const { tripId } = await bookAndAccept(sim, rider, a);
    await drive(a, tripId, "in_trip");
    const booked = (await a.trip(tripId))["fare"];
    const before = await a.trip(tripId);

    const shown = await preview(a, tripId);
    expect(shown.status, JSON.stringify(shown.body)).toBe(200);
    expect(shown.body.earlyEnd).toBe(true);
    expect(shown.body.fareLines.map((l: Json) => l["code"])).toContain("minimum_adjust");
    expect(shown.body.total.amountMinor).toBeLessThan(booked.amountMinor);
    // The live bug: economy minimum 49 kr + 10 % app fee = 54 kr (fixtures/fares.json end_early_minimum), not the booked fare.
    expect(shown.body.total).toEqual({ amountMinor: 5400, currency: "SEK" });
    expect(sum(shown.body.fareLines)).toBe(shown.body.total.amountMinor);
    expect(shown.body.cashDue).toEqual(shown.body.total);
    // Read-only: nothing on the trip moved.
    expect((await a.trip(tripId))["version"]).toBe(before["version"]);
    expect((await a.trip(tripId))["fare"]).toEqual(booked);

    const done = await a.command(tripId, "complete", { previewId: shown.body.previewId, cashCollected: shown.body.cashDue });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.fare).toEqual(shown.body.total);
    expect(done.body.fareLines).toEqual(shown.body.fareLines);
    expect(done.body.driverEarnings).toEqual(shown.body.driverEarnings);
    expect((await rider.trip(tripId))["fare"]).toEqual(shown.body.total);
  });

  it("at the drop-off: the booked fare plus the waiting at a middle stop, equal to what complete sets", async () => {
    const tripId = await bookWithStop();
    // Waiting at the pickup past the free minutes, then at the middle stop.
    await drive(a, tripId, "arrived");
    await sim.advance(8 * 60);
    await drive(a, tripId, "in_trip");
    const booked = (await a.trip(tripId))["fare"];
    const at = async (verb: "arrive" | "leave") => a.post(`/driver/trips/${tripId}/stops/0/${verb}`, { expectedVersion: (await a.trip(tripId))["version"] });
    expect((await at("arrive")).status).toBe(200);
    await sim.advance(3 * 60);
    expect((await at("leave")).status).toBe(200);
    await sim.advance(10 * 60);
    await a.moveTo(PLACES.medborgar);

    const shown = await preview(a, tripId);
    expect(shown.status, JSON.stringify(shown.body)).toBe(200);
    expect(shown.body.earlyEnd).toBe(false);
    expect(shown.body.total.amountMinor).toBeGreaterThan(booked.amountMinor);
    expect(shown.body.fareLines.map((l: Json) => l["code"])).toEqual(expect.arrayContaining(["waiting", "stop_waiting"]));

    const done = await a.command(tripId, "complete", { previewId: shown.body.previewId, cashCollected: shown.body.cashDue });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.fare).toEqual(shown.body.total);
    expect(done.body.fareLines).toEqual(shown.body.fareLines);
    expect(done.body.driverEarnings).toEqual(shown.body.driverEarnings);
  });

  it("at the drop-off with nothing added: the booked fare", async () => {
    const { tripId } = await bookAndAccept(sim, rider, a);
    await drive(a, tripId, "in_trip");
    const booked = (await a.trip(tripId))["fare"];
    await sim.advance(18 * 60);
    await a.moveTo(PLACES.medborgar);
    const shown = await preview(a, tripId);
    expect(shown.body).toMatchObject({ tripId, earlyEnd: false, total: booked, cashDue: booked });
    const done = await a.command(tripId, "complete", { previewId: shown.body.previewId, cashCollected: shown.body.cashDue });
    expect(done.body.fare).toEqual(booked);
  });

  it("only the trip's driver, only on board", async () => {
    const { tripId } = await bookAndAccept(sim, rider, a);
    await drive(a, tripId, "arrived");
    const early = await preview(a, tripId);
    expect(early.status).toBe(409);
    expect(early.body.reason).toBe("trip_not_on_board");
    await drive(a, tripId, "in_trip");
    expect((await preview(b, tripId)).status).toBe(404);
    expect((await rider.get(`/driver/trips/${tripId}/complete-preview`)).status).toBe(403);
    await a.moveTo(PLACES.medborgar);
    expect((await a.command(tripId, "complete")).status).toBe(200);
    expect((await preview(a, tripId)).body.reason).toBe("trip_not_on_board");
  });
});

describe("the frozen price (contract v0.18.1 §26, checker findings)", () => {
  it("a newer preview replaces the older one and is the price complete uses; cash stored = fare less wallet", async () => {
    const { tripId } = await bookAndAccept(sim, rider, a);
    await drive(a, tripId, "in_trip");
    const booked = (await a.trip(tripId))["fare"];
    await sim.advance(18 * 60);
    await a.moveTo(nearDropoff(0.29));
    const shown = await preview(a, tripId);
    expect(shown.body).toMatchObject({ earlyEnd: false, total: booked, cashDue: booked });
    expect(typeof shown.body.previewId).toBe("string");
    expect(Date.parse(shown.body.expiresAt) - sim.clock.now.getTime()).toBe(120_000);
    // The driver rolls on to 310 m and a minute passes: priced now, this would be an early end.
    await a.moveTo(nearDropoff(0.31));
    await sim.advance(60);
    expect((await preview(a, tripId)).body.earlyEnd).toBe(true);
    // The newest preview replaces the older one: the 290 m previewId is no longer the trip's.
    const fresh = await preview(a, tripId);
    const done = await a.command(tripId, "complete", { previewId: fresh.body.previewId, cashCollected: fresh.body.cashDue });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.fare).toEqual(fresh.body.total);
    const row = await stored(tripId);
    expect(Number(row.cash_collected_minor)).toBe(Number(row.fare_minor) - Number(row.wallet_applied_minor));
  });

  it("the frozen price is used exactly: preview at 290 m, complete at 310 m with that previewId keeps the booked fare", async () => {
    const { tripId } = await bookAndAccept(sim, rider, a);
    await drive(a, tripId, "in_trip");
    const booked = (await a.trip(tripId))["fare"];
    await sim.advance(18 * 60);
    await a.moveTo(nearDropoff(0.29));
    const shown = await preview(a, tripId);
    expect(shown.body.earlyEnd).toBe(false);
    await a.moveTo(nearDropoff(0.31));
    await sim.advance(60);
    const done = await a.command(tripId, "complete", { previewId: shown.body.previewId, cashCollected: shown.body.cashDue });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.fare).toEqual(booked);
    expect(done.body.fareLines).toEqual(shown.body.fareLines);
    expect(done.body.driverEarnings).toEqual(shown.body.driverEarnings);
    const row = await stored(tripId);
    expect(Number(row.cash_collected_minor)).toBe(shown.body.cashDue.amountMinor);
  });

  it("an early-end preview does not grow with the minutes that pass before complete", async () => {
    const { tripId } = await bookAndAccept(sim, rider, a);
    await drive(a, tripId, "in_trip");
    await a.moveTo(PLACES.sergels);
    await sim.advance(10 * 60);
    const shown = await preview(a, tripId);
    expect(shown.body.earlyEnd).toBe(true);
    await sim.advance(90);
    const done = await a.command(tripId, "complete", { previewId: shown.body.previewId, cashCollected: shown.body.cashDue });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.fare).toEqual(shown.body.total);
    expect(done.body.fareLines).toEqual(shown.body.fareLines);
  });

  it("an expired preview whose price changed: 409 price_changed with a fresh preview, nothing completed; the fresh one completes", async () => {
    const { tripId } = await bookAndAccept(sim, rider, a);
    await drive(a, tripId, "in_trip");
    const booked = (await a.trip(tripId))["fare"];
    // v0.18.33 (fix job 5, owner fix-plan Q1): a new price needs BOTH more than 2 km AND more than 10 min shorter, so the
    // driver is quick here (1 min on board) and the later early end is short on both.
    await sim.advance(60);
    await a.moveTo(PLACES.medborgar);
    const shown = await preview(a, tripId);
    expect(shown.body.total).toEqual(booked);
    // 2 minutes pass and the driver is now far from the drop-off.
    await sim.advance(121);
    await a.moveTo(PLACES.sergels);
    const before = await a.trip(tripId);
    const stale = await a.command(tripId, "complete", { previewId: shown.body.previewId, cashCollected: shown.body.cashDue });
    expect(stale.status, JSON.stringify(stale.body)).toBe(409);
    expect(stale.body).toMatchObject({ code: "conflict", reason: "price_changed" });
    expect(stale.body.preview.earlyEnd).toBe(true);
    expect(stale.body.preview.previewId).not.toBe(shown.body.previewId);
    expect(stale.body.preview.total.amountMinor).toBeLessThan(booked.amountMinor);
    expect((await a.trip(tripId))).toMatchObject({ status: before["status"], version: before["version"] });
    const done = await a.command(tripId, "complete", { previewId: stale.body.preview.previewId, cashCollected: stale.body.preview.cashDue });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.fare).toEqual(stale.body.preview.total);
    const row = await stored(tripId);
    expect(Number(row.cash_collected_minor)).toBe(stale.body.preview.cashDue.amountMinor);
    expect(Number(row.cash_collected_minor)).toBe(Number(row.fare_minor) - Number(row.wallet_applied_minor));
  });

  it("a wrong amount with a valid previewId is 409 price_changed, never 400", async () => {
    const { tripId } = await bookAndAccept(sim, rider, a);
    await drive(a, tripId, "in_trip");
    await a.moveTo(PLACES.medborgar);
    const shown = await preview(a, tripId);
    const wrong = await a.command(tripId, "complete", { previewId: shown.body.previewId, cashCollected: { ...shown.body.cashDue, amountMinor: shown.body.cashDue.amountMinor + 100 } });
    expect(wrong.status).toBe(409);
    expect(wrong.body.reason).toBe("price_changed");
    expect(wrong.body.preview.cashDue).toEqual(shown.body.cashDue);
    const done = await a.command(tripId, "complete", { previewId: wrong.body.preview.previewId, cashCollected: wrong.body.preview.cashDue });
    expect(done.status).toBe(200);
  });
});
