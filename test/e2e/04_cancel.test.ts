import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bookAndAccept, drive, fakeOsrm, PLACES, Sim, type Driver, type Rider } from "./harness.js";

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
  b = await sim.driver(2, PLACES.odenplan);
});
afterAll(async () => {
  await sim.stop();
  await osrm.close();
});
beforeEach(async () => {
  // Fees owed from an earlier case are cleared so each case prices alone; both cars back where they wait.
  await sim.db.updateTable("rider_fees").set({ status: "waived" }).where("status", "=", "owed").execute();
  await sim.db.updateTable("riders").set({ outstanding_minor: 0, outstanding_source_trip_id: null }).execute();
  await sim.advance(5);
  await a.moveTo(PLACES.nearSergels);
  await b.moveTo(PLACES.odenplan);
});

const ledger = (tripId: string) => sim.db.selectFrom("earnings_entries").select(["kind", "amount_minor"]).where("trip_id", "=", tripId).execute();
const cancel = (tripId: string) => rider.command(tripId, "cancel", { reasonCode: "plans_changed" });

describe("scenario 4: rider cancels at each stage; driver cancels; no-show; fees", () => {
  it("while searching and while offered: free; the offered driver's offer is withdrawn on their feed", async () => {
    const searching = await rider.book();
    const res = await cancel(searching.tripId);
    expect(res.body).toMatchObject({ status: "cancelled_by_rider", cancellation: { actor: "rider", fee: null } });

    const feed = await a.offerFeed();
    const offered = await rider.book();
    await sim.tick();
    await feed.waitFor((e) => e.data["offer"]?.["tripId"] === offered.tripId && e.data["kind"] === "offer_created");
    expect((await rider.trip(offered.tripId)).status).toBe("offered");
    expect((await cancel(offered.tripId)).body).toMatchObject({ status: "cancelled_by_rider", cancellation: { fee: null } });
    await feed.waitFor((e) => e.data["offer"]?.["tripId"] === offered.tripId && e.data["kind"] === "offer_withdrawn");
    expect(await a.offerFor(offered.tripId)).toBeUndefined();
    feed.close();
  });

  it("accepted, inside the free 2 minutes: free, the driver is free again", async () => {
    const { tripId } = await bookAndAccept(sim, rider, a);
    await sim.advance(90);
    expect((await cancel(tripId)).body).toMatchObject({ status: "cancelled_by_rider", cancellation: { fee: null } });
    expect((await a.get("/driver/profile")).body.onlineStatus).toBe("online");
    expect(await ledger(tripId)).toEqual([]);
  });

  it("accepted, after 2 minutes with the driver coming closer: the zone's 35 kr economy fee, owed, the driver's share credited", async () => {
    const { tripId } = await bookAndAccept(sim, rider, a);
    await drive(a, tripId, "driver_to_pickup");
    await sim.advance(150);
    await a.moveTo(PLACES.sergels);
    const res = await cancel(tripId);
    expect(res.body).toMatchObject({ status: "cancelled_by_rider", fare: { amountMinor: 3500 }, cancellation: { fee: { amountMinor: 3500, currency: "SEK" }, feeStatus: "owed" } });
    expect(await ledger(tripId)).toEqual([{ kind: "fee_share", amount_minor: "3500" }]);
    expect((await rider.get("/rider/profile")).body.outstanding).toEqual({ amountMinor: 3500, currency: "SEK" });
    // The next quote carries the unpaid fee (§3.7).
    const next = (await rider.quote({ categoryIds: ["economy"] })).body.quotes[0];
    expect(next.fareLines).toEqual(expect.arrayContaining([{ code: "outstanding_fee", amount: { amountMinor: 3500, currency: "SEK" }, sourceTripId: tripId }]));
  });

  it("arrived, after the free minutes: a cancel counts as a no-show (v0.18.7 Q2, admin switch on by default): the 65 kr no-show fee, 80 % to the driver", async () => {
    const { tripId } = await bookAndAccept(sim, rider, a);
    await drive(a, tripId, "arrived");
    await sim.advance(180);
    const res = await cancel(tripId);
    expect(res.body.cancellation).toMatchObject({ fee: { amountMinor: 6500, currency: "SEK" }, feeKind: "no_show", feeStatus: "owed", driverShare: { amountMinor: 5200, currency: "SEK" } });
    expect(await ledger(tripId)).toEqual([{ kind: "fee_share", amount_minor: "5200" }]);
  });

  it("on board the rider cannot cancel (409 invalid_transition): ending early is the way", async () => {
    const { tripId } = await bookAndAccept(sim, rider, a);
    await drive(a, tripId, "in_trip");
    const res = await cancel(tripId);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "invalid_transition", projection: { status: "in_trip" } });
    const ended = await rider.command(tripId, "end-early", { reasonCode: "plans_changed" });
    expect(ended.status).toBe(200);
  });

  it("driver cancels before boarding: the trip goes back to dispatch without them and another driver gets it; no fee for the rider", async () => {
    const { tripId } = await bookAndAccept(sim, rider, a);
    const riderEvents = await rider.events(tripId);
    await drive(a, tripId, "driver_to_pickup");
    const res = await a.command(tripId, "cancel", { reasonCode: "rider_not_at_pickup" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await riderEvents.reach("searching");
    await sim.tick();
    expect(await a.offerFor(tripId)).toBeUndefined();
    const offer = await b.offerFor(tripId);
    expect(offer).toBeDefined();
    expect((await b.accept(offer!)).body).toMatchObject({ status: "accepted", driver: { driverId: b.id } });
    const seen = await riderEvents.waitFor((e) => e.data["projection"]?.["status"] === "accepted" && e.data["projection"]?.["driver"]?.["driverId"] === b.id);
    expect(seen.data["projection"].fare.amountMinor).toBe(21700);
    // A can no longer see or act on it.
    expect((await a.get(`/trips/${tripId}`)).status).toBe(404);
    const rows = await sim.db.selectFrom("driver_cancels").select(["driver_id", "reason_code"]).where("trip_id", "=", tripId).execute();
    expect(rows).toEqual([{ driver_id: a.id, reason_code: "rider_not_at_pickup" }]);
    expect((await cancel(tripId)).body.status).toBe("cancelled_by_rider");
    riderEvents.close();
  });

  it("driver cancels on board: the rider pays what was driven, never more than booked", async () => {
    const { tripId } = await bookAndAccept(sim, rider, a);
    await drive(a, tripId, "in_trip");
    await sim.advance(120);
    await a.moveTo(PLACES.odenplan);
    const res = await a.command(tripId, "cancel", { reasonCode: "safety_concern_on_trip" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe("cancelled_by_driver");
    expect(res.body.fare.amountMinor).toBeGreaterThan(0);
    expect(res.body.fare.amountMinor).toBeLessThanOrEqual(21700);
    expect((await ledger(tripId)).map((e) => e.kind)).toContain("trip");
  });

  it("no-show: refused before the 5 free minutes, then 65 kr owed (pricing document) and 80 % to the driver", async () => {
    // Either driver: A cancelled a ride above, so ranking may now prefer B.
    const { tripId, driver } = await bookAndAccept(sim, rider, [a, b]);
    await drive(driver, tripId, "arrived");
    await sim.advance(4 * 60);
    const early = await driver.command(tripId, "no-show", { reasonCode: "rider_no_show" });
    expect(early.status).toBe(409);
    await sim.advance(61);
    const res = await driver.command(tripId, "no-show", { reasonCode: "rider_no_show" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ status: "no_show", cancellation: { fee: { amountMinor: 6500, currency: "SEK" }, feeStatus: "owed" } });
    expect(await ledger(tripId)).toEqual([{ kind: "fee_share", amount_minor: "5200" }]);
    expect((await rider.trip(tripId)).status).toBe("no_show");
  });
});
