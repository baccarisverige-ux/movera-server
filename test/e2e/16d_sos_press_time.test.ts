import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { bookAndAccept, drive, Driver, fakeOsrm, newKey, PLACES, Sim, type Admin, type Rider } from "./harness.js";

/**
 * SOS by press time (contract v0.18.148, contract.json#sosPressTime; Rules LAUNCH-RULE.md "Queued (after freeze)"
 * item 1; owner 2026-11-20 "SOS kept and retried; after 30 min or any refusal the driver sees SOS not sent, call 112").
 *
 * The apps keep an SOS pressed without network and send it again with the same Idempotency-Key and body. Before
 * v0.18.148 the server answered 409 trip_not_live once the trip had ended, so such an SOS could only expire. Now an
 * ended trip's SOS is judged by its press time p = the earlier of `at` and the received time (a fast phone clock is
 * never refused): from the driver assignment until 30 min after the end, and received within 30 min of the press
 * (both limits inclusive). A live trip always takes it.
 */

const MIN = 60;
let sim: Sim;
let osrm: Awaited<ReturnType<typeof fakeOsrm>>;
let rider: Rider;
let a: Driver;
let safety: Admin;

beforeAll(async () => {
  osrm = await fakeOsrm({ distance: 8000, duration: 1080 });
  sim = await Sim.start({ osrmUrl: osrm.url });
  rider = await sim.rider(0);
  a = await sim.driver(1, PLACES.nearSergels);
  safety = await sim.admin("safety", ["Z001"]);
});
afterAll(async () => {
  await sim.stop();
  await osrm.close();
});
afterEach(async () => {
  sim.driverApps.add(a);
  const active = await rider.get("/rider/trips/active");
  if (active.status === 200 && active.body.tripId) {
    const trip = await a.trip(active.body.tripId).catch(() => undefined);
    if (trip && ["accepted", "driver_to_pickup", "arrived"].includes(trip["status"])) await rider.command(active.body.tripId, "cancel", { reasonCode: "plans_changed" });
    else if (trip && ["rider_onboard", "in_trip", "approaching_dropoff"].includes(trip["status"])) await complete(active.body.tripId);
  }
  await sim.advance(5);
  await a.moveTo(PLACES.nearSergels);
});

const iso = (d: Date) => d.toISOString();
const sosAt = (who: Rider | Driver, tripId: string, at: Date | string, key?: string) =>
  who.post(`/${who instanceof Driver ? "driver" : "rider"}/trips/${tripId}/sos`, { at: typeof at === "string" ? at : iso(at) }, key);

async function complete(tripId: string): Promise<Date> {
  await drive(a, tripId, "in_trip");
  await sim.advance(60);
  await a.moveTo(PLACES.medborgar);
  const done = await a.command(tripId, "complete");
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  return new Date(sim.clock.now);
}

/** A ride Ali drives to the end; returns the trip and the moment it ended. */
async function endedRide(): Promise<{ tripId: string; endedAt: Date }> {
  const { tripId } = await bookAndAccept(sim, rider, a);
  return { tripId, endedAt: await complete(tripId) };
}

const sosCases = async (tripId: string) =>
  ((await safety.get(`/admin/incidents?tripId=${tripId}&kind=sos`)).body.items as { incidentId: string }[]).map((i) => i.incidentId);

describe("scenario 16d: SOS by press time (v0.18.148)", () => {
  it("Ali presses SOS 5 min before drop-off with no network; it reaches Movera 10 min after the trip ended: one case with the press time, the same key replays it", async () => {
    const { tripId } = await bookAndAccept(sim, rider, a);
    await drive(a, tripId, "in_trip");
    const pressed = new Date(sim.clock.now);
    const key = newKey("sos");
    await sim.advance(5 * MIN);
    await a.moveTo(PLACES.medborgar);
    expect((await a.command(tripId, "complete")).status).toBe(200);
    await sim.advance(10 * MIN);
    const received = new Date(sim.clock.now);

    const first = await sosAt(a, tripId, pressed, key);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({ tripId, incidentId: expect.stringMatching(/^inc_/), receivedAt: iso(received) });
    // The app's next retry (same key, same body): the same answer, no second case.
    await sim.advance(5);
    const again = await sosAt(a, tripId, pressed, key);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(await sosCases(tripId)).toEqual([first.body["incidentId"]]);

    const detail = await safety.get(`/admin/incidents/${first.body["incidentId"]}`);
    expect(detail.body).toMatchObject({ kind: "sos", raisedBy: "driver", status: "open", alarm: true, pressedAt: iso(pressed), openedAt: iso(received) });
  });

  it("Sara presses SOS on the finish screen 10 min after drop-off: taken", async () => {
    const { tripId, endedAt } = await endedRide();
    await sim.advance(10 * MIN);
    const res = await sosAt(rider, tripId, sim.clock.now);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await safety.get(`/admin/incidents/${res.body["incidentId"]}`)).body).toMatchObject({ raisedBy: "rider", pressedAt: iso(sim.clock.now) });
    expect(sim.clock.now.getTime() - endedAt.getTime()).toBeGreaterThanOrEqual(10 * MIN * 1000);
  });

  it("pressed more than 30 min after the end, or before the driver was assigned: 409 sos_not_during_trip", async () => {
    const { tripId, endedAt } = await endedRide();
    await sim.advance(31 * MIN);
    const late = await sosAt(rider, tripId, new Date(endedAt.getTime() + (30 * MIN + 1) * 1000));
    expect(late.status).toBe(409);
    expect(late.body).toMatchObject({ code: "invalid_transition", reason: "sos_not_during_trip", projection: { tripId } });

    // A ride the rider cancelled after the driver accepted: a press time from before the booking is not this trip.
    const before = new Date(sim.clock.now);
    await sim.advance(MIN);
    const { tripId: second } = await bookAndAccept(sim, rider, a);
    await rider.command(second, "cancel", { reasonCode: "plans_changed" });
    const early = await sosAt(rider, second, before);
    expect(early.status).toBe(409);
    expect(early.body).toMatchObject({ code: "invalid_transition", reason: "sos_not_during_trip" });
    // A press while the driver was coming, sent after the cancel: taken.
    expect((await sosAt(rider, second, sim.clock.now)).status).toBe(200);
  });

  it("an SOS that arrives more than 30 min after its press: 409 sos_too_old", async () => {
    const { tripId } = await bookAndAccept(sim, rider, a);
    await drive(a, tripId, "in_trip");
    const pressed = new Date(sim.clock.now);
    await complete(tripId);
    await sim.advance(31 * MIN);
    const res = await sosAt(a, tripId, pressed);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "invalid_transition", reason: "sos_too_old", projection: { tripId } });
    expect(await sosCases(tripId)).toEqual([]);
  });

  it("a phone clock that runs fast never refuses an SOS on an ended trip: pressedAt = the received time", async () => {
    const { tripId } = await endedRide();
    const received = new Date(sim.clock.now);
    const ahead = await sosAt(a, tripId, new Date(sim.clock.now.getTime() + 5 * MIN * 1000));
    expect(ahead.status, JSON.stringify(ahead.body)).toBe(200);
    expect((await safety.get(`/admin/incidents/${ahead.body["incidentId"]}`)).body).toMatchObject({ pressedAt: iso(received) });
    expect(await sosCases(tripId)).toHaveLength(1);
  });

  it("exactly 30 min after the press is still taken (inclusive limit)", async () => {
    const { tripId } = await bookAndAccept(sim, rider, a);
    await drive(a, tripId, "in_trip");
    const pressed = new Date(sim.clock.now);
    await complete(tripId);
    await sim.advance(30 * MIN - (sim.clock.now.getTime() - pressed.getTime()) / 1000);
    expect(sim.clock.now.getTime() - pressed.getTime()).toBe(30 * MIN * 1000);
    const res = await sosAt(a, tripId, pressed);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it("a live trip always takes the SOS, whatever the phone's clock says", async () => {
    const { tripId } = await bookAndAccept(sim, rider, a);
    await drive(a, tripId, "in_trip");
    const res = await sosAt(a, tripId, new Date(sim.clock.now.getTime() - 60 * MIN * 1000));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it("another driver's ended trip stays 404, a trip still searching stays 409 trip_not_live", async () => {
    const { tripId } = await endedRide();
    const other = await sim.driver(2, PLACES.medborgar);
    expect((await sosAt(other, tripId, sim.clock.now)).status).toBe(404);
    const { tripId: searching } = await rider.book();
    const res = await sosAt(rider, searching, sim.clock.now);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ reason: "trip_not_live" });
    await rider.command(searching, "cancel", { reasonCode: "plans_changed" });
  });
});
