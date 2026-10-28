import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { bookAndAccept, drive, Driver, fakeOsrm, newKey, PLACES, Sim, type Admin, type Rider, type Stream } from "./harness.js";

/**
 * Safety part 2 (contract v0.12.0 §22, owner decisions 2026-10-28): ride check answers. ok stays on the trip, need_help
 * opens the alarm case (rings, escalates after 2 min), no answer within 2 min opens a silent case.
 *
 * (Harness setup copied from scenario 16.) Safety part 1 (contract v0.7.0 §15, owner decisions 2026-10-27): the rider's and the driver's SOS reach Movera as
 * one incident per trip, the zone's safety admins hear it first and every signed-in admin after 2 minutes untaken,
 * admins take / solve / call a false alarm, and "car lost" opens an incident that closes itself when the car is back.
 */

let sim: Sim;
let osrm: Awaited<ReturnType<typeof fakeOsrm>>;
let rider: Rider;
let a: Driver;
let safety: Admin;
let otherZone: Admin;
let finance: Admin;
let feeds: { safety: Stream; otherZone: Stream; finance: Stream };

const GPS = { lat: 59.3331, lng: 18.0651, accuracyM: 8, at: "2026-10-27T10:00:30Z" };

beforeAll(async () => {
  osrm = await fakeOsrm({ distance: 8000, duration: 1080 });
  sim = await Sim.start({ osrmUrl: osrm.url });
  rider = await sim.rider(0);
  a = await sim.driver(1, PLACES.nearSergels);
  safety = await sim.admin("safety", ["Z001"]);
  otherZone = await sim.admin("safety", ["Z999"]);
  finance = await sim.admin("finance");
  feeds = {
    safety: await sim.stream("/admin/incidents/stream", safety.token),
    otherZone: await sim.stream("/admin/incidents/stream", otherZone.token),
    finance: await sim.stream("/admin/incidents/stream", finance.token),
  };
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
    else if (trip && ["rider_onboard", "in_trip", "approaching_dropoff"].includes(trip["status"])) {
      await drive(a, active.body.tripId, "in_trip");
      await sim.advance(60);
      await a.moveTo(PLACES.medborgar);
      await a.command(active.body.tripId, "complete");
    }
  }
  await sim.advance(5);
  await a.moveTo(PLACES.nearSergels);
});

const check = (who: Rider | Driver, tripId: string, checkId: string, answer?: "ok" | "need_help", key?: string, trigger = "long_stop") =>
  who.post(`/${who instanceof Driver ? "driver" : "rider"}/trips/${tripId}/ride-check`, { checkId, trigger, at: sim.clock.now.toISOString(), ...(answer ? { answer } : {}), position: GPS }, key);
const rideCheckCases = async (tripId: string) => (await safety.get(`/admin/incidents?kind=ride_check&tripId=${tripId}`)).body.items as Record<string, unknown>[];

describe("scenario 21: ride check answers", () => {
  it("I'm OK is only saved on the trip: no case, no alarm, even after two minutes", async () => {
    const { tripId } = await bookAndAccept(sim, rider, a);
    expect((await check(rider, tripId, "rc-ok-1")).status).toBe(200);
    const key = newKey("rc");
    const ok = await check(rider, tripId, "rc-ok-1", "ok", key);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ checkId: "rc-ok-1", tripId, answer: "ok", receivedAt: expect.any(String) });
    expect(ok.body["incidentId"]).toBeUndefined();
    expect((await check(rider, tripId, "rc-ok-1", "ok", key)).body).toEqual(ok.body);
    await sim.advance(130);
    await sim.tick();
    expect(await rideCheckCases(tripId)).toEqual([]);
  });

  it("I need help opens the alarm case at once, rings and escalates after two minutes; later answers join it", async () => {
    const { tripId } = await bookAndAccept(sim, rider, a);
    await check(a, tripId, "rc-help-1", undefined, undefined, "off_route");
    const help = await check(a, tripId, "rc-help-1", "need_help");
    expect(help.status).toBe(200);
    expect(help.body).toMatchObject({ answer: "need_help", incidentId: expect.stringMatching(/^inc_/) });
    const id = help.body["incidentId"];
    const opened = await feeds.safety.waitFor((e) => e.data["kind"] === "incident_opened" && e.data["incident"]["incidentId"] === id);
    expect(opened.data["incident"]).toMatchObject({
      kind: "ride_check", severity: "critical", alarm: true, raisedBy: "driver", tripId, zoneId: "Z001", position: GPS,
      rideCheck: { checkId: "rc-help-1", trigger: "off_route", by: "driver", answer: "need_help", shownAt: expect.any(String), answeredAt: expect.any(String) },
    });
    // need_help then ok keeps need_help; the rider's own need_help joins the same case.
    expect((await check(a, tripId, "rc-help-1", "ok")).body).toMatchObject({ answer: "need_help", incidentId: id });
    expect((await check(rider, tripId, "rc-r-1", "need_help")).body["incidentId"]).toBe(id);
    await sim.advance(125);
    await feeds.finance.waitFor((e) => e.data["kind"] === "incident_escalated" && e.data["incident"]["incidentId"] === id);
    expect(await rideCheckCases(tripId)).toHaveLength(1);
    await safety.post(`/admin/incidents/${id}/resolve`, { expectedVersion: 1, note: "Spoke with driver" });
  });

  it("no answer within two minutes opens a silent case (no alarm, never escalated); a later need_help turns it into the alarm", async () => {
    const { tripId } = await bookAndAccept(sim, rider, a);
    expect((await check(rider, tripId, "rc-silent-1", undefined, undefined, "possible_crash")).body["answer"]).toBeUndefined();
    await sim.advance(60);
    await sim.tick();
    expect(await rideCheckCases(tripId)).toEqual([]);
    await sim.advance(65);
    await sim.tick();
    const opened = await feeds.safety.waitFor((e) => e.data["kind"] === "incident_opened" && e.data["incident"]["tripId"] === tripId && e.data["incident"]["kind"] === "ride_check");
    const id = opened.data["incident"]["incidentId"];
    expect(opened.data["incident"]).toMatchObject({ alarm: false, raisedBy: "system", rideCheck: { checkId: "rc-silent-1", by: "rider", answer: "no_answer", trigger: "possible_crash" } });
    expect((await rideCheckCases(tripId)).map((i) => i["incidentId"])).toEqual([id]);
    // Never escalated.
    await sim.advance(180);
    await sim.tick();
    expect(feeds.finance.events.filter((e) => e.data["incident"]["incidentId"] === id)).toEqual([]);
    // Late "ok" is kept on the case.
    const late = await check(rider, tripId, "rc-silent-1", "ok");
    expect(late.body).toMatchObject({ answer: "ok", incidentId: id });
    const afterOk = await safety.get(`/admin/incidents/${id}`);
    expect(afterOk.body).toMatchObject({ alarm: false, version: 2, rideCheck: { answer: "no_answer", lateAnswer: "ok" } });
    // The driver asks for help: the same case rings and escalates two minutes later.
    expect((await check(a, tripId, "rc-d-2", "need_help")).body["incidentId"]).toBe(id);
    const updated = await feeds.safety.waitFor((e) => e.data["kind"] === "incident_updated" && e.data["incident"]["incidentId"] === id && e.data["incident"]["alarm"] === true);
    expect(updated.data["incident"]).toMatchObject({ raisedBy: "driver", rideCheck: { checkId: "rc-d-2", by: "driver", answer: "need_help" } });
    await sim.advance(125);
    await feeds.finance.waitFor((e) => e.data["kind"] === "incident_escalated" && e.data["incident"]["incidentId"] === id);
    await safety.post(`/admin/incidents/${id}/dismiss`, { expectedVersion: 3 });
  });

  it("only the trip's own rider or driver, during the trip or shortly after it; bad bodies are 400", async () => {
    const other = await sim.rider(1);
    const { tripId } = await bookAndAccept(sim, rider, a);
    expect((await check(other, tripId, "x1", "ok")).status).toBe(404);
    expect((await rider.post(`/rider/trips/${tripId}/ride-check`, { checkId: "x2", trigger: "nope", at: sim.clock.now.toISOString() })).status).toBe(400);
    expect((await rider.post(`/rider/trips/${tripId}/ride-check`, { checkId: "x2", trigger: "long_stop", at: sim.clock.now.toISOString(), answer: "maybe" })).status).toBe(400);
    await rider.command(tripId, "cancel", { reasonCode: "plans_changed" });
    const ended = await check(rider, tripId, "x3", "need_help");
    expect(ended.status).toBe(409);
    expect(ended.body).toMatchObject({ code: "invalid_transition", reason: "trip_not_live" });
  });

  it("dropped far: a check right after the trip completed is accepted", async () => {
    const { tripId } = await bookAndAccept(sim, rider, a);
    await drive(a, tripId, "in_trip");
    await sim.advance(60);
    await a.moveTo(PLACES.medborgar);
    expect((await a.command(tripId, "complete")).status).toBe(200);
    const r = await check(rider, tripId, "rc-far-1", "ok", undefined, "dropped_far");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ answer: "ok" });
  });
});
