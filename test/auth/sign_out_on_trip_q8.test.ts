import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { contract, CONTRACTS_DIR } from "../../src/contract/contract.js";
import { dispatchHandlers } from "../../src/dispatch/runtime.js";
import { seedDriver } from "../../src/drivers/service.js";
import { TimerWorker } from "../../src/jobs/timers.js";
import { rideHandlers } from "../../src/trips/ride.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { call, NORRMALM, SODERMALM, signIn, testWorld } from "../support/world.js";

/**
 * Contract v0.18.49 §71, owner Q8 "Server refuses too" (Rules decisions/session-2026-11-06.md; finding A3): the server
 * refuses a driver's sign-out while he has a current trip (409 conflict sign_out_on_trip, « Terminez d’abord la
 * course. »). Before v0.18.49 POST /auth/sign-out always answered 204 and the trip was left running without him.
 */

type SignOutOnTrip = { status: number; code: string; reason: string; texts: { finishTripFirst: Record<"sv" | "fr" | "en", string> } };
const RULE = (contract as unknown as { auth: { signOutOnTrip: SignOutOnTrip } }).auth.signOutOnTrip;

let database: TestDatabase;
let app: FastifyInstance;
let worker: TimerWorker;
const clock = { now: new Date("2026-11-07T10:00:00Z") };
const sample = (name: string) => JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/${name}.json`, "utf8"));
const SPOT = { lat: 59.3335, lng: 18.0655 };
let driverId: string;
let driver: Record<string, string>;
let rider: Record<string, string>;

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  await database.db.insertInto("config_live").values([
    { doc: "dispatch", zone_id: "Z001", version: 1, document: JSON.stringify(sample("dispatch_document")), published_at: clock.now, published_by: null },
    { doc: "rider_app_config", zone_id: "Z001", version: 1, document: JSON.stringify(sample("rider_app_config")), published_at: clock.now, published_by: null },
  ]).execute();
  worker = new TimerWorker(database.db, { handlers: { ...dispatchHandlers, ...rideHandlers }, logger: { warn: () => undefined, error: (d, m) => console.error(m, d) }, clock: () => clock.now });
  const made = await database.db.transaction().execute((trx) =>
    seedDriver(trx, { phone: TEST_PHONES[1]!, firstName: "Driver Q", make: "Volvo", model: "V60", year: 2021, color: "Black", plate: "QEIGHT1", categoryIds: ["economy"], zoneIds: ["Z001"] }, clock.now),
  );
  driverId = made.driverId;
});
afterAll(async () => {
  await app.close();
  await database.drop();
});
beforeEach(async () => {
  clock.now = new Date(clock.now.getTime() + 3600_000);
  // Each test starts with no running trip (a failed test must not leave one behind).
  await database.db.updateTable("trips").set({ status: "cancelled_by_admin", ended_at: clock.now }).where("status", "not in", ["completed", "cancelled_by_admin", "cancelled_by_rider", "cancelled_by_driver", "no_show", "expired"]).execute();
  await database.db.deleteFrom("timers").execute();
  await database.db.deleteFrom("offers").execute();
  rider = (await signIn(app, TEST_PHONES[0]!, "rider")).headers;
  driver = (await signIn(app, TEST_PHONES[1]!, "driver")).headers;
  await database.db.updateTable("drivers").set({ online_status: "online", last_free_at: clock.now }).where("driver_id", "=", driverId).execute();
  expect((await call(app, "POST", "/driver/location", driver, { fixes: [{ ...SPOT, accuracy: 5, measuredAt: clock.now.toISOString() }] })).statusCode).toBe(200);
});

async function acceptedTrip(): Promise<string> {
  const quote = (await call(app, "POST", "/quotes", rider, { pickup: NORRMALM, dropoff: SODERMALM, stops: [], categoryIds: ["economy"] })).json().quotes[0];
  const trip = (await call(app, "POST", "/trips", rider, { quoteId: quote.quoteId, categoryId: "economy", pickup: NORRMALM, dropoff: SODERMALM, stops: [], kind: "live", paymentMethod: "cash" })).json();
  await worker.runDue();
  const [offer] = (await call(app, "GET", "/driver/offers", driver)).json().items;
  expect(offer?.tripId).toBe(trip.tripId);
  const res = await call(app, "POST", `/offers/${offer.offerId}/accept`, driver, { expectedVersion: offer.version });
  expect(res.statusCode, res.body).toBe(200);
  return trip.tripId as string;
}
const signOut = (headers: Record<string, string>) => app.inject({ method: "POST", url: "/api/v1/auth/sign-out", headers: { ...headers, "content-type": "application/json" }, body: "" });

describe("owner Q8: no driver sign-out during a trip", () => {
  it("the contract has the rule and the three texts", () => {
    expect([RULE.status, RULE.code, RULE.reason]).toEqual([409, "conflict", "sign_out_on_trip"]);
    expect(RULE.texts.finishTripFirst).toEqual({ sv: "Avsluta resan först.", fr: "Terminez d’abord la course.", en: "Finish the trip first." });
  });

  it("a driver on a trip: 409 sign_out_on_trip in his language; still signed in, push devices kept, trip unchanged (fail-before: 204)", async () => {
    const tripId = await acceptedTrip();
    await database.db.updateTable("drivers").set({ language: "fr" }).where("driver_id", "=", driverId).execute();
    await database.db.insertInto("push_devices").values({ token: "q8-device", actor: "driver", subject_id: driverId, session_id: (await database.db.selectFrom("auth_sessions").select("session_id").where("actor", "=", "driver").where("subject_id", "=", driverId).where("revoked_at", "is", null).executeTakeFirstOrThrow()).session_id, provider: "fcm", platform: "web", app_version: null, locale: null, updated_at: clock.now }).execute();
    const res = await signOut(driver);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toMatchObject({ code: "conflict", reason: "sign_out_on_trip", message: "Terminez d’abord la course." });
    expect((await call(app, "GET", "/driver/profile", driver)).json()).toMatchObject({ activeTripId: tripId });
    expect(await database.db.selectFrom("push_devices").select("token").where("token", "=", "q8-device").executeTakeFirst()).toBeDefined();
    expect((await database.db.selectFrom("trips").select("driver_id").where("trip_id", "=", tripId).executeTakeFirstOrThrow()).driver_id).toBe(driverId);
    for (const [lang, text] of [["sv", "Avsluta resan först."], ["en", "Finish the trip first."]] as const) {
      await database.db.updateTable("drivers").set({ language: lang }).where("driver_id", "=", driverId).execute();
      expect((await signOut(driver)).json().message).toBe(text);
    }
    // After the trip ends he can sign out (204), and twice is still fine.
    await database.db.updateTable("trips").set({ status: "cancelled_by_admin", ended_at: clock.now }).where("trip_id", "=", tripId).execute();
    expect((await signOut(driver)).statusCode).toBe(204);
    expect((await signOut(driver)).statusCode).toBe(204);
  });

  it("no trip: 204 as before; the rider is never refused, also while his trip runs", async () => {
    const tripId = await acceptedTrip();
    expect((await signOut(rider)).statusCode).toBe(204);
    await database.db.updateTable("trips").set({ status: "cancelled_by_admin", ended_at: clock.now }).where("trip_id", "=", tripId).execute();
    expect((await signOut(driver)).statusCode).toBe(204);
  });

  it("a session already ended (signed in on another phone) still signs out with 204 during a trip", async () => {
    const tripId = await acceptedTrip();
    await database.db.updateTable("auth_sessions").set({ revoked_at: clock.now, revoked_reason: "signed_in_elsewhere" }).where("actor", "=", "driver").where("subject_id", "=", driverId).where("revoked_at", "is", null).execute();
    expect((await signOut(driver)).statusCode).toBe(204);
    await database.db.updateTable("trips").set({ status: "cancelled_by_admin", ended_at: clock.now }).where("trip_id", "=", tripId).execute();
  });
});
