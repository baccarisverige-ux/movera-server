import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SmsMessage, SmsProvider } from "../../src/sms/sms.js";
import { bookAndAccept, drive, Driver, fakeOsrm, newKey, PLACES, Sim, until, type Admin, type Rider } from "./harness.js";

/**
 * v0.18.101 §92 (BQ-V34 = BQ-S12; owner 2026-11-02 Q2 "Use them in SOS (Recommended)", Rules decisions/driver-g14.md:12):
 * the driver's SOS = emergency call + Movera alert + one SMS with his position to each of his emergency contacts,
 * with an admin on/off (CountryRules.sosContactsSms, country standard only). No SMS company is connected yet, so the
 * rows are kept as skipped and the result says not_connected; with one, they are handed over after the SOS is saved.
 */

const GPS = { lat: 59.3331, lng: 18.0651, accuracyM: 8, at: "2026-10-27T10:00:30Z" };
const CONTACTS = [
  { name: "Mamma", phone: "0701234567", relation: "Family" },
  { name: "Pierre", phone: "+33612345678" },
  { name: "Brother", phone: "0046701112233" },
];
const outbox = (sim: Sim) => sim.db.selectFrom("sms_outbox").select(["phone", "text", "status", "kind", "provider"]).where("kind", "=", "sos_contact").orderBy("created_at").orderBy("sms_id").execute();
const sos = (sim: Sim, who: Rider | Driver, tripId: string, position: unknown = GPS) =>
  who.post(`/${who instanceof Driver ? "driver" : "rider"}/trips/${tripId}/sos`, { at: sim.clock.now.toISOString(), ...(position ? { position } : {}) }, newKey("sos"));

async function endTrip(sim: Sim, rider: Rider, a: Driver) {
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
}

describe("scenario 16c: the driver's SOS texts his emergency contacts (no SMS company: not connected)", () => {
  let sim: Sim;
  let osrm: Awaited<ReturnType<typeof fakeOsrm>>;
  let rider: Rider;
  let a: Driver;
  let safety: Admin;
  let owner: Admin;
  let firstName: string;

  beforeAll(async () => {
    osrm = await fakeOsrm({ distance: 8000, duration: 1080 });
    sim = await Sim.start({ osrmUrl: osrm.url });
    rider = await sim.rider(0);
    a = await sim.driver(1, PLACES.nearSergels);
    safety = await sim.admin("safety", ["Z001"]);
    owner = await sim.owner();
    firstName = (await sim.db.selectFrom("drivers").select("first_name").where("driver_id", "=", a.id).executeTakeFirstOrThrow()).first_name;
  });
  afterAll(async () => {
    await sim.stop();
    await osrm.close();
  });
  afterEach(async () => {
    await endTrip(sim, rider, a);
    await sim.db.deleteFrom("sms_outbox").where("kind", "=", "sos_contact").execute();
  });

  it("the driver config says the switch is on and no SMS company is connected", async () => {
    const config = await a.get("/driver/config");
    expect(config.status).toBe(200);
    expect(config.body["sosContactsSms"]).toEqual({ on: true, connected: false });
  });

  it("no contacts: no_contacts, nothing written", async () => {
    const { tripId } = await bookAndAccept(sim, rider, a);
    const res = await sos(sim, a, tripId);
    expect(res.status).toBe(200);
    expect(res.body["contactsSms"]).toEqual({ status: "no_contacts", contacts: 0, at: expect.any(String) });
    expect(await outbox(sim)).toEqual([]);
  });

  it("the first driver SOS keeps one skipped SMS per contact (international number, map link, first name, 112); repeats send nothing more; admin sees it", async () => {
    expect((await a.put("/driver/emergency-contacts", { items: CONTACTS })).status).toBe(200);
    const { tripId } = await bookAndAccept(sim, rider, a);
    const first = await sos(sim, a, tripId);
    expect(first.status).toBe(200);
    expect(first.body["contactsSms"]).toEqual({ status: "not_connected", contacts: 3, at: sim.clock.now.toISOString() });
    const rows = await outbox(sim);
    expect(rows.map((r) => r.phone)).toEqual(["+46701234567", "+33612345678", "+46701112233"]);
    for (const row of rows) {
      expect(row).toMatchObject({ status: "skipped", kind: "sos_contact", provider: null });
      expect(row.text).toContain(firstName);
      expect(row.text).toContain("https://maps.google.com/?q=59.333100,18.065100");
      expect(row.text).toContain("112");
    }
    // Pressed again (new key) or by the rider: the same case, nothing more is sent, the stored result comes back.
    const again = await sos(sim, a, tripId);
    expect(again.body["incidentId"]).toBe(first.body["incidentId"]);
    expect(again.body["contactsSms"]).toEqual(first.body["contactsSms"]);
    const riderSos = await sos(sim, rider, tripId);
    expect(riderSos.body["contactsSms"]).toBeUndefined();
    expect(await outbox(sim)).toHaveLength(3);
    // The admin case shows the result.
    const detail = await safety.get(`/admin/incidents/${first.body["incidentId"]}`);
    expect(detail.body["contactsSms"]).toEqual(first.body["contactsSms"]);
  });

  it("a rider SOS texts nobody; the driver's SOS on the rider's case still texts his contacts", async () => {
    const { tripId } = await bookAndAccept(sim, rider, a);
    const riderSos = await sos(sim, rider, tripId);
    expect(riderSos.status).toBe(200);
    expect(riderSos.body["contactsSms"]).toBeUndefined();
    expect(await outbox(sim)).toEqual([]);
    expect((await safety.get(`/admin/incidents/${riderSos.body["incidentId"]}`)).body["contactsSms"]).toBeUndefined();
    const driverSos = await sos(sim, a, tripId, null);
    expect(driverSos.body["incidentId"]).toBe(riderSos.body["incidentId"]);
    expect(driverSos.body["contactsSms"]).toMatchObject({ status: "not_connected", contacts: 3 });
    // No GPS in the body: the car's latest position the server has.
    const rows = await outbox(sim);
    expect(rows).toHaveLength(3);
    expect(rows[0]!.text).toMatch(/https:\/\/maps\.google\.com\/\?q=\d+\.\d{6},\d+\.\d{6}/);
  });

  it("the switch is set on the country standard only; off: no SMS, the SOS still works", async () => {
    const zonePut = await owner.put(`/admin/config/country_rules`, { expectedVersion: 1, zoneId: "Z001", document: { country: "SE", currency: "SEK", tips: [], raiseSteps: [], driverBonus: { maxMinor: 0 }, sosContactsSms: false } });
    expect(zonePut.status).toBe(400);
    expect(zonePut.body).toMatchObject({ code: "invalid_request", reason: "sos_sms_country_only" });
    await sim.publish(owner, "country_rules", "SE", (doc) => ({ ...doc, sosContactsSms: false }));
    await until(async () => (await a.get("/driver/config")).body["sosContactsSms"]?.on === false);
    const { tripId } = await bookAndAccept(sim, rider, a);
    const res = await sos(sim, a, tripId);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ incidentId: expect.stringMatching(/^inc_/), contactsSms: { status: "off", contacts: 0 } });
    expect(await outbox(sim)).toEqual([]);
    await sim.publish(owner, "country_rules", "SE", (doc) => ({ ...doc, sosContactsSms: true }));
  });
});

describe("scenario 16c: with an SMS company the SMS go after the SOS is saved", () => {
  let sim: Sim;
  let osrm: Awaited<ReturnType<typeof fakeOsrm>>;
  let rider: Rider;
  let a: Driver;
  let safety: Admin;
  const sent: SmsMessage[] = [];
  const provider: SmsProvider = {
    name: "fake",
    async send(message) {
      if (message.phone.startsWith("+33")) throw new Error("refused by the fake company");
      sent.push(message);
      return `ref-${sent.length}`;
    },
  };

  beforeAll(async () => {
    osrm = await fakeOsrm({ distance: 8000, duration: 1080 });
    sim = await Sim.start({ osrmUrl: osrm.url, sms: provider });
    rider = await sim.rider(0);
    a = await sim.driver(1, PLACES.nearSergels);
    safety = await sim.admin("safety", ["Z001"]);
  });
  afterAll(async () => {
    await endTrip(sim, rider, a);
    await sim.stop();
    await osrm.close();
  });

  it("queued in the answer, then sent (2 of 3 accepted) on the case; the config says connected", async () => {
    expect((await a.get("/driver/config")).body["sosContactsSms"]).toEqual({ on: true, connected: true });
    expect((await a.put("/driver/emergency-contacts", { items: CONTACTS })).status).toBe(200);
    const { tripId } = await bookAndAccept(sim, rider, a);
    const res = await sos(sim, a, tripId);
    expect(res.status).toBe(200);
    expect(res.body["contactsSms"]).toMatchObject({ status: "queued", contacts: 3 });
    const id = res.body["incidentId"];
    await until(async () => (await safety.get(`/admin/incidents/${id}`)).body["contactsSms"]?.status === "sent");
    expect((await safety.get(`/admin/incidents/${id}`)).body["contactsSms"]).toMatchObject({ status: "sent", contacts: 3, sent: 2 });
    expect(sent.map((m) => m.phone)).toEqual(["+46701234567", "+46701112233"]);
    const rows = await outbox(sim);
    expect(rows.map((r) => [r.phone, r.status, r.provider])).toEqual([
      ["+46701234567", "sent", "fake"],
      ["+33612345678", "failed", "fake"],
      ["+46701112233", "sent", "fake"],
    ]);
  });
});
