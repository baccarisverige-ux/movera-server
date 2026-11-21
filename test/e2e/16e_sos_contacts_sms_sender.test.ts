import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sosContactsProviderFrom, sosSmsSwitchOn } from "../../src/sms/elks.js";
import { FakeCodeSms, setSmsSignIn } from "../support/smsSignIn.js";
import { bookAndAccept, drive, Driver, fakeOsrm, newKey, PLACES, Sim, until, type Admin, type Rider } from "./harness.js";

/**
 * v0.18.151 (contract.json#sosContactsSms.send; owner 2026-11-02 Q2 "Use them in SOS (Recommended)", Rules
 * decisions/driver-g14.md:12): the driver's SOS texts his emergency contacts through the SAME sender as the sign-in
 * codes (v0.18.133, the 46elks keys), only with the server switch SOS_CONTACTS_SMS_SEND on (default off). One SMS per
 * contact number per case; counted with the sign-in SMS in the country's daily SMS limit. A fake sender: no test
 * calls 46elks, no key anywhere.
 */

const GPS = { lat: 59.3331, lng: 18.0651, accuracyM: 8, at: "2026-10-27T10:00:30Z" };
const CONTACTS = [
  { name: "Mamma", phone: "0701234567", relation: "Family" },
  { name: "Pierre", phone: "+33612345678" },
  { name: "Brother", phone: "0046701112233" },
];
const outbox = (sim: Sim) => sim.db.selectFrom("sms_outbox").select(["phone", "status", "provider", "error"]).where("kind", "=", "sos_contact").orderBy("created_at").orderBy("sms_id").execute();
const sos = (sim: Sim, who: Rider | Driver, tripId: string, key = newKey("sos")) =>
  who.post(`/${who instanceof Driver ? "driver" : "rider"}/trips/${tripId}/sos`, { at: sim.clock.now.toISOString(), position: GPS }, key);

async function endTrip(sim: Sim, rider: Rider, a: Driver) {
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

describe("v0.18.151 the server switch", () => {
  it("only 'on' (any case) turns it on; no sender (keys not both set) is never on", () => {
    for (const v of ["on", "ON", " On "]) expect(sosSmsSwitchOn(v)).toBe(true);
    for (const v of [undefined, "", "off", "true", "1", "yes"]) expect(sosSmsSwitchOn(v)).toBe(false);
    const sender = new FakeCodeSms();
    expect(sosContactsProviderFrom(undefined, sender)).toBeUndefined();
    expect(sosContactsProviderFrom("on", undefined)).toBeUndefined();
    expect(sosContactsProviderFrom("on", sender)?.name).toBe("fake");
  });

  it("a refusal or no answer throws only a code: never the number, the text or a position", async () => {
    const sender = new FakeCodeSms();
    const provider = sosContactsProviderFrom("on", sender)!;
    const message = { phone: "+46701234567", text: "Movera SOS: Ali ... https://maps.google.com/?q=59.333100,18.065100", kind: "sos_contact" };
    sender.next = { accepted: false, status: 400 };
    await expect(provider.send(message)).rejects.toThrow(/^http_400$/);
    sender.next = { accepted: false };
    await expect(provider.send(message)).rejects.toThrow(/^no_answer$/);
    sender.next = { accepted: true, ref: "r1" };
    expect(await provider.send(message)).toBe("r1");
    expect(sender.sent.at(-1)).toEqual({ to: "+46701234567", text: message.text });
  });
});

describe("scenario 16e: the keys set, the switch off (default): not connected, as before", () => {
  let sim: Sim;
  let osrm: Awaited<ReturnType<typeof fakeOsrm>>;
  const sender = new FakeCodeSms();
  beforeAll(async () => {
    osrm = await fakeOsrm({ distance: 8000, duration: 1080 });
    sim = await Sim.start({ osrmUrl: osrm.url, signInSms: sender });
  });
  afterAll(async () => {
    await sim.stop();
    await osrm.close();
  });

  it("the config says not connected; the SOS keeps the rows skipped and the sender gets nothing", async () => {
    const rider = await sim.rider(0);
    const a = await sim.driver(1, PLACES.nearSergels);
    expect((await a.get("/driver/config")).body["sosContactsSms"]).toEqual({ on: true, connected: false });
    expect((await a.put("/driver/emergency-contacts", { items: CONTACTS })).status).toBe(200);
    const { tripId } = await bookAndAccept(sim, rider, a);
    const res = await sos(sim, a, tripId);
    expect(res.body["contactsSms"]).toMatchObject({ status: "not_connected", contacts: 3 });
    expect((await outbox(sim)).map((r) => r.status)).toEqual(["skipped", "skipped", "skipped"]);
    expect(sender.sent).toEqual([]);
    await endTrip(sim, rider, a);
  });
});

describe("scenario 16e: the keys set and SOS_CONTACTS_SMS_SEND=on: sent through the sign-in sender", () => {
  let sim: Sim;
  let osrm: Awaited<ReturnType<typeof fakeOsrm>>;
  let rider: Rider;
  let a: Driver;
  let safety: Admin;
  const sender = new FakeCodeSms();

  beforeAll(async () => {
    osrm = await fakeOsrm({ distance: 8000, duration: 1080 });
    sim = await Sim.start({ osrmUrl: osrm.url, signInSms: sender, env: { SOS_CONTACTS_SMS_SEND: "on" } });
    rider = await sim.rider(0);
    a = await sim.driver(1, PLACES.nearSergels);
    safety = await sim.admin("safety", ["Z001"]);
  });
  afterAll(async () => {
    await sim.stop();
    await osrm.close();
  });
  afterEach(async () => {
    await endTrip(sim, rider, a);
    await sim.db.deleteFrom("sms_outbox").execute();
    sender.sent.length = 0;
    sender.next = { accepted: true, ref: "fake-ref" };
  });

  it("queued, then sent to each contact once; a replay, a second SOS and the rider's SOS send nothing more", async () => {
    expect((await a.get("/driver/config")).body["sosContactsSms"]).toEqual({ on: true, connected: true });
    expect((await a.put("/driver/emergency-contacts", { items: CONTACTS })).status).toBe(200);
    const { tripId } = await bookAndAccept(sim, rider, a);
    const key = newKey("sos");
    const res = await sos(sim, a, tripId, key);
    expect(res.status).toBe(200);
    expect(res.body["contactsSms"]).toMatchObject({ status: "queued", contacts: 3 });
    const id = res.body["incidentId"];
    expect(await until(async () => (await safety.get(`/admin/incidents/${id}`)).body["contactsSms"]?.status === "sent")).toBe(true);
    expect((await safety.get(`/admin/incidents/${id}`)).body["contactsSms"]).toMatchObject({ status: "sent", contacts: 3, sent: 3 });
    expect(sender.sent.map((m) => m.to)).toEqual(["+46701234567", "+33612345678", "+46701112233"]);
    expect(sender.sent[0]!.text).toContain("https://maps.google.com/?q=59.333100,18.065100");
    expect((await outbox(sim)).map((r) => [r.status, r.provider])).toEqual([["sent", "fake"], ["sent", "fake"], ["sent", "fake"]]);
    // The app's retry (same key), a new press, the rider's SOS: one case, no new SMS.
    expect((await sos(sim, a, tripId, key)).body).toEqual(res.body);
    expect((await sos(sim, a, tripId)).body["incidentId"]).toBe(id);
    expect((await sos(sim, rider, tripId)).body["incidentId"]).toBe(id);
    await sim.advance(5);
    expect(sender.sent).toHaveLength(3);
    expect(await outbox(sim)).toHaveLength(3);
  });

  it("the same number stored twice gets one SMS", async () => {
    expect((await a.put("/driver/emergency-contacts", { items: [CONTACTS[0], { name: "Mamma again", phone: "+46701234567" }] })).status).toBe(200);
    const { tripId } = await bookAndAccept(sim, rider, a);
    const res = await sos(sim, a, tripId);
    expect(res.body["contactsSms"]).toMatchObject({ status: "queued", contacts: 2 });
    expect(await until(async () => sender.sent.length === 1)).toBe(true);
    await sim.advance(5);
    expect(sender.sent.map((m) => m.to)).toEqual(["+46701234567"]);
    expect(await outbox(sim)).toHaveLength(1);
  });

  it("the daily SMS limit counts sign-in and SOS SMS: at the limit the rest is skipped (daily_limit); a refusal is failed http_4xx", async () => {
    await setSmsSignIn(sim.db, "SE", { enabled: false, dailyCap: 10 }, sim.clock.now);
    // 9 sign-in SMS to Swedish numbers in the last 24 h: room for one more.
    for (let i = 0; i < 9; i++) {
      await sim.db.insertInto("sms_outbox").values({ sms_id: `sms_cap_${i}`, phone: `+4670000000${i}`, text: "Movera: ••••••", kind: "sign_in_code", status: "sent", provider: "fake", created_at: new Date(sim.clock.now.getTime() - 3_600_000) }).execute();
    }
    expect((await a.put("/driver/emergency-contacts", { items: CONTACTS })).status).toBe(200);
    const { tripId } = await bookAndAccept(sim, rider, a);
    sender.next = { accepted: false, status: 400 };
    const res = await sos(sim, a, tripId);
    expect(res.body["contactsSms"]).toMatchObject({ status: "queued", contacts: 3 });
    const id = res.body["incidentId"];
    expect(await until(async () => (await safety.get(`/admin/incidents/${id}`)).body["contactsSms"]?.status === "failed")).toBe(true);
    expect((await outbox(sim)).map((r) => [r.phone, r.status, r.error])).toEqual([
      ["+46701234567", "failed", "http_400"],
      ["+33612345678", "skipped", "daily_limit"],
      ["+46701112233", "skipped", "daily_limit"],
    ]);
    expect(sender.sent).toHaveLength(1);
    await setSmsSignIn(sim.db, "SE", undefined, sim.clock.now);
  });
});
