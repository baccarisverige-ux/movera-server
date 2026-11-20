import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bookAndAccept, drive, PLACES, Sim, type Admin, type Driver, type Json, type Rider } from "./harness.js";

/**
 * Driver profile v3 (contract v0.18.147, contract.json#driverProfile; owner 2026-11-20 "Now build all"): the rider's
 * profile read, compliment counts kept on the server, short reviews shown only after an admin approves them (first name
 * or anonymous, never other rider data), the driver's Min profil and the per-zone switches. Privacy first.
 */
let sim: Sim;
let rider: Rider;
let other: Rider;
let a: Driver;
let owner: Admin;

beforeAll(async () => {
  sim = await Sim.start();
  rider = await sim.rider(0);
  other = await sim.rider(1);
  a = await sim.driver(1, PLACES.nearSergels);
  owner = await sim.owner();
});
afterAll(async () => {
  await sim.stop();
});

const setZone = (profile: Json) => sim.publish(owner, "rider_app_config", "Z001", (doc) => ({ ...doc, driverProfile: profile }));

async function doneTrip(who: Rider = rider): Promise<string> {
  const { tripId } = await bookAndAccept(sim, who, a);
  await drive(a, tripId, "in_trip");
  await sim.advance(60);
  await a.moveTo(PLACES.medborgar);
  const done = await a.command(tripId, "complete");
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  await sim.advance(5);
  await a.moveTo(PLACES.nearSergels);
  return tripId;
}
const rate = (who: Rider, tripId: string, body: Json) => who.post(`/trips/${tripId}/rating`, body);
const profileOf = (who: Rider, tripId: string, headers?: Record<string, string>) =>
  headers ? sim.request("GET", `/rider/trips/${tripId}/driver-profile`, who.token, undefined, { key: null, headers }) : who.get(`/rider/trips/${tripId}/driver-profile`);

describe("driver profile (v0.18.147)", () => {
  let first: string;

  it("a rating adds compliment counts on the server; the profile has no rider data", async () => {
    await setZone({ on: true, reviews: true });
    first = await doneTrip();
    const rated = await rate(rider, first, { stars: 5, tags: ["great_service", "clean_car"], review: "Punktlig och trygg.", reviewName: "first_name" });
    expect(rated.status, JSON.stringify(rated.body)).toBe(201);
    const p = await profileOf(rider, first);
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body["compliments"]).toEqual([{ code: "great_service", count: 1 }, { code: "clean_car", count: 1 }]);
    expect(p.body["verified"]).toBeTypeOf("boolean");
    expect(p.body["latestReview"]).toBeNull(); // pending until an admin approves
    const keys = Object.keys(p.body).sort();
    expect(keys).toEqual(["city", "compliments", "driverId", "firstName", "languages", "latestReview", "milestones", "photoUrl", "rating", "sinceMonth", "tripCount", "verified", "years"]);
    expect(p.headers.get("cache-control")).toBe("private, max-age=300");
    expect(p.headers.get("etag")).toBeTruthy();
    const again = await profileOf(rider, first, { "if-none-match": String(p.headers.get("etag")) });
    expect(again.status).toBe(304);
  });

  it("a review shows only after approval, with the first name and month only", async () => {
    const list = await owner.get("/admin/driver-reviews?status=pending");
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const item = (list.body["items"] as Json[]).find((r) => r["text"] === "Punktlig och trygg.")!;
    expect(item).toBeTruthy();
    expect(item).not.toHaveProperty("riderId");
    const ok = await owner.post(`/admin/driver-reviews/${item["reviewId"]}/approve`, {});
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const shown = (await profileOf(rider, first)).body["latestReview"] as Json;
    expect(Object.keys(shown).sort()).toEqual(["month", "name", "text"]);
    expect(shown["text"]).toBe("Punktlig och trygg.");
    const me = (await rider.get("/rider/profile")).body;
    expect(shown["name"]).toBe(String(me["firstName"]).split(/\s+/)[0]);
    expect(shown["month"]).toMatch(/^\d{4}-\d{2}$/);
    const hidden = await owner.post(`/admin/driver-reviews/${item["reviewId"]}/hide`, {});
    expect(hidden.status).toBe(200);
    expect((await profileOf(rider, first)).body["latestReview"]).toBeNull();
    await owner.post(`/admin/driver-reviews/${item["reviewId"]}/approve`, {});
  });

  it("anonymous has no name; a low rating stores no review and counts no compliment", async () => {
    const t2 = await doneTrip(other);
    expect((await rate(other, t2, { stars: 5, tags: ["good_music"], review: "Bra musik!", reviewName: "anonymous" })).status).toBe(201);
    const t3 = await doneTrip(other);
    expect((await rate(other, t3, { stars: 2, tags: ["clean_car"], review: "Sen." })).status).toBe(201);
    const pending = (await owner.get("/admin/driver-reviews?status=pending")).body["items"] as Json[];
    expect(pending.find((r) => r["text"] === "Bra musik!")!["name"]).toBeNull();
    expect(pending.find((r) => r["text"] === "Sen.")).toBeUndefined();
    const p = (await profileOf(other, t3)).body;
    expect(p["compliments"]).toEqual([{ code: "great_service", count: 1 }, { code: "clean_car", count: 1 }, { code: "good_music", count: 1 }]);
  });

  it("only the trip's rider reads it; the zone switch off answers driver_profile_off", async () => {
    expect((await profileOf(other, first)).status).toBe(404);
    await setZone({ on: false, reviews: true });
    const off = await profileOf(rider, first);
    expect(off.status).toBe(404);
    expect(off.body["reason"]).toBe("driver_profile_off");
    await setZone({ on: true, reviews: true });
  });

  it("Min profil: the driver picks languages and hides the city and years", async () => {
    const bad = await a.send("PATCH", "/driver/public-profile", { languages: ["xx"] });
    expect(bad.status).toBe(400);
    expect(bad.body["reason"]).toBe("invalid_language");
    const saved = await a.send("PATCH", "/driver/public-profile", { languages: ["sv", "ar", "en"], showCity: false, showYears: false });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body["languages"]).toEqual(["sv", "ar", "en"]);
    const preview = saved.body["preview"] as Json;
    expect(preview["city"]).toBeNull();
    expect(preview["sinceMonth"]).toBeNull();
    expect(preview["years"]).toBeNull();
    const own = (await a.get("/driver/public-profile")).body;
    expect((own["reviews"] as Json[]).map((r) => r["status"]).sort()).toEqual(["approved", "pending"]);
    expect((await profileOf(rider, first)).body["languages"]).toEqual(["sv", "ar", "en"]);
  });
});
