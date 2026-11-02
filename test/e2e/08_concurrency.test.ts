import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { bookAndAccept, drive, fakeOsrm, newKey, PLACES, Sim, type Admin, type Driver, type Json, type Rider } from "./harness.js";

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
  if (active.status === 200 && ["searching", "offered", "accepted", "driver_to_pickup"].includes(active.body.status)) await rider.command(active.body.tripId, "cancel", { reasonCode: "plans_changed" });
  await sim.db.updateTable("rider_fees").set({ status: "waived" }).where("status", "=", "owed").execute();
  await sim.db.updateTable("riders").set({ outstanding_minor: 0, outstanding_source_trip_id: null }).execute();
  await sim.advance(5);
  await a.moveTo(PLACES.nearSergels);
  await b.moveTo(PLACES.odenplan);
});

describe("scenario 8: duplicates, races, delayed and out-of-order events, reconnect, app restart", () => {
  it("the same request sent twice with one Idempotency-Key (also at the same moment) books one trip", async () => {
    const quote = (await rider.quote({ categoryIds: ["economy"] })).body.quotes[0];
    const body = { quoteId: quote.quoteId, categoryId: "economy", pickup: PLACES.sergels, dropoff: PLACES.medborgar, stops: [], kind: "live", paymentMethod: "cash" };
    const key = newKey("dup");
    const [one, two] = await Promise.all([rider.post("/trips", body, key), rider.post("/trips", body, key)]);
    expect(one.status).toBe(201);
    expect(two.status).toBe(201);
    expect(two.body.tripId).toBe(one.body.tripId);
    const three = await rider.post("/trips", body, key);
    expect(three.body.tripId).toBe(one.body.tripId);
    const trips = await sim.db.selectFrom("trips").select("trip_id").where("quote_id", "=", quote.quoteId).execute();
    expect(trips).toHaveLength(1);
    // The same key with another body is a conflict, never a second trip.
    expect((await rider.post("/trips", { ...body, notes: "other" }, key)).status).toBe(409);
    // A retried cancel (same key) answers the same, once.
    const version = (await rider.trip(one.body.tripId)).version;
    const cancelKey = newKey("dup");
    const c1 = await rider.post(`/trips/${one.body.tripId}/cancel`, { expectedVersion: version, reasonCode: "plans_changed" }, cancelKey);
    const c2 = await rider.post(`/trips/${one.body.tripId}/cancel`, { expectedVersion: version, reasonCode: "plans_changed" }, cancelKey);
    expect(c1.status).toBe(200);
    expect(c2.body).toEqual(c1.body);
  });

  it("two drivers accept at the same moment (admin radar group): exactly one wins, the other is told it is taken", async () => {
    const { tripId } = await rider.book();
    const trip = await owner.trip(tripId);
    const group = await owner.tripCommand(tripId, "radar-group", { expectedVersion: trip.version, driverIds: [a.id, b.id] });
    expect(group.status, JSON.stringify(group.body)).toBe(200);
    const offerA = await a.offerFor(tripId);
    const offerB = await b.offerFor(tripId);
    expect(offerA && offerB).toBeTruthy();
    const feedA = await a.offerFeed();
    const feedB = await b.offerFeed();
    const [ra, rb] = await Promise.all([a.accept(offerA!), b.accept(offerB!)]);
    const results = [ra, rb].map((r) => r.status).sort();
    expect(results).toEqual([200, 409]);
    const winner = ra.status === 200 ? a : b;
    const loser = winner === a ? b : a;
    const loserFeed = winner === a ? feedB : feedA;
    const view = await rider.trip(tripId);
    expect(view).toMatchObject({ status: "accepted", driver: { driverId: winner.id } });
    await loserFeed.waitFor((e) => e.data["offer"]?.["tripId"] === tripId && e.data["kind"] === "offer_withdrawn");
    expect((await loser.get(`/trips/${tripId}`)).status).toBe(404);
    feedA.close();
    feedB.close();
  });

  it("events that arrive late and out of order: every event carries version and full projection, so an app that keeps the highest version ends where the server is", async () => {
    const { tripId } = await bookAndAccept(sim, rider, a);
    const stream = await rider.events(tripId, "0");
    await drive(a, tripId, "in_trip");
    await sim.advance(18 * 60);
    await a.moveTo(PLACES.medborgar);
    await a.command(tripId, "complete");
    await stream.reach("completed");
    const events = stream.events.map((e) => e.data);
    for (const e of events) {
      expect(e).toMatchObject({ tripId, sequence: expect.any(Number), version: expect.any(Number) });
      // Status changes carry the whole projection at that version; location / ETA events carry no projection.
      if (e["kind"] === "trip_projection") expect(e["projection"]).toMatchObject({ tripId, version: e["version"] });
    }
    expect(events.filter((e) => e["projection"]).length).toBeGreaterThan(4);
    // The network delivers them shuffled; the app applies an event only when it is newer than what it shows.
    const shuffled = [...events].sort((x, y) => (((x["sequence"] as number) * 7919) % 13) - (((y["sequence"] as number) * 7919) % 13));
    let shown: Json = { version: 0 };
    for (const e of shuffled) if (e["projection"] && e["version"] > shown["version"]) shown = e["projection"];
    const server = await rider.trip(tripId);
    expect(shown.status).toBe(server.status);
    expect(shown.version).toBe(server.version);
    expect(shown.fare).toEqual(server.fare);
    stream.close();
  });

  it("a stream that drops mid-trip resumes from Last-Event-ID: nothing lost, nothing twice", async () => {
    const { tripId } = await bookAndAccept(sim, rider, a);
    const stream = await rider.events(tripId, "0");
    await drive(a, tripId, "driver_to_pickup");
    await stream.reach("driver_to_pickup");
    stream.close();
    // Signal lost: the driver arrives and the rider boards meanwhile.
    await drive(a, tripId, "in_trip");
    expect(stream.events.some((e) => e.data["projection"]?.["status"] === "arrived")).toBe(false);
    await stream.reconnect();
    await stream.reach("in_trip");
    const sequences = stream.events.map((e) => e.data["sequence"] as number);
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(sequences).toEqual(Array.from({ length: sequences.length }, (_, i) => sequences[0]! + i));
    expect(stream.events.map((e) => e.data["projection"]?.["status"])).toEqual(expect.arrayContaining(["arrived", "rider_onboard", "in_trip"]));
    // The driver's offer feed resumes the same way.
    const feed = await a.offerFeed("0");
    await feed.waitFor((e) => e.data["offer"]?.["tripId"] === tripId);
    const last = feed.lastEventId!;
    feed.close();
    const again = await a.offerFeed(last);
    await new Promise((r) => setTimeout(r, 150));
    expect(again.events.filter((e) => Number(e.id) <= Number(last))).toEqual([]);
    again.close();
    stream.close();
    await sim.advance(60);
    await a.moveTo(PLACES.medborgar);
    await a.command(tripId, "complete");
  });

  it("both apps restart mid-trip: they reread the trip, and a command with the stale version is refused with the current state", async () => {
    const { tripId } = await bookAndAccept(sim, rider, a);
    const stale = (await a.trip(tripId)).version;
    await drive(a, tripId, "arrived");
    // "Restart": new sign-ins, nothing kept but the phone number.
    await sim.advance(31);
    const riderAgain = await sim.rider(0);
    const driverAgain = await sim.driver(1, null);
    // v0.18.14 (one phone at a time): the new sign-in ended the old phone's session; the old one says why.
    expect((await a.get("/driver/profile")).body).toMatchObject({ reason: "signed_in_elsewhere" });
    a.session = driverAgain.session;
    const active = await riderAgain.get("/rider/trips/active");
    expect(active.status).toBe(200);
    expect(active.body).toMatchObject({ tripId, status: "arrived" });
    const profile = (await driverAgain.get("/driver/profile")).body;
    expect(profile.activeTripId).toBe(tripId);
    expect(profile.onlineStatus).toBe("on_trip");
    const reread = await driverAgain.trip(tripId);
    expect(reread.version).toBe(active.body.version);
    // A queued command from before the restart, with the old version: 409 with the current projection, no change.
    const old = await driverAgain.post(`/trips/${tripId}/board`, { expectedVersion: stale });
    expect(old.status).toBe(409);
    expect(old.body).toMatchObject({ code: "version_mismatch", projection: { status: "arrived", version: reread.version } });
    expect((await driverAgain.command(tripId, "board")).body.status).toBe("rider_onboard");
    const live = await riderAgain.events(tripId, String(0));
    await live.reach("rider_onboard");
    live.close();
    await driverAgain.command(tripId, "start");
    await sim.advance(60);
    await driverAgain.moveTo(PLACES.medborgar);
    expect((await driverAgain.command(tripId, "complete")).body.status).toBe("completed");
  });
});
