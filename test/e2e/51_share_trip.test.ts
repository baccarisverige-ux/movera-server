import { createHash, createHmac, randomBytes } from "node:crypto";
import { Writable } from "node:stream";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { CLEANUP_TRIP_SHARES, HOUSEKEEPING_KINDS, housekeepingHandlers } from "../../src/jobs/housekeeping.js";
import { TimerWorker } from "../../src/jobs/timers.js";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { HIDE_NEAR_DROPOFF_METERS, HIDE_NEAR_STOP_METERS, shareKey, shareToken } from "../../src/safety/tripShare.js";
import { bookAndAccept, drive, newKey, PLACES, Sim, type Admin, type Driver, type Json, type Rider } from "./harness.js";

/**
 * BQ-S10 "Share my trip" (contract v0.18.116 §94, contract.json#shareTrip; owner decisions/driver-g14.md:11 and the S10
 * answers Q1-Q7 of 2026-11-15): the rider's live trip link. A safety and privacy feature, so the first thing proven
 * here is what the public answer may NOT carry.
 */

let sim: Sim;
let rider: Rider;
let other: Rider;
let a: Driver;
let owner: Admin;
let root: string;

beforeAll(async () => {
  sim = await Sim.start();
  rider = await sim.rider(0);
  other = await sim.rider(1);
  a = await sim.driver(1, PLACES.nearSergels);
  owner = await sim.owner();
  root = sim.base.replace(/\/api\/v1$/, "");
});
afterAll(async () => {
  await sim.stop();
});
afterEach(async () => {
  // Every test leaves no live trip behind and the car back near the pickup.
  const active = await rider.get("/rider/trips/active");
  const tripId = active.status === 200 ? (active.body["tripId"] as string | undefined) : undefined;
  if (tripId) {
    const trip = await a.trip(tripId).catch(() => undefined);
    if (trip && ["rider_onboard", "in_trip", "approaching_dropoff"].includes(trip["status"])) await finish(tripId);
    else await rider.command(tripId, "cancel", { reasonCode: "plans_changed" });
  }
  await sim.advance(5);
  await a.moveTo(PLACES.nearSergels);
});

let addresses = 0;
/** A read as "anyone with the link": no token, no headers; each read from its own address unless one is given. */
const read = (path: string, options: { ip?: string; headers?: Record<string, string> } = {}) =>
  sim.app.inject({ method: "GET", url: path, remoteAddress: options.ip ?? `10.${(++addresses >> 16) & 255}.${(addresses >> 8) & 255}.${addresses & 255}`, headers: options.headers ?? {} });
const json = (token: string, options?: Parameters<typeof read>[1]) => read(`/api/v1/share/${token}`, options);
const page = (token: string, options?: Parameters<typeof read>[1]) => read(`/s/${token}`, options);
const share = (who: Rider, tripId: string, key?: string) => who.post(`/rider/trips/${tripId}/share`, {}, key);
const stop = (who: Rider, tripId: string) => who.send("DELETE", `/rider/trips/${tripId}/share`);
const tokenOf = (url: string) => /\/s\/([A-Za-z0-9_-]{22})$/.exec(url)![1]!;
const ENDED = { state: "ended", reason: "share_ended" };

async function sharedTrip(): Promise<{ tripId: string; token: string; link: Json }> {
  const { tripId } = await bookAndAccept(sim, rider, a);
  const made = await share(rider, tripId);
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  return { tripId, token: tokenOf(made.body["url"]), link: made.body };
}
async function finish(tripId: string): Promise<void> {
  // approaching_dropoff is past every step drive() knows.
  if ((await a.trip(tripId))["status"] !== "approaching_dropoff") await drive(a, tripId, "in_trip");
  await sim.advance(60);
  await a.moveTo(PLACES.medborgar);
  const done = await a.command(tripId, "complete");
  expect(done.status, JSON.stringify(done.body)).toBe(200);
}

/** Everything the public answer must never carry, read from the trip itself and the two accounts. */
async function forbiddenOf(tripId: string, link: Json): Promise<string[]> {
  const trip = await owner.get(`/admin/trips/${tripId}`);
  const mine = await rider.trip(tripId);
  const riderProfile = (await rider.get("/rider/profile")).body;
  const driverProfile = (await a.get("/driver/profile")).body;
  const words = [
    tripId, rider.id, a.id, link["shareId"], mine["zoneId"],
    rider.login, a.login, rider.login.replace("+", ""), a.login.replace("+", ""),
    mine["driver"]?.["firstName"], riderProfile["firstName"], riderProfile["lastName"], riderProfile["name"], driverProfile["firstName"], driverProfile["lastName"], driverProfile["name"],
    PLACES.sergels.address, PLACES.medborgar.address, String(PLACES.medborgar.lat), String(PLACES.medborgar.lng),
    String(mine["fare"]["amountMinor"]), mine["fare"]["currency"], mine["paymentMethod"], mine["pickupPin"],
    trip.body["rider"]?.["firstName"], trip.body["rider"]?.["phone"], trip.body["driver"]?.["phone"],
  ];
  return [...new Set(words.filter((w): w is string => typeof w === "string" && w.length >= 3))];
}

describe("S10 privacy: the public answer is a fixed allow-list", () => {
  it("JSON: exactly the allow-listed fields, and no phone number, name, address, destination, fare, rating or id", async () => {
    const { tripId, token, link } = await sharedTrip();
    await drive(a, tripId, "in_trip");
    await a.moveTo(PLACES.odenplan);
    const res = await json(token);
    expect(res.statusCode).toBe(200);
    const body = res.json() as Json;
    // The exact key set, on every level: a new field must be added to the contract's allow-list on purpose.
    expect(Object.keys(body).sort()).toEqual(["car", "eta", "phase", "position", "refreshSeconds", "state", "updatedAt"]);
    expect(Object.keys(body["car"]).sort()).toEqual(["color", "make", "model", "plate"]);
    expect(Object.keys(body["position"]).sort()).toEqual(["at", "lat", "lng"]);
    if (body["eta"] !== null) expect(Object.keys(body["eta"]).sort()).toEqual(["arriveAround", "minutes", "target"]);
    const mine = await rider.trip(tripId);
    expect(body).toMatchObject({ state: "live", phase: "on_trip", refreshSeconds: 20, car: { plate: mine["driver"]["vehicle"]["plate"], make: mine["driver"]["vehicle"]["make"] }, position: { lat: PLACES.odenplan.lat, lng: PLACES.odenplan.lng } });
    const text = res.body;
    for (const word of await forbiddenOf(tripId, link)) expect(text, `the public JSON carries ${word}`).not.toContain(word);
    for (const key of ["phone", "name", "firstName", "address", "pickup", "dropoff", "destination", "stops", "fare", "price", "payment", "rating", "photo", "riderId", "driverId", "tripId", "zoneId", "shareId"]) {
      expect(text, `the public JSON has a "${key}" field`).not.toContain(`"${key}"`);
    }
    expect(text).not.toMatch(/\+\d{6,}/);
    // The headers (contract.json#shareTrip.public.headers).
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("HTML: the same allow-list; no script, reload every 20 s, noindex / no-store, no preview tags with trip data, a Maps link for the car", async () => {
    const { tripId, token, link } = await sharedTrip();
    await drive(a, tripId, "in_trip");
    await a.moveTo(PLACES.odenplan);
    const res = await page(token, { headers: { "accept-language": "en-GB,en;q=0.9" } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/html; charset=utf-8/);
    const html = res.body;
    const mine = await rider.trip(tripId);
    expect(html).toContain(mine["driver"]["vehicle"]["plate"]);
    expect(html).toContain("On the trip");
    expect(html).toContain(`href="https://maps.google.com/?q=${PLACES.odenplan.lat},${PLACES.odenplan.lng}"`);
    expect(html).toContain('<meta http-equiv="refresh" content="20">');
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
    for (const word of await forbiddenOf(tripId, link)) expect(html, `the page carries ${word}`).not.toContain(word);
    expect(html).not.toMatch(/\+\d{6,}/);
    expect(html.toLowerCase()).not.toMatch(/<script|javascript:|onload=|onclick=|<iframe|<img|<form/);
    // Link previews: no Open Graph / Twitter tags at all, and the title is the fixed text only.
    expect(html).not.toMatch(/og:|twitter:|<meta name="description"/);
    expect(/<title>([^<]*)<\/title>/.exec(html)![1]).toBe("Movera · Shared trip");
    expect(html).not.toContain(token);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  });

  it("HTML: every value is escaped (the plate and the car model are typed by drivers), and the language follows Accept-Language, else the zone's country", async () => {
    const { tripId, token } = await sharedTrip();
    const summary = (await sim.db.selectFrom("trips").select("driver_summary").where("trip_id", "=", tripId).executeTakeFirstOrThrow()).driver_summary as Json;
    await sim.db.updateTable("trips").set({ driver_summary: JSON.stringify({ ...summary, vehicle: { ...summary["vehicle"], plate: '<script>alert(1)</script>', model: '"><b>x' } }) }).where("trip_id", "=", tripId).execute();
    const html = (await page(token)).body;
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain('"><b>x');
    // Z001 is in Sweden: no Accept-Language = Swedish.
    expect(html).toContain("På väg för att hämta");
    expect(html).toContain('<html lang="sv">');
    expect((await page(token, { headers: { "accept-language": "fr-FR,fr;q=0.9,en;q=0.5" } })).body).toContain("En route vers la prise en charge");
    expect((await page(token, { headers: { "accept-language": "de,en;q=0.5" } })).body).toContain("On the way to pick up");
    expect((await page(token, { headers: { "accept-language": "de" } })).body).toContain("På väg för att hämta");
  });

  it("phase and arrival time follow the trip: to the pickup, waiting at the pickup, on the trip; never where it goes", async () => {
    const { tripId, token } = await sharedTrip();
    await sim.advance(35);
    let body = (await json(token)).json() as Json;
    expect(body["phase"]).toBe("to_pickup");
    expect(body["eta"]).toMatchObject({ target: "pickup", minutes: expect.any(Number), arriveAround: expect.stringMatching(/^[0-2]\d:[0-5]\d$/) });
    expect(body["eta"]["minutes"]).toBeGreaterThanOrEqual(1);
    await drive(a, tripId, "arrived");
    body = (await json(token)).json() as Json;
    expect(body).toMatchObject({ phase: "at_pickup", eta: null });
    await drive(a, tripId, "in_trip");
    await sim.advance(35);
    body = (await json(token)).json() as Json;
    expect(body["phase"]).toBe("on_trip");
    expect(body["eta"]).toMatchObject({ target: "dropoff" });
    const html = (await page(token, { headers: { "accept-language": "en" } })).body;
    expect(html).toContain("On the trip");
    expect(html).toMatch(/Arriving in about \d+ min/);
    expect(html).not.toContain(PLACES.medborgar.address);
  });
});

describe("S10 round 2 (supervisor MF-1, SF-3, SF-4)", () => {
  it("MF-1: a trip queued behind the driver's current trip never shows the car's spot (it is another rider's trip) and does not say 'on the way to pick up'", async () => {
    const { tripId, token } = await sharedTrip();
    await a.moveTo(PLACES.odenplan);
    // Queued: accepted with next_after_trip_id set (the driver still carries another rider).
    await sim.db.updateTable("trips").set({ next_after_trip_id: tripId }).where("trip_id", "=", tripId).execute();
    const res = await json(token);
    expect(res.statusCode).toBe(200);
    const body = res.json() as Json;
    expect(Object.keys(body).sort()).toEqual(["car", "eta", "phase", "position", "refreshSeconds", "state", "updatedAt"]);
    expect(body).toMatchObject({ state: "live", phase: "queued", position: null, eta: null });
    expect(res.body).not.toContain(String(PLACES.odenplan.lat));
    expect(res.body).not.toContain(String(PLACES.odenplan.lng));
    for (const lang of ["en", "sv", "fr"]) {
      const html = (await page(token, { headers: { "accept-language": lang } })).body;
      expect(html).not.toContain("maps.google.com");
      expect(html).not.toContain(String(PLACES.odenplan.lat));
      expect(html).not.toMatch(/On the way to pick up|På väg för att hämta|En route vers la prise en charge/);
    }
    expect((await page(token, { headers: { "accept-language": "en" } })).body).toContain("The driver is finishing another trip first");
    // The first trip ended (the server clears next_after_trip_id): on the way to this pickup; still no spot (owner Q-A).
    await sim.db.updateTable("trips").set({ next_after_trip_id: null }).where("trip_id", "=", tripId).execute();
    expect((await json(token)).json()).toMatchObject({ phase: "to_pickup", position: null });
  });

  it("SF-3: the link key is derived from the server's secret with its own label, never the secret itself", () => {
    const secret = "s".repeat(48);
    const key = shareKey(secret);
    expect(key).toHaveLength(32);
    expect(key.equals(Buffer.from(secret))).toBe(false);
    const token = shareToken(key, "shr_TEST");
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(shareToken(shareKey(secret), "shr_TEST")).toBe(token);
    expect(shareToken(key, "shr_OTHER")).not.toBe(token);
    // Not what the secret itself would sign.
    expect(token).not.toBe(createHmac("sha256", secret).update("movera-trip-share-v1:shr_TEST").digest().subarray(0, 16).toString("base64url"));
  });

  it("SF-4: a token longer than a path value may be still answers no-store + noindex on both share paths", async () => {
    const long = "A".repeat(300);
    for (const path of [`/s/${long}`, `/api/v1/share/${long}`, `/s/${long}/x`]) {
      const res = await read(path);
      expect(res.statusCode, path.slice(0, 20)).toBe(404);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.headers["x-robots-tag"]).toBe("noindex, nofollow");
      expect(res.headers["referrer-policy"]).toBe("no-referrer");
      expect(res.body).not.toContain(long);
    }
  });
});

describe("S10 round 3: owner answers Q-A and Q-B (decisions/driver-g14.md, 19:32 UTC 2026-11-15)", () => {
  const KEYS = ["car", "eta", "phase", "position", "refreshSeconds", "state", "updatedAt"];
  const hidden = async (token: string, at: { lat: number; lng: number }, phaseText: string) => {
    const res = await json(token);
    expect(res.statusCode).toBe(200);
    const body = res.json() as Json;
    expect(Object.keys(body).sort()).toEqual(KEYS);
    expect(body["position"]).toBeNull();
    expect(res.body).not.toContain(String(at.lat));
    expect(res.body).not.toContain(String(at.lng));
    expect(res.body).not.toMatch(/"dropoff":|"pickup":|distance|met(er|re)s/i);
    const html = (await page(token, { headers: { "accept-language": "en" } })).body;
    expect(html).toContain(phaseText);
    expect(html).not.toContain("maps.google.com");
    expect(html).not.toContain("Maps");
    expect(html).not.toContain(String(at.lat));
    expect(html).not.toContain(String(at.lng));
    expect(html).not.toContain("not available");
    return { body, html };
  };

  it("Q-A 'Hide until rider is in': on the way and waiting at the pickup show no car position and no Maps link, only the phase; the position shows once the rider is in the car", async () => {
    const { tripId, token } = await sharedTrip();
    await a.moveTo(PLACES.odenplan);
    expect((await hidden(token, PLACES.odenplan, "On the way to pick up")).body["phase"]).toBe("to_pickup");
    await drive(a, tripId, "driver_to_pickup");
    await a.moveTo(PLACES.nearSergels);
    await hidden(token, PLACES.nearSergels, "On the way to pick up");
    await drive(a, tripId, "arrived");
    expect((await hidden(token, PLACES.sergels, "The car is waiting at the pickup")).body["phase"]).toBe("at_pickup");
    // The rider is in the car: the car's spot is shown.
    await drive(a, tripId, "rider_onboard");
    await a.moveTo(PLACES.odenplan);
    const res = await json(token);
    expect(res.json()).toMatchObject({ phase: "on_trip", position: { lat: PLACES.odenplan.lat, lng: PLACES.odenplan.lng } });
    expect((await page(token)).body).toContain(`href="https://maps.google.com/?q=${PLACES.odenplan.lat},${PLACES.odenplan.lng}"`);
  });

  it("Q-B 'Hide last 500 m': within about 500 m of the drop-off the position and the Maps link are hidden, only 'Arriving in about N min'; the drop-off and the distance are never sent", async () => {
    expect(HIDE_NEAR_DROPOFF_METERS).toBe(500);
    const { tripId, token } = await sharedTrip();
    await drive(a, tripId, "in_trip");
    // About 720 m north of the drop-off: shown.
    const far = { lat: 59.3208, lng: 18.0735 };
    await a.moveTo(far);
    await sim.advance(35);
    expect((await json(token)).json()).toMatchObject({ phase: "on_trip", position: { lat: far.lat, lng: far.lng } });
    // About 400 m from it: hidden.
    const near = { lat: 59.3179, lng: 18.0735 };
    await a.moveTo(near);
    await sim.advance(35);
    const { body, html } = await hidden(token, near, "On the trip");
    expect(body["phase"]).toBe("on_trip");
    expect(body["eta"]).toMatchObject({ target: "dropoff", minutes: expect.any(Number) });
    expect(html).toMatch(/Arriving in about \d+ min/);
    expect(html).not.toContain(PLACES.medborgar.address);
    expect(html).not.toContain(String(PLACES.medborgar.lat));
    // At the door: hidden too.
    await a.moveTo(PLACES.medborgar);
    expect(((await json(token)).json() as Json)["position"]).toBeNull();
    expect((await page(token)).body).not.toContain("maps.google.com");
    // Back outside the 500 m: shown again (the rule is the distance, nothing is remembered).
    await a.moveTo(far);
    expect(((await json(token)).json() as Json)["position"]).toEqual({ lat: far.lat, lng: far.lng, at: expect.any(String) });
  });
});

describe("S10 round 3b: the same 500 m hide around every middle stop (session decision under the owner's overnight rule; follows 'never the destination')", () => {
  it("within 500 m of any middle stop the position and the Maps link are hidden; a stop without coordinates hides it; stops and distances are never sent", async () => {
    expect(HIDE_NEAR_STOP_METERS).toBe(500);
    const { tripId, token } = await sharedTrip();
    await drive(a, tripId, "in_trip");
    const setStops = (stops: unknown[]) => sim.db.updateTable("trips").set({ stops: JSON.stringify(stops) }).where("trip_id", "=", tripId).execute();
    const car = PLACES.odenplan; // about 3 km from the drop-off
    await a.moveTo(car);
    const shown = async () => {
      expect((await json(token)).json()).toMatchObject({ phase: "on_trip", position: { lat: car.lat, lng: car.lng } });
      expect((await page(token)).body).toContain("maps.google.com");
    };
    const hiddenNow = async () => {
      const res = await json(token);
      const body = res.json() as Json;
      expect(Object.keys(body).sort()).toEqual(["car", "eta", "phase", "position", "refreshSeconds", "state", "updatedAt"]);
      expect(body).toMatchObject({ phase: "on_trip", position: null });
      const html = (await page(token, { headers: { "accept-language": "en" } })).body;
      for (const text of [res.body, html]) {
        expect(text).not.toContain(String(car.lat));
        expect(text).not.toContain(String(car.lng));
        expect(text).not.toContain("Stop street");
        expect(text).not.toContain("59.3465");
        expect(text).not.toMatch(/"stops?":|distance|met(er|re)s/i);
      }
      expect(html).not.toContain("maps.google.com");
      expect(html).toContain("On the trip");
    };
    await shown();
    // A stop about 400 m north of the car: hidden. (A second stop far away does not help.)
    await setStops([{ address: "Far street 1", lat: 59.38, lng: 18.0498 }, { address: "Stop street 2", lat: 59.3465, lng: 18.0498 }]);
    await hiddenNow();
    // The stop about 720 m away: shown.
    await setStops([{ address: "Stop street 2", lat: 59.3494, lng: 18.0498 }]);
    await shown();
    // A stop the server has no coordinates for: hidden (closed by default).
    await setStops([{ address: "Stop street 2" }]);
    await hiddenNow();
    await setStops([]);
    await shown();
  });
});

describe("S10 the rider's routes", () => {
  it("a link is made only on the rider's own trip with a driver; the server keeps only the token's hash", async () => {
    const booked = await rider.book();
    // No driver yet: 409 trip_not_live.
    const early = await share(rider, booked.tripId);
    expect(early.status).toBe(409);
    expect(early.body).toMatchObject({ code: "invalid_transition", reason: "trip_not_live" });
    await sim.tick();
    const offer = await a.offerFor(booked.tripId);
    expect((await a.accept(offer!)).status).toBe(200);
    const tripId = booked.tripId;

    // Another rider: the trip does not exist for him, on any of the three routes.
    for (const res of [await share(other, tripId), await other.get(`/rider/trips/${tripId}/share`), await stop(other, tripId)]) {
      expect(res.status).toBe(404);
      expect(res.body["reason"]).toBe("trip_not_found");
    }
    // A driver token is the wrong app.
    expect((await a.post(`/rider/trips/${tripId}/share`, {})).status).toBe(403);

    const key = newKey("share");
    const made = await share(rider, tripId, key);
    expect(made.status).toBe(201);
    expect(Object.keys(made.body).sort()).toEqual(["createdAt", "endsAtDropoff", "expiresAt", "shareId", "tripId", "url"]);
    expect(made.body).toMatchObject({ tripId, endsAtDropoff: true, url: expect.stringMatching(new RegExp(`^${root}/s/[A-Za-z0-9_-]{22}$`)) });
    // The 6 h cap is on the link from the start.
    expect(Date.parse(made.body["expiresAt"]) - Date.parse(made.body["createdAt"])).toBe(6 * 3600 * 1000);
    // The app retries with the same key: the same link, not a second one.
    const again = await share(rider, tripId, key);
    expect(again.status).toBe(201);
    expect(again.body).toEqual(made.body);

    const list = await rider.get(`/rider/trips/${tripId}/share`);
    expect(list.status).toBe(200);
    expect(list.body.items).toEqual([{ shareId: made.body["shareId"], tripId, createdAt: made.body["createdAt"], expiresAt: made.body["expiresAt"], endsAtDropoff: true }]);

    // The database: one row, the SHA-256 of the token, and the token (or the URL) nowhere.
    const token = tokenOf(made.body["url"]);
    const rows = await sim.db.selectFrom("trip_shares").selectAll().where("trip_id", "=", tripId).execute();
    expect(rows).toHaveLength(1);
    expect(Buffer.from(rows[0]!.token_hash).toString("hex")).toBe(createHash("sha256").update(token).digest("hex"));
    for (const table of ["trip_shares", "idempotency_keys", "admin_audit", "trip_events", "telemetry", "notifications"]) {
      const hit = await sql<{ n: string }>`SELECT count(*)::text AS n FROM ${sql.table(table)} t WHERE t::text LIKE ${`%${token}%`}`.execute(sim.db);
      expect(hit.rows[0]!.n, `${table} holds the token`).toBe("0");
    }
    // The audit rows hold the trip and a count only.
    const audit = await sim.db.selectFrom("admin_audit").select(["action", "detail"]).where("target_id", "=", tripId).where("action", "like", "trip.share%").execute();
    expect(audit).toEqual([{ action: "trip.share_started", detail: { tripId, count: 1 } }]);
  });

  it("a held booked ride (scheduled, accepted: the rider is not shown the driver yet) is not live", async () => {
    const { tripId } = await bookAndAccept(sim, rider, a);
    await sim.db.updateTable("trips").set({ kind: "scheduled" }).where("trip_id", "=", tripId).execute();
    const res = await share(rider, tripId);
    expect(res.status).toBe(409);
    expect(res.body["reason"]).toBe("trip_not_live");
    await sim.db.updateTable("trips").set({ kind: "live" }).where("trip_id", "=", tripId).execute();
  });

  it("at most 3 live links per trip: the 4th is 409 too_many_shares; stopping makes room again", async () => {
    const { tripId } = await bookAndAccept(sim, rider, a);
    const urls = new Set<string>();
    for (let n = 0; n < 3; n++) {
      const res = await share(rider, tripId);
      expect(res.status).toBe(201);
      urls.add(res.body["url"]);
    }
    expect(urls.size).toBe(3);
    const fourth = await share(rider, tripId);
    expect(fourth.status).toBe(409);
    expect(fourth.body).toMatchObject({ code: "invalid_transition", reason: "too_many_shares" });
    expect((await rider.get(`/rider/trips/${tripId}/share`)).body.items).toHaveLength(3);
    expect((await stop(rider, tripId)).status).toBe(204);
    expect((await share(rider, tripId)).status).toBe(201);
    expect((await rider.get(`/rider/trips/${tripId}/share`)).body.items).toHaveLength(1);
  });

  it("stop sharing: every link of the trip ends at once and stays ended", async () => {
    const { tripId, token } = await sharedTrip();
    const second = tokenOf((await share(rider, tripId)).body["url"]);
    expect((await json(token)).statusCode).toBe(200);
    expect((await json(second)).statusCode).toBe(200);
    const res = await stop(rider, tripId);
    expect(res.status).toBe(204);
    for (const t of [token, second]) {
      const after = await json(t);
      expect(after.statusCode).toBe(410);
      expect(after.json()).toEqual(ENDED);
      expect((await page(t)).statusCode).toBe(410);
    }
    expect((await rider.get(`/rider/trips/${tripId}/share`)).body.items).toEqual([]);
    // Stopping again is still 204; a new link works, the old ones do not come back.
    expect((await stop(rider, tripId)).status).toBe(204);
    expect((await share(rider, tripId)).status).toBe(201);
    expect((await json(token)).statusCode).toBe(410);
    const audit = await sim.db.selectFrom("admin_audit").select(["action", "detail"]).where("target_id", "=", tripId).where("action", "=", "trip.share_stopped").execute();
    expect(audit).toEqual([{ action: "trip.share_stopped", detail: { tripId, count: 2 } }]);
  });
});

describe("S10 the link ends", () => {
  const expectEnded = async (token: string, plate: string) => {
    const res = await json(token);
    expect(res.statusCode).toBe(410);
    expect(res.json()).toEqual(ENDED);
    expect(res.headers["cache-control"]).toBe("no-store");
    const html = await page(token, { headers: { "accept-language": "en" } });
    expect(html.statusCode).toBe(410);
    expect(html.body).toContain("This trip has ended. The link no longer works.");
    expect(html.body).not.toContain(plate);
    expect(html.body).not.toContain("maps.google.com");
    expect(html.body).not.toContain('http-equiv="refresh"');
  };
  const plateOf = async (tripId: string) => (await rider.trip(tripId))["driver"]["vehicle"]["plate"] as string;

  it("at drop-off (completed)", async () => {
    const { tripId, token } = await sharedTrip();
    const plate = await plateOf(tripId);
    await drive(a, tripId, "in_trip");
    expect((await json(token)).statusCode).toBe(200);
    await finish(tripId);
    expect((await rider.trip(tripId))["status"]).toBe("completed");
    await expectEnded(token, plate);
    // The rider's list is empty and no new link can be made.
    expect((await rider.get(`/rider/trips/${tripId}/share`)).body.items).toEqual([]);
    expect((await share(rider, tripId)).body["reason"]).toBe("trip_not_live");
  });

  it("when the rider cancels", async () => {
    const { tripId, token } = await sharedTrip();
    const plate = await plateOf(tripId);
    expect((await rider.command(tripId, "cancel", { reasonCode: "plans_changed" })).status).toBe(200);
    expect((await rider.trip(tripId))["status"]).toBe("cancelled_by_rider");
    await expectEnded(token, plate);
  });

  it("at a no-show", async () => {
    const { tripId, token } = await sharedTrip();
    const plate = await plateOf(tripId);
    await drive(a, tripId, "arrived");
    await sim.advance(5 * 60 + 5);
    const res = await a.command(tripId, "no-show", { reasonCode: "rider_no_show" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body["status"]).toBe("no_show");
    await expectEnded(token, plate);
  });

  it("at every other end state (cancelled by the driver, the admin or the system, expired, failed), read from the trip's status", async () => {
    const { tripId, token } = await sharedTrip();
    const plate = await plateOf(tripId);
    const real = (await sim.db.selectFrom("trips").select("status").where("trip_id", "=", tripId).executeTakeFirstOrThrow()).status;
    for (const status of ["cancelled_by_driver", "cancelled_by_admin", "cancelled_by_system", "expired", "failed", "completed", "no_show", "cancelled_by_rider"]) {
      await sim.db.updateTable("trips").set({ status }).where("trip_id", "=", tripId).execute();
      await expectEnded(token, plate);
    }
    await sim.db.updateTable("trips").set({ status: real }).where("trip_id", "=", tripId).execute();
    expect((await json(token)).statusCode).toBe(200);
  });

  it("SF-1: while the trip has no driver again (driver cancelled, new search) the link says 'looking for a new car', keeps reloading and shows no car; it is not ended", async () => {
    const { tripId, token } = await sharedTrip();
    const plate = await plateOf(tripId);
    const before = await sim.db.selectFrom("trips").select(["status", "driver_id"]).where("trip_id", "=", tripId).executeTakeFirstOrThrow();
    await sim.db.updateTable("trips").set({ status: "searching", driver_id: null }).where("trip_id", "=", tripId).execute();
    const res = await json(token);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ state: "searching", updatedAt: sim.clock.now.toISOString(), refreshSeconds: 20 });
    expect(res.headers["cache-control"]).toBe("no-store");
    const html = await page(token, { headers: { "accept-language": "en" } });
    expect(html.statusCode).toBe(200);
    expect(html.body).toContain("Looking for a new car");
    expect(html.body).toContain('<meta http-equiv="refresh" content="20">');
    expect(html.body).not.toContain(plate);
    expect(html.body).not.toContain("maps.google.com");
    expect(html.body).not.toContain("This trip has ended");
    await sim.db.updateTable("trips").set(before).where("trip_id", "=", tripId).execute();
    expect((await json(token)).json()).toMatchObject({ state: "live", car: { plate } });
  });

  it("at the 6 h cap, even if the trip is still live", async () => {
    const { tripId, token } = await sharedTrip();
    const plate = await plateOf(tripId);
    const now = sim.clock.now.getTime();
    // One second before the cap: live. At the cap: ended.
    await sim.db.updateTable("trip_shares").set({ created_at: new Date(now - 6 * 3600_000 + 1000), expires_at: new Date(now + 1000) }).where("trip_id", "=", tripId).execute();
    expect((await json(token)).statusCode).toBe(200);
    expect((await rider.get(`/rider/trips/${tripId}/share`)).body.items).toHaveLength(1);
    await sim.db.updateTable("trip_shares").set({ created_at: new Date(now - 6 * 3600_000), expires_at: new Date(now) }).where("trip_id", "=", tripId).execute();
    await expectEnded(token, plate);
    expect((await rider.get(`/rider/trips/${tripId}/share`)).body.items).toEqual([]);
    // An expired link no longer counts against the 3.
    expect((await share(rider, tripId)).status).toBe(201);
  });

  it("an unknown or malformed token is the same 404 for every miss", async () => {
    const unknown = randomBytes(16).toString("base64url");
    const bodies = new Set<string>();
    for (const token of [unknown, "short", "x".repeat(23), "has.dot.in.it.0123456789", "%3Cscript%3E"]) {
      const res = await json(token);
      expect(res.statusCode, token).toBe(404);
      const body = res.json() as Json;
      expect(body).toMatchObject({ code: "not_found", reason: "share_not_found" });
      bodies.add(JSON.stringify({ ...body, requestId: "" }));
      const html = await page(token, { headers: { "accept-language": "en" } });
      expect(html.statusCode, token).toBe(404);
      expect(html.body).toContain("Link not found");
      expect(html.headers["x-robots-tag"]).toBe("noindex, nofollow");
    }
    expect(bodies.size).toBe(1);
  });
});

describe("S10 the zone's switch (RiderAppConfig.shareTrip.on, default on)", () => {
  const setSwitch = (change: (doc: Json) => Json) => sim.publish(owner, "rider_app_config", "Z001", change);

  it("GET /rider/config serves shareTrip { on } and the same value as features.shareTrip; default on", async () => {
    await setSwitch((doc) => {
      const { shareTrip: _gone, ...rest } = doc;
      return { ...rest, features: { ...doc["features"], shareTrip: true } };
    });
    let config = (await rider.get("/rider/config?zoneId=Z001")).body;
    expect(config["shareTrip"]).toEqual({ on: true });
    expect(config["features"]["shareTrip"]).toBe(true);
    await setSwitch((doc) => ({ ...doc, shareTrip: { on: false } }));
    config = (await rider.get("/rider/config?zoneId=Z001")).body;
    expect(config["shareTrip"]).toEqual({ on: false });
    expect(config["features"]["shareTrip"]).toBe(false);
    // A document saved before v0.18.116 with the old book-wide switch off stays off.
    await setSwitch((doc) => {
      const { shareTrip: _gone, ...rest } = doc;
      return { ...rest, features: { ...doc["features"], shareTrip: false } };
    });
    config = (await rider.get("/rider/config?zoneId=Z001")).body;
    expect(config["shareTrip"]).toEqual({ on: false });
    expect(config["features"]["shareTrip"]).toBe(false);
    await setSwitch((doc) => ({ ...doc, shareTrip: { on: true } }));
    config = (await rider.get("/rider/config?zoneId=Z001")).body;
    expect(config["shareTrip"]).toEqual({ on: true });
    expect(config["features"]["shareTrip"]).toBe(true);
    // The driver document gets nothing.
    expect((await a.get("/driver/config?zoneId=Z001")).body["shareTrip"]).toBeUndefined();
  });

  it("a shareTrip that is not { on: true | false } is 400 invalid_document", async () => {
    const draft = await owner.get("/admin/config/rider_app_config?zoneId=Z001");
    for (const bad of [{ on: "yes" }, { on: 1 }, "on", { on: null }]) {
      const res = await owner.put("/admin/config/rider_app_config", { expectedVersion: draft.body["version"], zoneId: "Z001", document: { ...draft.body["document"], shareTrip: bad } });
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(res.body["reason"]).toBe("invalid_document");
    }
  });

  it("switched off: no new link (403 share_trip_off), live links end at once and stay ended when it is switched on again", async () => {
    const { tripId, token } = await sharedTrip();
    expect((await json(token)).statusCode).toBe(200);
    await setSwitch((doc) => ({ ...doc, shareTrip: { on: false } }));
    const refused = await share(rider, tripId);
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: "forbidden", reason: "share_trip_off" });
    const off = await json(token);
    expect(off.statusCode).toBe(410);
    expect(off.json()).toEqual(ENDED);
    expect((await page(token)).statusCode).toBe(410);
    expect((await rider.get(`/rider/trips/${tripId}/share`)).body.items).toEqual([]);
    await setSwitch((doc) => ({ ...doc, shareTrip: { on: true } }));
    expect((await json(token)).statusCode).toBe(410);
    const fresh = await share(rider, tripId);
    expect(fresh.status).toBe(201);
    expect((await json(tokenOf(fresh.body["url"]))).statusCode).toBe(200);
  });
});

describe("S10 the public read budget", () => {
  it("60 reads per address per minute over both routes, then 429 share_too_many with Retry-After; free again after the minute", async () => {
    const ip = "198.51.100.7";
    const { token } = await sharedTrip();
    for (let n = 0; n < 60; n++) {
      // Different links (unknown ones are counted too), so only the address budget is in play.
      const res = n % 2 === 0 ? await json(randomBytes(16).toString("base64url"), { ip }) : await page(randomBytes(16).toString("base64url"), { ip });
      expect(res.statusCode, `read ${n + 1}`).toBe(404);
    }
    const over = await json(token, { ip });
    expect(over.statusCode).toBe(429);
    expect(over.json()).toMatchObject({ code: "rate_limited", reason: "share_too_many" });
    expect(Number(over.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(Number(over.headers["retry-after"])).toBeLessThanOrEqual(60);
    expect(over.body).not.toContain("plate");
    const overPage = await page(token, { ip });
    expect(overPage.statusCode).toBe(429);
    expect(overPage.headers["content-type"]).toMatch(/^text\/html/);
    expect(overPage.headers["retry-after"]).toBeDefined();
    expect(overPage.headers["cache-control"]).toBe("no-store");
    // Another address is not affected.
    expect((await json(token)).statusCode).toBe(200);
    sim.clock.now = new Date(sim.clock.now.getTime() + 60_000);
    expect((await json(token, { ip })).statusCode).toBe(200);
  });

  it("30 reads per link per minute, whatever the address", async () => {
    const { token } = await sharedTrip();
    for (let n = 0; n < 30; n++) expect((n % 2 === 0 ? await json(token) : await page(token)).statusCode, `read ${n + 1}`).toBe(200);
    const over = await json(token);
    expect(over.statusCode).toBe(429);
    expect(over.json()).toMatchObject({ code: "rate_limited", reason: "share_too_many" });
    expect((await page(token)).statusCode).toBe(429);
    sim.clock.now = new Date(sim.clock.now.getTime() + 60_000);
    expect((await json(token)).statusCode).toBe(200);
  });
});

describe("S10 a token is never logged", () => {
  it("making, reading (JSON and page), a miss, the budget and stopping write no token and no link to the log", async () => {
    const { tripId } = await bookAndAccept(sim, rider, a);
    const lines: string[] = [];
    const stream = new Writable({ write: (chunk, _enc, done) => (lines.push(String(chunk)), done()) });
    const app = await buildApp({ env: { ...sim.env, LOG_LEVEL: "trace" }, logger: { stream }, db: sim.db, clock: () => sim.clock.now });
    const tokens: string[] = [];
    try {
      const auth = { authorization: `Bearer ${rider.token}`, "content-type": "application/json" };
      const made = await app.inject({ method: "POST", url: `/api/v1/rider/trips/${tripId}/share`, headers: { ...auth, "idempotency-key": newKey("log") }, payload: {} });
      expect(made.statusCode).toBe(201);
      const token = tokenOf((made.json() as Json)["url"]);
      const unknown = randomBytes(16).toString("base64url");
      tokens.push(token, unknown);
      for (const t of tokens) {
        expect([200, 404]).toContain((await app.inject({ method: "GET", url: `/api/v1/share/${t}?x=${t}` })).statusCode);
        expect([200, 404]).toContain((await app.inject({ method: "GET", url: `/s/${t}`, headers: { referer: `https://example.test/s/${t}` } })).statusCode);
      }
      // Over the per-link budget: the 429 is logged without the link too.
      for (let n = 0; n < 31; n++) await app.inject({ method: "GET", url: `/s/${token}`, remoteAddress: `10.9.${n}.1` });
      expect((await app.inject({ method: "GET", url: `/s/${token}` })).statusCode).toBe(429);
      expect((await app.inject({ method: "DELETE", url: `/api/v1/rider/trips/${tripId}/share`, headers: { ...auth, "idempotency-key": newKey("log") } })).statusCode).toBe(204);
      expect((await app.inject({ method: "GET", url: `/s/${token}`, remoteAddress: "10.9.99.1" })).statusCode).toBe(429);
    } finally {
      await app.close();
    }
    const log = lines.join("");
    expect(log).toContain("/s/:token");
    expect(log).toContain("/api/v1/share/:token");
    for (const t of tokens) {
      expect(log).not.toContain(t);
      expect(log).not.toContain(createHash("sha256").update(t).digest("hex"));
    }
    expect(log).not.toMatch(/\/s\/[A-Za-z0-9_-]{22}/);
  });
});

describe("S10 share rows are kept 30 days", () => {
  it("the clean-up job removes a row 30 days after it was made, never sooner", async () => {
    expect(HOUSEKEEPING_KINDS).toContain(CLEANUP_TRIP_SHARES);
    const { tripId } = await sharedTrip();
    await share(rider, tripId);
    await share(rider, tripId);
    const rows = await sim.db.selectFrom("trip_shares").select("share_id").where("trip_id", "=", tripId).orderBy("share_id").execute();
    expect(rows).toHaveLength(3);
    const day = 24 * 3600_000;
    const now = sim.clock.now.getTime();
    const made = [now - 30 * day - 60_000, now - 30 * day + 60_000, now];
    for (const [n, row] of rows.entries()) await sim.db.updateTable("trip_shares").set({ created_at: new Date(made[n]!), expires_at: new Date(made[n]! + 6 * 3600_000) }).where("share_id", "=", row.share_id).execute();
    await sim.db.insertInto("timers").values({ kind: CLEANUP_TRIP_SHARES, ref_id: "all", due_at: sim.clock.now }).onConflict((c) => c.columns(["kind", "ref_id"]).doUpdateSet({ due_at: sim.clock.now })).execute();
    const worker = new TimerWorker(sim.db, { handlers: { [CLEANUP_TRIP_SHARES]: housekeepingHandlers[CLEANUP_TRIP_SHARES]! }, logger: { warn: () => undefined, error: (data) => { throw new Error(JSON.stringify(data)); } }, clock: () => sim.clock.now });
    await worker.runDue();
    const left = await sim.db.selectFrom("trip_shares").select("share_id").where("trip_id", "=", tripId).orderBy("share_id").execute();
    expect(left.map((r) => r.share_id)).toEqual([rows[1]!.share_id, rows[2]!.share_id]);
    // The job comes back in an hour.
    const next = await sim.db.selectFrom("timers").select("due_at").where("kind", "=", CLEANUP_TRIP_SHARES).executeTakeFirstOrThrow();
    expect((next.due_at as Date).getTime() - now).toBe(3600_000);
  });
});

describe("S10 trusted contacts: EmergencyContact.shareTrips", () => {
  it("the rider's list keeps the flag; a driver's list does not keep it", async () => {
    const items = [
      { name: "Anna", phone: TEST_PHONES[5]!, relation: "sister", shareTrips: true },
      { name: "Bo", phone: "+46700000001", shareTrips: false },
      { name: "Cia", phone: "+46700000002" },
    ];
    const put = await rider.put("/rider/emergency-contacts", { items });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.items).toEqual(items);
    expect((await rider.get("/rider/emergency-contacts")).body.items).toEqual(items);
    // Not true / false: refused, nothing saved.
    expect((await rider.put("/rider/emergency-contacts", { items: [{ name: "Dan", phone: "+46700000003", shareTrips: "yes" }] })).status).toBe(400);
    expect((await rider.get("/rider/emergency-contacts")).body.items).toEqual(items);
    // A driver PUT that carries it is accepted and the field is not kept.
    const driverPut = await a.put("/driver/emergency-contacts", { items: [{ name: "Eva", phone: "+46700000004", shareTrips: true }] });
    expect(driverPut.status, JSON.stringify(driverPut.body)).toBe(200);
    expect(driverPut.body.items).toEqual([{ name: "Eva", phone: "+46700000004" }]);
    expect((await a.get("/driver/emergency-contacts")).body.items).toEqual([{ name: "Eva", phone: "+46700000004" }]);
  });
});
