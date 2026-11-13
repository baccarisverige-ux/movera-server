import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fakeOsrm, PLACES, Sim, type Admin, type Json, type Rider } from "../e2e/harness.js";

/**
 * B1.34 (contract v0.18.81, contract.json#bookLater.riderCap; owner Q94 "A) Yes", 2026-11-13: default 3, range 1-50):
 * a rider holds at most DriverAppConfig.reservations.maxOpenPerRider booked rides that have not ended; the next
 * POST /trips kind scheduled is 409 conflict, reason booked_rides_limit, with the number in the message. Before this a
 * rider could hold any number of booked rides (one account could fill a zone's Scheduled rides list).
 */

let sim: Sim;
let osrm: Awaited<ReturnType<typeof fakeOsrm>>;
let rider: Rider;
let owner: Admin;

beforeAll(async () => {
  osrm = await fakeOsrm({ distance: 8000, duration: 1080 });
  sim = await Sim.start({ osrmUrl: osrm.url, now: new Date("2026-11-05T05:00:00Z") });
  rider = await sim.rider(0);
  owner = await sim.owner();
});
afterAll(async () => {
  await sim.stop();
  await osrm.close();
});
beforeEach(async () => {
  // Every case starts with no open ride for the rider.
  await sim.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("status", "not in", ["completed", "cancelled_by_rider", "cancelled_by_admin", "expired", "cancelled_by_system", "no_show", "failed", "cancelled_by_driver"]).execute();
});

const minutes = (m: number) => new Date(sim.clock.now.getTime() + m * 60_000).toISOString();

async function setCap(value: number | undefined) {
  await sim.publish(owner, "driver_app_config", "Z001", (doc) => {
    const reservations = { ...((doc.reservations as Json | undefined) ?? {}) };
    if (value === undefined) delete reservations["maxOpenPerRider"];
    else reservations["maxOpenPerRider"] = value;
    return { ...doc, reservations };
  });
}

async function scheduledQuote(at: string): Promise<Json> {
  const quotes = await rider.quote({ categoryIds: ["economy"], kind: "scheduled", scheduledAt: at });
  expect(quotes.status, JSON.stringify(quotes.body)).toBe(201);
  return quotes.body["quotes"][0];
}
const bookWith = (quote: Json, at: string) =>
  rider.post("/trips", { quoteId: quote["quoteId"], categoryId: "economy", pickup: PLACES.sergels, dropoff: PLACES.medborgar, stops: [], kind: "scheduled", scheduledAt: at, paymentMethod: "cash" });
async function tryBook(offsetMin: number) {
  const at = minutes(offsetMin);
  return bookWith(await scheduledQuote(at), at);
}
async function book(offsetMin: number): Promise<Json> {
  const res = await tryBook(offsetMin);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

describe("B1.34 open booked rides per rider", () => {
  it("B1.34: a rider with N open booked rides gets 409 booked_rides_limit on the N+1st", async () => {
    await setCap(2);
    await book(180);
    await book(240);
    const third = await tryBook(300);
    expect(third.status, JSON.stringify(third.body)).toBe(409);
    expect(third.body).toMatchObject({ reason: "booked_rides_limit" });
    expect(third.body["message"]).toBe("You can have at most 2 booked rides. Cancel one to book another.");
    // Nothing was booked: still exactly 2 open booked rides.
    const open = await sim.db.selectFrom("trips").select("trip_id").where("rider_id", "=", rider.id).where("kind", "=", "scheduled").where("status", "=", "requested").execute();
    expect(open).toHaveLength(2);
  });

  it("B1.34: a cancelled or ended booked ride frees a place", async () => {
    await setCap(2);
    const first = await book(180);
    await book(240);
    expect((await tryBook(300)).status).toBe(409);
    const cancelled = await rider.command(first["tripId"], "cancel", { reasonCode: "plans_changed" });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    await book(300);
    // An ended one (completed) frees a place too.
    const second = await sim.db.selectFrom("trips").select("trip_id").where("rider_id", "=", rider.id).where("kind", "=", "scheduled").where("status", "=", "requested").orderBy("created_at").executeTakeFirstOrThrow();
    await sim.db.updateTable("trips").set({ status: "completed" }).where("trip_id", "=", second.trip_id).execute();
    await book(360);
  });

  it("B1.34: live rides do not count and are not limited by it", async () => {
    await setCap(1);
    const live = await rider.book();
    // A live ride going on does not use the place.
    await book(180);
    expect((await tryBook(240)).body).toMatchObject({ reason: "booked_rides_limit" });
    // With the booked place full, a live ride is still taken (the live rule is the old one: one at a time).
    await rider.command(live.tripId, "cancel", { reasonCode: "plans_changed" });
    const again = await rider.book();
    expect(again.res.status).toBe(201);
  });

  it("B1.34: two bookings at the same moment never pass the cap", async () => {
    await setCap(2);
    await book(180);
    const at1 = minutes(240);
    const at2 = minutes(300);
    const [q1, q2] = [await scheduledQuote(at1), await scheduledQuote(at2)];
    const results = await Promise.all([bookWith(q1, at1), bookWith(q2, at2)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body).toMatchObject({ reason: "booked_rides_limit" });
  });

  it("B1.34: no setting = the contract default (3)", async () => {
    await setCap(undefined);
    await book(180);
    await book(240);
    await book(300);
    const fourth = await tryBook(360);
    expect(fourth.status).toBe(409);
    expect(fourth.body["message"]).toBe("You can have at most 3 booked rides. Cancel one to book another.");
  });

  it("B1.34: at the cap the rider can still change the time of a booked ride (not checked at quote or reschedule)", async () => {
    await setCap(1);
    const trip = await book(180);
    const later = minutes(240);
    const quote = await scheduledQuote(later);
    const changed = await rider.post(`/trips/${trip["tripId"]}/reschedule`, { quoteId: quote["quoteId"], expectedVersion: (await rider.trip(trip["tripId"])).version });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body).toMatchObject({ scheduledAt: later });
  });
});
