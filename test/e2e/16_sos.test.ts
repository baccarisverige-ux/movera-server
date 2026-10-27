import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { bookAndAccept, drive, Driver, fakeOsrm, newKey, PLACES, Sim, until, type Admin, type Rider, type Stream } from "./harness.js";

/**
 * Safety part 1 (contract v0.7.0 §15, owner decisions 2026-10-27): the rider's and the driver's SOS reach Movera as
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

const sos = (who: Rider | Driver, tripId: string, key?: string, position: unknown = GPS) =>
  who.post(`/${who instanceof Driver ? "driver" : "rider"}/trips/${tripId}/sos`, { at: sim.clock.now.toISOString(), ...(position ? { position } : {}) }, key);

describe("scenario 16: SOS and incidents", () => {
  it("rider SOS during a live trip opens one incident with the phone's GPS and the car's position; repeats and the driver's SOS return it", async () => {
    const { tripId } = await bookAndAccept(sim, rider, a);
    const key = newKey("sos");
    const first = await sos(rider, tripId, key);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ tripId, incidentId: expect.stringMatching(/^inc_/), receivedAt: expect.any(String) });
    // The app retries with the same key: the same answer.
    const retry = await sos(rider, tripId, key);
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual(first.body);
    // Pressed again, or by the driver: still the one incident.
    expect((await sos(rider, tripId)).body["incidentId"]).toBe(first.body["incidentId"]);
    const driverSos = await sos(a, tripId);
    expect(driverSos.status).toBe(200);
    expect(driverSos.body["incidentId"]).toBe(first.body["incidentId"]);

    const detail = await safety.get(`/admin/incidents/${first.body["incidentId"]}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      incidentId: first.body["incidentId"], tripId, kind: "sos", severity: "critical", status: "open", version: 1,
      raisedBy: "rider", zoneId: "Z001", riderId: rider.id, driverId: a.id, position: GPS,
      driverPosition: { lat: expect.any(Number), lng: expect.any(Number), measuredAt: expect.any(String) },
    });
    const list = await safety.get(`/admin/incidents?status=open&kind=sos`);
    expect(list.body.items.map((i: { incidentId: string }) => i.incidentId)).toContain(first.body["incidentId"]);
    // Zone-scoped: another zone's admin neither reads it nor lists it.
    expect((await otherZone.get(`/admin/incidents/${first.body["incidentId"]}`)).status).toBe(403);
    expect((await otherZone.get(`/admin/incidents`)).body.items).toEqual([]);

    // The alarm: the zone's safety admin at once; the other zone and an admin without incidents.read not yet.
    await feeds.safety.waitFor((e) => e.data["kind"] === "incident_opened" && e.data["incident"]["incidentId"] === first.body["incidentId"]);
    await sim.advance(60);
    expect(feeds.otherZone.events.filter((e) => e.data["incident"]["incidentId"] === first.body["incidentId"])).toEqual([]);
    expect(feeds.finance.events.filter((e) => e.data["incident"]["incidentId"] === first.body["incidentId"])).toEqual([]);
    // Two minutes untaken: every signed-in admin.
    await sim.advance(65);
    for (const feed of [feeds.safety, feeds.otherZone, feeds.finance]) {
      const escalated = await feed.waitFor((e) => e.data["kind"] === "incident_escalated" && e.data["incident"]["incidentId"] === first.body["incidentId"]);
      expect(escalated.data["incident"]["escalatedAt"]).toEqual(expect.any(String));
    }

    // Take → Solved, with the checks on the way.
    const id = first.body["incidentId"];
    const taken = await safety.post(`/admin/incidents/${id}/take`, { expectedVersion: 1 });
    expect(taken.status).toBe(200);
    expect(taken.body).toMatchObject({ status: "investigating", version: 2, takenBy: safety.id, takenAt: expect.any(String) });
    const again = await safety.post(`/admin/incidents/${id}/take`, { expectedVersion: 2 });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: "invalid_transition", projection: { status: "investigating" } });
    const stale = await safety.post(`/admin/incidents/${id}/resolve`, { expectedVersion: 1, note: "Rider safe" });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: "version_mismatch", projection: { version: 2 } });
    expect((await otherZone.post(`/admin/incidents/${id}/resolve`, { expectedVersion: 2 })).status).toBe(403);
    expect((await finance.post(`/admin/incidents/${id}/resolve`, { expectedVersion: 2 })).status).toBe(403);
    const solved = await safety.post(`/admin/incidents/${id}/resolve`, { expectedVersion: 2, note: "Rider safe, spoke on the phone" });
    expect(solved.status).toBe(200);
    expect(solved.body).toMatchObject({ status: "resolved", resolvedBy: safety.id, resolution: "Rider safe, spoke on the phone" });
    await feeds.finance.waitFor((e) => e.data["kind"] === "incident_closed" && e.data["incident"]["incidentId"] === id);
    const audit = await (await sim.owner()).get(`/admin/audit?targetId=${id}`);
    expect(audit.body.items.map((e: { action: string }) => e.action).sort()).toEqual(["incident.open", "incident.resolve", "incident.take"]);

    // Closed: a new SOS on the same trip opens a new incident.
    const next = await sos(a, tripId, undefined, null);
    expect(next.status).toBe(200);
    expect(next.body["incidentId"]).not.toBe(id);
    const dismissed = await safety.post(`/admin/incidents/${next.body["incidentId"]}/dismiss`, { expectedVersion: 1, note: "Pressed by mistake" });
    expect(dismissed.body).toMatchObject({ status: "dismissed", raisedBy: "driver", resolution: "Pressed by mistake" });
    expect(dismissed.body["position"]).toBeUndefined();
    // The polling fallback reads the same feed as JSON.
    const page = await safety.get(`/admin/incidents/stream?after=0`);
    expect(page.body.items.map((e: { kind: string }) => e.kind)).toEqual(expect.arrayContaining(["incident_opened", "incident_escalated", "incident_updated", "incident_closed"]));
  });

  it("SOS only from the trip's own rider or driver, only while the trip is live", async () => {
    const other = await sim.rider(1);
    const { tripId } = await bookAndAccept(sim, rider, a);
    expect((await sos(other, tripId)).status).toBe(404);
    expect((await sos(rider, "trp_nosuchtrip0000000000000")).status).toBe(404);
    const bad = await rider.post(`/rider/trips/${tripId}/sos`, { position: GPS });
    expect(bad.status).toBe(400);
    await rider.command(tripId, "cancel", { reasonCode: "plans_changed" });
    const ended = await sos(rider, tripId);
    expect(ended.status).toBe(409);
    expect(ended.body).toMatchObject({ code: "invalid_transition", reason: "trip_not_live", projection: { tripId } });
    expect((await sos(a, tripId)).status).toBe(409);
  });

  it("car lost: no driver position for 30 min with the rider on board opens a critical incident that closes itself when the car is back", async () => {
    const { tripId } = await bookAndAccept(sim, rider, a);
    await drive(a, tripId, "rider_onboard");
    sim.driverApps.delete(a); // the phone dies
    await sim.advance(31 * 60);
    const opened = await feeds.safety.waitFor((e) => e.data["kind"] === "incident_opened" && e.data["incident"]["tripId"] === tripId && e.data["incident"]["kind"] === "driver_silent");
    expect(opened.data["incident"]).toMatchObject({ severity: "critical", raisedBy: "system", status: "open", zoneId: "Z001" });
    expect((await safety.get(`/admin/trips/${tripId}`)).body["driverSilentAlert"]).toMatchObject({ kind: "driver_silent" });
    await sim.advance(125);
    await feeds.finance.waitFor((e) => e.data["kind"] === "incident_escalated" && e.data["incident"]["incidentId"] === opened.data["incident"]["incidentId"]);
    // The phone is back.
    await a.moveTo(PLACES.sergels);
    await sim.tick();
    const closed = await feeds.safety.waitFor((e) => e.data["kind"] === "incident_closed" && e.data["incident"]["incidentId"] === opened.data["incident"]["incidentId"]);
    expect(closed.data["incident"]).toMatchObject({ status: "resolved", resolution: "position back" });
    expect(closed.data["incident"]["resolvedBy"]).toBeUndefined();
    expect(await until(async () => (await safety.get(`/admin/trips/${tripId}`)).body["driverSilentAlert"] === undefined)).toBe(true);
  });
});
