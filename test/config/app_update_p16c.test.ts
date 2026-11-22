import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { CONTRACTS_DIR, contract } from "../../src/contract/contract.js";
import { appClientOf, appUpdateProblem, compareVersions, minVersionOf } from "../../src/config/appUpdate.js";
import { forgetLiveDocuments } from "../../src/config/service.js";
import { dispatchHandlers } from "../../src/dispatch/runtime.js";
import { seedDriver } from "../../src/drivers/service.js";
import { TimerWorker } from "../../src/jobs/timers.js";
import { rideHandlers } from "../../src/trips/ride.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { call, NORRMALM, SODERMALM, signIn, testWorld } from "../support/world.js";

/**
 * Contract v0.18.154 P16c (contract.json#appUpdate; owner 2026-11-21 20:30 "Yes, build it now (Recommended)"). Rule 36:
 * on main every call below is served whatever the app version (no minimum exists), the bad documents are saved, and a
 * save that leaves out appUpdate drops the minimum. Below / equal / above / missing header; the never-refuse list.
 */
let database: TestDatabase;
let app: FastifyInstance;
let worker: TimerWorker;
let admin: Record<string, string>;
let rider: Record<string, string>;
let driver: { id: string; headers: Record<string, string> };
const clock = { now: new Date("2026-11-21T12:00:00Z") };
const sample = (name: string) => JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/${name}.json`, "utf8"));
const SPOT = { lat: 59.3335, lng: 18.0655 };
const phone = (version: string, platform = "android") => ({ "x-app-version": version, "x-app-platform": platform });
const MIN = { minVersion: { android: "1.4.0", ios: null }, storeUrls: { android: "https://play.google.com/store/apps/details?id=example.fake", ios: null } };

async function setLive(doc: "rider_app_config" | "driver_app_config", appUpdate: unknown) {
  const document = { ...sample(doc), appUpdate: { ...sample(doc).appUpdate, ...(appUpdate as object) } };
  await database.db.insertInto("config_live").values({ doc, zone_id: "Z001", version: 2, document: JSON.stringify(document), published_at: clock.now, published_by: null })
    .onConflict((c) => c.columns(["doc", "zone_id"]).doUpdateSet({ document: JSON.stringify(document) })).execute();
  forgetLiveDocuments();
}

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  admin = (await adminSession(app, database.db, "super", { now: clock.now })).headers;
  await database.db.insertInto("config_live").values([
    { doc: "dispatch", zone_id: "Z001", version: 1, document: JSON.stringify(sample("dispatch_document")), published_at: clock.now, published_by: null },
  ]).execute();
  worker = new TimerWorker(database.db, { handlers: { ...dispatchHandlers, ...rideHandlers }, logger: { warn: () => undefined, error: (d, m) => console.error(m, d) }, clock: () => clock.now });
  const made = await database.db.transaction().execute((trx) =>
    seedDriver(trx, { phone: TEST_PHONES[1]!, firstName: "Driver P", make: "Volvo", model: "V60", year: 2021, color: "Black", plate: "MINV001", categoryIds: ["economy"], zoneIds: ["Z001"] }, clock.now),
  );
  driver = { id: made.driverId, headers: {} };
});
afterAll(async () => {
  await app.close();
  await database.drop();
});
beforeEach(async () => {
  clock.now = new Date(clock.now.getTime() + 3600_000);
  await database.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("status", "not in", ["completed", "cancelled_by_admin", "cancelled_by_rider", "cancelled_by_driver", "no_show", "expired"]).execute();
  await database.db.deleteFrom("timers").execute();
  await database.db.deleteFrom("offers").execute();
  rider = (await signIn(app, TEST_PHONES[0]!, "rider")).headers;
  await call(app, "GET", "/rider/profile", rider);
  driver.headers = (await signIn(app, TEST_PHONES[1]!, "driver")).headers;
  await database.db.updateTable("drivers").set({ online_status: "offline", last_free_at: clock.now }).where("driver_id", "=", driver.id).execute();
  await call(app, "POST", "/driver/location", driver.headers, { fixes: [{ ...SPOT, accuracy: 5, measuredAt: clock.now.toISOString() }] });
  await setLive("rider_app_config", MIN);
  await setLive("driver_app_config", MIN);
});

async function book(headers: Record<string, string>) {
  const quote = (await call(app, "POST", "/quotes", rider, { pickup: NORRMALM, dropoff: SODERMALM, stops: [], categoryIds: ["economy"] })).json().quotes[0];
  return call(app, "POST", "/trips", { ...rider, ...headers }, { quoteId: quote.quoteId, categoryId: "economy", pickup: NORRMALM, dropoff: SODERMALM, stops: [], kind: "live", paymentMethod: "cash" });
}
const driverVersion = async () => (await database.db.selectFrom("drivers").select("version").where("driver_id", "=", driver.id).executeTakeFirstOrThrow()).version;
const goOnline = async (headers: Record<string, string>, onlineStatus: "online" | "offline" = "online") =>
  call(app, "POST", "/driver/availability", { ...driver.headers, ...headers }, { expectedVersion: await driverVersion(), onlineStatus, location: { ...SPOT, accuracy: 5, measuredAt: clock.now.toISOString() } });

function expect426(res: { statusCode: number; json: () => Record<string, unknown> }, platform = "android", min = "1.4.0") {
  expect(res.statusCode).toBe(426);
  expect(res.json()).toMatchObject({ code: "upgrade_required", reason: "app_update_required", retryable: false, details: [`platform:${platform}`, `minVersion:${min}`] });
}

describe("rules of the check (contract.json#appUpdate)", () => {
  it("compares number by number and reads only valid headers", () => {
    expect(compareVersions("1.9.3", "1.10.0")).toBe(-1);
    expect(compareVersions("1.4.0", "1.4.0")).toBe(0);
    expect(compareVersions("2.0.0", "1.99.99")).toBe(1);
    const req = (headers: Record<string, string>) => ({ headers }) as never;
    expect(appClientOf(req(phone("1.3.0")))).toEqual({ version: "1.3.0", platform: "android" });
    expect(appClientOf(req(phone("1.3.0", "IOS")))).toEqual({ version: "1.3.0", platform: "ios" });
    for (const bad of <Record<string, string>[]>[{}, { "x-app-version": "1.3.0" }, { "x-app-platform": "android" }, phone("dev"), phone("1.3.0+7"), phone("1.3"), phone("1.3.0", "web")]) {
      expect(appClientOf(req(bad))).toBeNull();
    }
    expect(minVersionOf({ appUpdate: { minimumVersion: "9.0.0" } }, "android")).toBeNull();
    expect(minVersionOf({ appUpdate: MIN }, "android")).toBe("1.4.0");
    expect(minVersionOf({ appUpdate: MIN }, "ios")).toBeNull();
  });

  it("validates minVersion and storeUrls (null = off; the older keys are not read)", () => {
    expect(appUpdateProblem({})).toBeNull();
    expect(appUpdateProblem({ appUpdate: { minimumVersion: "1.0.0", latestVersion: "1.2.0" } })).toBeNull();
    expect(appUpdateProblem({ appUpdate: MIN })).toBeNull();
    expect(appUpdateProblem({ appUpdate: { minVersion: { android: null, ios: null }, storeUrls: { android: null, ios: null } } })).toBeNull();
    for (const bad of [
      { appUpdate: "1.4.0" },
      { appUpdate: { minVersion: "1.4.0" } },
      { appUpdate: { minVersion: { android: "1.4" } } },
      { appUpdate: { minVersion: { android: "v1.4.0" } } },
      { appUpdate: { minVersion: { android: "1.04.0" } } },
      { appUpdate: { minVersion: { ios: 140 } } },
      { appUpdate: { minVersion: { web: "1.0.0" } } },
      { appUpdate: { storeUrls: { ios: "http://apps.apple.com/x" } } },
      { appUpdate: { storeUrls: { android: `https://x.example/${"a".repeat(500)}` } } },
    ]) expect(appUpdateProblem(bad)).not.toBeNull();
  });
});

describe("the admin save (PUT /admin/config/{doc})", () => {
  beforeEach(async () => {
    admin = (await adminSession(app, database.db, "super", { now: clock.now })).headers;
  });
  const draft = async (doc: string) => {
    const res = await call(app, "GET", `/admin/config/${doc}?zoneId=Z001`, admin);
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  };
  const put = (doc: string, version: number, document: unknown) => call(app, "PUT", `/admin/config/${doc}`, admin, { expectedVersion: version, zoneId: "Z001", document });

  it("refuses a bad minimum with 400 invalid_document and saves a good one", async () => {
    for (const doc of ["rider_app_config", "driver_app_config"] as const) {
      const current = await draft(doc);
      const bad = await put(doc, current.version, { ...current.document, appUpdate: { ...current.document.appUpdate, minVersion: { android: "1.4" } } });
      expect(bad.statusCode).toBe(400);
      expect(bad.json()).toMatchObject({ code: "invalid_request", reason: "invalid_document" });
      const badUrl = await put(doc, current.version, { ...current.document, appUpdate: { ...current.document.appUpdate, storeUrls: { ios: "ftp://x" } } });
      expect(badUrl.json()).toMatchObject({ reason: "invalid_document" });
      const good = await put(doc, current.version, { ...current.document, appUpdate: { ...current.document.appUpdate, minVersion: { android: "2.0.0", ios: "2.1.0" } } });
      expect(good.statusCode).toBe(200);
      expect(good.json().document.appUpdate.minVersion).toEqual({ android: "2.0.0", ios: "2.1.0" });
    }
  });

  it("a save that leaves out appUpdate.minVersion / storeUrls keeps them (kept keys)", async () => {
    for (const doc of ["rider_app_config", "driver_app_config"] as const) {
      const current = await draft(doc);
      const appUpdate = { ...current.document.appUpdate };
      delete appUpdate.minVersion;
      delete appUpdate.storeUrls;
      const res = await put(doc, current.version, { ...current.document, appUpdate });
      expect(res.statusCode).toBe(200);
      expect(res.json().document.appUpdate.minVersion).toEqual({ android: "2.0.0", ios: "2.1.0" });
      expect(res.json().keptKeys).toContain("appUpdate.minVersion");
    }
  });

  it("the server's kept keys are the contract's", async () => {
    const { KEPT_KEYS } = await import("../../src/config/keptKeys.js");
    const kk = (contract as unknown as { configDocs: { keptKeys: Record<string, string[]> } }).configDocs.keptKeys;
    expect(KEPT_KEYS.rider_app_config).toEqual(kk["rider_app_config"]);
    expect(KEPT_KEYS.driver_app_config).toEqual(kk["driver_app_config"]);
  });
});

describe("POST /trips (book)", () => {
  it("below the minimum: 426, nothing booked", async () => {
    const before = await database.db.selectFrom("trips").select(({ fn }) => fn.countAll<number>().as("n")).executeTakeFirstOrThrow();
    expect426(await book(phone("1.3.9")));
    const after = await database.db.selectFrom("trips").select(({ fn }) => fn.countAll<number>().as("n")).executeTakeFirstOrThrow();
    expect(Number(after.n)).toBe(Number(before.n));
  });
  it("equal, above, another platform with no minimum, a missing or bad header: booked", async () => {
    for (const headers of <Record<string, string>[]>[phone("1.4.0"), phone("1.10.0"), phone("1.3.9", "ios"), {}, { "x-app-version": "1.3.9" }, phone("dev")]) {
      const res = await book(headers);
      expect(res.statusCode, JSON.stringify(headers)).toBe(201);
      await database.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("trip_id", "=", res.json().tripId).execute();
    }
  });
  it("no minimum (default off, null): booked", async () => {
    await setLive("rider_app_config", { minVersion: { android: null, ios: null } });
    expect((await book(phone("0.0.1"))).statusCode).toBe(201);
  });
});

describe("driver go-online (POST /driver/availability)", () => {
  it("below: 426 and he stays offline; equal / missing header: online", async () => {
    expect426(await goOnline(phone("1.3.0")));
    expect((await database.db.selectFrom("drivers").select("online_status").where("driver_id", "=", driver.id).executeTakeFirstOrThrow()).online_status).toBe("offline");
    const equal = await goOnline(phone("1.4.0"));
    expect(equal.statusCode, equal.body).toBe(200);
    await database.db.updateTable("drivers").set({ online_status: "offline" }).where("driver_id", "=", driver.id).execute();
    expect((await goOnline({})).statusCode).toBe(200);
  });
  it("a driver who holds a booked ride (accepted reservation) goes online whatever the version", async () => {
    const trip = (await book({})).json();
    await database.db.updateTable("trips").set({ kind: "scheduled", status: "accepted", driver_id: driver.id, scheduled_at: new Date(clock.now.getTime() + 3600_000) }).where("trip_id", "=", trip.tripId).execute();
    await database.db.updateTable("drivers").set({ online_status: "offline" }).where("driver_id", "=", driver.id).execute();
    const res = await goOnline(phone("1.0.0"));
    expect(res.statusCode, res.body).toBe(200);
    await database.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("trip_id", "=", trip.tripId).execute();
  });
  it("another driver's booked ride does not exempt him", async () => {
    const other = await database.db.transaction().execute((trx) =>
      seedDriver(trx, { phone: TEST_PHONES[2]!, firstName: "Driver Q", make: "Volvo", model: "V60", year: 2021, color: "Black", plate: "MINV002", categoryIds: ["economy"], zoneIds: ["Z001"] }, clock.now),
    );
    const trip = (await book({})).json();
    await database.db.updateTable("trips").set({ kind: "scheduled", status: "accepted", driver_id: other.driverId, scheduled_at: new Date(clock.now.getTime() + 3600_000) }).where("trip_id", "=", trip.tripId).execute();
    await database.db.updateTable("drivers").set({ online_status: "offline" }).where("driver_id", "=", driver.id).execute();
    expect426(await goOnline(phone("1.0.0")));
    await database.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("trip_id", "=", trip.tripId).execute();
  });
  it("go offline is never refused", async () => {
    await database.db.updateTable("drivers").set({ online_status: "online" }).where("driver_id", "=", driver.id).execute();
    const res = await goOnline(phone("1.0.0"), "offline");
    expect(res.statusCode).toBe(200);
  });
});

describe("offer accept and the trip (never mid-trip)", () => {
  async function offered() {
    await database.db.updateTable("drivers").set({ online_status: "online", last_free_at: clock.now }).where("driver_id", "=", driver.id).execute();
    await call(app, "POST", "/driver/location", driver.headers, { fixes: [{ ...SPOT, accuracy: 5, measuredAt: clock.now.toISOString() }] });
    const trip = (await book({})).json();
    await worker.runDue();
    const [offer] = (await call(app, "GET", "/driver/offers", driver.headers)).json().items;
    expect(offer?.tripId).toBe(trip.tripId);
    return { tripId: trip.tripId as string, offer };
  }

  it("accept below: 426, the offer stays open; equal: accepted", async () => {
    const { offer } = await offered();
    expect426(await call(app, "POST", `/offers/${offer.offerId}/accept`, { ...driver.headers, ...phone("1.3.0") }, { expectedVersion: offer.version }));
    expect((await database.db.selectFrom("offers").select("status").where("offer_id", "=", offer.offerId).executeTakeFirstOrThrow()).status).toBe("open");
    const ok = await call(app, "POST", `/offers/${offer.offerId}/accept`, { ...driver.headers, ...phone("1.4.0") }, { expectedVersion: offer.version });
    expect(ok.statusCode).toBe(200);
  });

  it("on a running trip: trip steps, go-online, SOS, sign-out and account deletion are never refused", async () => {
    const { tripId, offer } = await offered();
    const accepted = await call(app, "POST", `/offers/${offer.offerId}/accept`, driver.headers, { expectedVersion: offer.version });
    expect(accepted.statusCode).toBe(200);
    const old = { ...driver.headers, ...phone("1.0.0") };
    const step = await call(app, "POST", `/trips/${tripId}/head-to-pickup`, old, { expectedVersion: accepted.json().version });
    expect(step.statusCode).toBe(200);
    expect((await goOnline(phone("1.0.0"))).statusCode).toBe(200);
    const sos = await call(app, "POST", `/driver/trips/${tripId}/sos`, old, { at: clock.now.toISOString() });
    expect(sos.statusCode).toBe(200);
    const riderSos = await call(app, "POST", `/rider/trips/${tripId}/sos`, { ...rider, ...phone("1.0.0") }, { at: clock.now.toISOString() });
    expect(riderSos.statusCode).toBe(200);
    const deletion = await call(app, "POST", "/account/deletion", { ...rider, ...phone("1.0.0") });
    expect(deletion.statusCode).toBe(202);
    const out = await app.inject({ method: "POST", url: "/api/v1/auth/sign-out", headers: { ...rider, ...phone("1.0.0") } });
    expect(out.statusCode).toBe(204);
  });
});
