import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runSmartSurge } from "../../src/pricing/surge.js";
import { drive, fakeOsrm, PLACES, Sim, type Admin, type Driver, type Json, type Rider } from "./harness.js";

/**
 * Contract v0.7.1, owner Pricing decisions of 2026-10-27: waiting at a middle stop from the driver's arrival to
 * leaving, the manual surge Start / Stop within the admin's maximum, "Tell drivers", smart surge (off by default),
 * the booked price kept, pricing history and Restore with one audit line per publish, and the car type catalog.
 */

let sim: Sim;
let osrm: Awaited<ReturnType<typeof fakeOsrm>>;
let riders: Rider[];
let a: Driver;
let owner: Admin;

beforeAll(async () => {
  osrm = await fakeOsrm({ distance: 8000, duration: 1080 });
  sim = await Sim.start({ osrmUrl: osrm.url });
  riders = [await sim.rider(0), await sim.rider(1), await sim.rider(2)];
  a = await sim.driver(1, PLACES.nearSergels);
  owner = await sim.owner();
});
afterAll(async () => {
  await sim.stop();
  await osrm.close();
});
afterEach(async () => {
  for (const rider of riders) {
    const active = await rider.get("/rider/trips/active");
    if (active.status === 200) await rider.command(active.body.tripId, "cancel", { reasonCode: "plans_changed" });
  }
  await sim.advance(5);
  await a.moveTo(PLACES.nearSergels);
});

const sek = (amountMinor: number) => ({ amountMinor, currency: "SEK" });
const line = (fare: Json, code: string) => (fare["fareLines"] as Array<{ code: string; amount: unknown }>).find((l) => l.code === code);
const STOP = { address: "Odenplan", ...PLACES.odenplan };

async function bookAccepted(rider: Rider, body: Json = {}): Promise<string> {
  const trip = { pickup: PLACES.sergels, dropoff: PLACES.medborgar, stops: [] as Json[], ...body };
  const quoted = await rider.quote({ ...trip, categoryIds: ["economy"] });
  expect(quoted.status, JSON.stringify(quoted.body)).toBe(201);
  const booked = await rider.post("/trips", { quoteId: quoted.body["quotes"][0].quoteId, categoryId: "economy", ...trip, kind: "live", paymentMethod: "cash" });
  expect(booked.status, JSON.stringify(booked.body)).toBe(201);
  const tripId = booked.body["tripId"];
  await sim.tick();
  const offer = await a.offerFor(tripId);
  expect(offer).toBeTruthy();
  expect((await a.accept(offer!)).status).toBe(200);
  return tripId;
}

const stop = async (tripId: string, index: number, verb: "arrive" | "leave") => a.post(`/driver/trips/${tripId}/stops/${index}/${verb}`, { expectedVersion: (await a.trip(tripId))["version"] });

describe("waiting at a middle stop (§3.8)", () => {
  it("is charged from Framme vid stoppet to leaving, no free minutes, 100 % to the driver", async () => {
    const tripId = await bookAccepted(riders[0]!, { stops: [STOP] });
    // Not before the trip has started.
    await drive(a, tripId, "rider_onboard");
    expect((await stop(tripId, 0, "arrive")).body.reason).toBe("not_on_trip");
    await drive(a, tripId, "in_trip");
    expect((await stop(tripId, 0, "leave")).body.reason).toBe("stop_not_arrived");
    expect((await stop(tripId, 1, "arrive")).status).toBe(404);
    const before = await a.trip(tripId);
    const arrived = await stop(tripId, 0, "arrive");
    expect(arrived.status, JSON.stringify(arrived.body)).toBe(200);
    expect(arrived.body.stopVisits).toEqual([{ stopIndex: 0, arrivedAt: sim.clock.now.toISOString() }]);
    expect((await stop(tripId, 0, "arrive")).body.reason).toBe("stop_already_arrived");
    await sim.advance(4 * 60);
    const left = await stop(tripId, 0, "leave");
    expect(left.status).toBe(200);
    expect(left.body.stopVisits[0].leftAt).toBe(sim.clock.now.toISOString());
    expect((await stop(tripId, 0, "leave")).body.reason).toBe("stop_already_left");
    await sim.advance(10 * 60);
    await a.moveTo(PLACES.medborgar);
    const done = await a.command(tripId, "complete");
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    // 4 min × 5 kr (economy stopWaitPerMin), every minute charged; its 10 % app fee goes to Movera.
    expect(line(done.body, "stop_waiting")).toEqual({ code: "stop_waiting", amount: sek(2000) });
    expect(done.body.fare.amountMinor - before.fare.amountMinor).toBe(2200);
    expect(done.body.driverEarnings.amountMinor - before.driverEarnings.amountMinor).toBe(2000);
    expect(done.body.fareLines.reduce((sum: number, l: Json) => sum + l.amount.amountMinor, 0)).toBe(done.body.fare.amountMinor);
  });
});

describe("manual surge Start / Stop, the booked price and Tell drivers", () => {
  it("starts within the admin's maximum, prices new quotes, keeps a booked trip's price, tells drivers, and stops", async () => {
    await sim.publish(owner, "pricing", "Z001", (doc) => ({ ...doc, surge: { ...doc["surge"], maxMultiplier: 3, notifyDrivers: true } }));
    const tripId = await bookAccepted(riders[1]!);
    const bookedFare = (await riders[1]!.trip(tripId))["fare"];

    const start = sim.clock.now.toISOString();
    const end = new Date(sim.clock.now.getTime() + 60 * 60_000).toISOString();
    const flat = (m: number) => ({ expectedVersion: 0, startAt: start, endAt: end, points: [{ atMin: 0, multiplier: m }, { atMin: 60, multiplier: m }] });
    const tooHigh = await owner.put("/admin/zones/Z001/surge", flat(4));
    expect(tooHigh.status).toBe(400);
    expect(tooHigh.body.reason).toBe("invalid_surge");
    const started = await owner.put("/admin/zones/Z001/surge", flat(2));
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect(started.body).toMatchObject({ status: "active", cap: 3, version: 1 });
    expect((await owner.get("/admin/zones/Z001/surge")).body.scheduleId).toBe(started.body.scheduleId);

    const surged = (await riders[0]!.quote({ categoryIds: ["economy"] })).body["quotes"][0];
    expect(surged).toMatchObject({ surgeMultiplier: 2, surge: { multiplier: 2, until: end } });

    // "Tell drivers when a surge starts" and "Tell drivers now": an in-app notice to the zone's online drivers.
    const notices = (await a.get("/notifications")).body["items"] as Json[];
    expect(notices.find((n) => n["kind"] === "surge_started")).toMatchObject({ data: { zoneId: "Z001", multiplier: 2, until: end } });
    const told = await owner.post("/admin/zones/Z001/surge/notify", {});
    expect(told.status, JSON.stringify(told.body)).toBe(200);
    expect(told.body).toEqual({ notified: 1, multiplier: 2 });

    // The trip booked before the surge keeps its price to the end.
    await drive(a, tripId, "in_trip");
    await sim.advance(18 * 60);
    await a.moveTo(PLACES.medborgar);
    const done = await a.command(tripId, "complete");
    expect(done.body.fare).toEqual(bookedFare);
    expect(line(done.body, "surge")).toBeUndefined();

    const stopped = await owner.post("/admin/zones/Z001/surge/end", { expectedVersion: 1 });
    expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
    expect(stopped.body.status).toBe("ended");
    expect((await owner.get("/admin/zones/Z001/surge")).status).toBe(204);
    expect((await riders[0]!.quote({ categoryIds: ["economy"] })).body["quotes"][0].surgeMultiplier).toBe(1);
    const nothing = await owner.post("/admin/zones/Z001/surge/notify", {});
    expect(nothing.status).toBe(409);
    expect(nothing.body.reason).toBe("no_surge");
  });
});

describe("smart surge (contract.json#smartSurge)", () => {
  it("is off by default; switched on it rises after the demand held, within the profile's cap", async () => {
    const check = () => sim.db.transaction().execute((trx) => runSmartSurge(trx, sim.clock.now));
    const quoteMultiplier = async () => (await riders[0]!.quote({ categoryIds: ["economy"] })).body["quotes"][0].surgeMultiplier;
    const demand = async () => {
      for (const rider of riders) {
        const quoted = await rider.quote({ categoryIds: ["economy"] });
        const booked = await rider.post("/trips", { quoteId: quoted.body["quotes"][0].quoteId, categoryId: "economy", pickup: PLACES.sergels, dropoff: PLACES.medborgar, stops: [], kind: "live", paymentMethod: "cash" });
        expect(booked.status, JSON.stringify(booked.body)).toBe(201);
        await rider.command(booked.body["tripId"], "cancel", { reasonCode: "plans_changed" });
      }
    };
    await demand();
    expect(await check()).toEqual([]);
    expect(await quoteMultiplier()).toBe(1);

    await sim.publish(owner, "pricing", "Z001", (doc) => ({ ...doc, surge: { ...doc["surge"], smart: { ...doc["surge"]["smart"], enabled: true, checkEveryMin: 5, holdMin: 3 } } }));
    // 3 requests ÷ 1 free driver: Normal's step at ratio 3 is ×2 (cap ×2.5), but only once it held for 3 minutes.
    expect(await check()).toEqual([]);
    await sim.advance(4 * 60);
    await demand();
    await sim.advance(60);
    expect(await check()).toEqual([{ zoneId: "Z001", multiplier: 2 }]);
    expect(await quoteMultiplier()).toBe(2);

    await sim.publish(owner, "pricing", "Z001", (doc) => ({ ...doc, surge: { ...doc["surge"], smart: { ...doc["surge"]["smart"], enabled: false } } }));
    await check();
    expect(await quoteMultiplier()).toBe(1);
  });
});

describe("pricing history, Restore and the audit", () => {
  it("lists every publish, restores an earlier version (Undo last publish), and writes one audit line per publish", async () => {
    await sim.publish(owner, "pricing", "Z001", (doc) => ({ ...doc, categories: { ...doc["categories"], economy: { ...doc["categories"]["economy"], base: sek(3100) } } }));
    const history = await owner.get("/admin/config/pricing/history?zoneId=Z001&limit=2");
    expect(history.status, JSON.stringify(history.body)).toBe(200);
    const [latest, previous] = history.body["items"] as Json[];
    expect(latest!.document.categories.economy.base).toEqual(sek(3100));
    expect(latest!.action).toBe("publish");
    expect(previous!.version).toBe(latest!.version - 1);

    const audit = await owner.get("/admin/audit?action=config.publish&targetId=pricing");
    const row = (audit.body["items"] as Json[])[0]!;
    expect(row.after ?? row.detail ?? row).toBeTruthy();
    expect(JSON.stringify(row)).toContain("appDocuments");

    const sameAgain = await owner.post("/admin/config/pricing/restore", { zoneId: "Z001", version: latest!.version, expectedVersion: latest!.version });
    expect(sameAgain.body.reason).toBe("already_live");
    const undone = await owner.post("/admin/config/pricing/restore", { zoneId: "Z001", version: previous!.version, expectedVersion: latest!.version });
    expect(undone.status, JSON.stringify(undone.body)).toBe(200);
    expect(undone.body).toMatchObject({ version: latest!.version + 1, restoredFrom: previous!.version });
    const after = (await owner.get("/admin/config/pricing/history?zoneId=Z001&limit=1")).body["items"][0];
    expect(after).toMatchObject({ action: "restore", restoredFrom: previous!.version });
    expect(after.document.categories.economy.base).toEqual(previous!.document.categories.economy.base);
    expect((await owner.post("/admin/config/pricing/restore", { zoneId: "Z001", version: 9999, expectedVersion: after.version })).status).toBe(404);
  });
});

describe("car type catalog (contract.json#categoryCatalog)", () => {
  it("serves the sub-lines, refuses to delete a car type with booked trips, archives for 30 days and restores it switched off", async () => {
    const list = await owner.get("/admin/categories");
    expect(list.status).toBe(200);
    expect(list.body.restoreDays).toBe(30);
    expect(list.body.categories.find((c: Json) => c.id === "xl")).toMatchObject({ label: "Movera XL", seats: 6, line: { sv: "Upp till 6 platser", fr: "Jusqu’à 6 places", en: "Up to 6 seats" } });
    const edited = await owner.put("/admin/categories/xl", { label: "Movera XL", line: { sv: "Upp till 6 personer", fr: "Jusqu’à 6 personnes", en: "Up to 6 people" }, seats: 6 });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    const riderConfig = (await riders[0]!.get("/rider/config?zoneId=Z001")).body;
    expect(riderConfig.catalog.categories.find((c: Json) => c.id === "xl").line).toEqual({ sv: "Upp till 6 personer", fr: "Jusqu’à 6 personnes", en: "Up to 6 people" });

    const tripId = await bookAccepted(riders[2]!);
    const refused = await owner.post("/admin/categories/economy/archive", { reason: "test" });
    expect(refused.status).toBe(409);
    expect(refused.body.reason).toBe("category_in_use");
    await riders[2]!.command(tripId, "cancel", { reasonCode: "plans_changed" });

    const archived = await owner.post("/admin/categories/pet/archive", { reason: "Not sold this winter" });
    expect(archived.status, JSON.stringify(archived.body)).toBe(200);
    expect(archived.body).toMatchObject({ id: "pet", archiveReason: "Not sold this winter" });
    expect(Date.parse(archived.body.restoreUntil) - Date.parse(archived.body.archivedAt)).toBe(30 * 86_400_000);
    expect((await riders[0]!.get("/rider/config?zoneId=Z001")).body.catalog.categories.some((c: Json) => c.id === "pet")).toBe(false);
    expect((await riders[0]!.quote({ categoryIds: ["pet"] })).body.reason).toBe("category_not_offered");
    const pricing = (await owner.get("/admin/config/pricing?zoneId=Z001")).body.document;
    expect(pricing.categories.pet.enabled).toBe(false);

    const restored = await owner.post("/admin/categories/pet/restore", {});
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    expect(restored.body).not.toHaveProperty("archivedAt");
    const back = (await owner.get("/admin/config/pricing?zoneId=Z001")).body.document.categories.pet;
    expect(back).toMatchObject({ enabled: false, base: pricing.categories.pet.base });
    expect((await owner.post("/admin/categories/pet/restore", {})).body.reason).toBe("category_not_archived");

    const made = await owner.post("/admin/categories", { label: "Movera Van", line: { sv: "Plats för bagage", fr: "De la place pour les bagages", en: "Room for luggage" }, seats: 7 });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body).toMatchObject({ id: "movera_van", builtIn: false, seats: 7 });
    expect((await owner.post("/admin/categories", { label: "movera van", line: { sv: "x", fr: "x", en: "x" }, seats: 7 })).body.reason).toBe("category_exists");
  });
});
