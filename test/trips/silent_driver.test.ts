import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { dispatchHandlers } from "../../src/dispatch/runtime.js";
import { seedDriver } from "../../src/drivers/service.js";
import { maintenanceHandlers } from "../../src/jobs/maintenance.js";
import { TimerWorker } from "../../src/jobs/timers.js";
import { DRIVER_SILENCE, rideHandlers } from "../../src/trips/ride.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { call, NORRMALM, SODERMALM, signIn, testWorld } from "../support/world.js";

/**
 * Owner decision 2026-10-26: with the rider on board and no driver position, an admin alert after 30 minutes and a
 * failed trip with no charge after 3 hours. Before pickup nothing happens.
 */

let database: TestDatabase;
let app: FastifyInstance;
let worker: TimerWorker;
const clock = { now: new Date("2026-10-26T08:00:00Z") };
const MIN = 60;
const advance = async (seconds: number) => {
  clock.now = new Date(clock.now.getTime() + seconds * 1000);
  await worker.runDue();
};
const sample = (name: string) => JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/${name}.json`, "utf8"));

const SPOT = { lat: 59.3335, lng: 18.0655 };
const driver = { id: "", phone: TEST_PHONES[1]! };
const riderPhone = TEST_PHONES[0]!;

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  await database.db.insertInto("config_live").values([
    { doc: "dispatch", zone_id: "Z001", version: 1, document: JSON.stringify(sample("dispatch_document")), published_at: clock.now, published_by: null },
    { doc: "rider_app_config", zone_id: "Z001", version: 1, document: JSON.stringify(sample("rider_app_config")), published_at: clock.now, published_by: null },
  ]).execute();
  worker = new TimerWorker(database.db, { handlers: { ...dispatchHandlers, ...rideHandlers, ...maintenanceHandlers }, logger: { warn: () => undefined, error: (d, m) => console.error(m, d) }, clock: () => clock.now });
  const made = await database.db.transaction().execute((trx) =>
    seedDriver(trx, { phone: driver.phone, firstName: "Driver S", make: "Volvo", model: "V60", year: 2021, color: "Black", plate: "SIL001", categoryIds: ["economy"], zoneIds: ["Z001"] }, clock.now),
  );
  driver.id = made.driverId;
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

// Tokens do not outlive hours of test clock: sign in again once a token is a few minutes old (a new code may be
// asked for only every 30 s, so not on every call).
const tokens = new Map<string, { at: number; headers: Record<string, string> }>();
async function headersOf(phone: string, appName: "rider" | "driver") {
  const held = tokens.get(appName);
  const age = held ? clock.now.getTime() - held.at : Infinity;
  if (held && age >= 0 && age < 5 * 60_000) return held.headers;
  const { headers } = await signIn(app, phone, appName);
  tokens.set(appName, { at: clock.now.getTime(), headers });
  return headers;
}
const riderHeaders = () => headersOf(riderPhone, "rider");
const driverHeaders = () => headersOf(driver.phone, "driver");
const adminView = async (tripId: string) => (await call(app, "GET", `/admin/trips/${tripId}`, (await adminSession(app, database.db, "super", { now: clock.now })).headers)).json();
const driverRow = () => database.db.selectFrom("drivers").selectAll().where("driver_id", "=", driver.id).executeTakeFirstOrThrow();
const silenceTimer = (tripId: string) => database.db.selectFrom("timers").selectAll().where("kind", "=", DRIVER_SILENCE).where("ref_id", "=", tripId).executeTakeFirst();

async function sendFix(at: { lat: number; lng: number } = SPOT) {
  const res = await call(app, "POST", "/driver/location", await driverHeaders(), { fixes: [{ ...at, accuracy: 5, measuredAt: clock.now.toISOString() }] });
  expect(res.statusCode).toBe(200);
}

beforeEach(async () => {
  clock.now = new Date(clock.now.getTime() + 24 * 3600_000);
  await database.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("status", "not in", ["completed", "cancelled_by_admin", "cancelled_by_rider", "cancelled_by_driver", "cancelled_by_system", "no_show", "expired", "failed"]).execute();
  await database.db.deleteFrom("timers").execute();
  await database.db.deleteFrom("offers").execute();
  await database.db.updateTable("drivers").set({ online_status: "online", last_free_at: clock.now }).where("driver_id", "=", driver.id).execute();
  await sendFix();
});

async function book(rider: Record<string, string>) {
  const quote = (await call(app, "POST", "/quotes", rider, { pickup: NORRMALM, dropoff: SODERMALM, stops: [], categoryIds: ["economy"] })).json().quotes[0];
  const res = await call(app, "POST", "/trips", rider, { quoteId: quote.quoteId, categoryId: "economy", pickup: NORRMALM, dropoff: SODERMALM, stops: [], kind: "live", paymentMethod: "cash" });
  await worker.runDue();
  return res;
}

/** The rider books, the driver accepts. */
async function accepted() {
  const res = await book(await riderHeaders());
  expect(res.statusCode).toBe(201);
  const tripId = res.json().tripId as string;
  const headers = await driverHeaders();
  const [offer] = (await call(app, "GET", "/driver/offers", headers)).json().items;
  expect(offer?.tripId).toBe(tripId);
  const accept = await call(app, "POST", `/offers/${offer.offerId}/accept`, headers, { expectedVersion: offer.version });
  expect(accept.statusCode).toBe(200);
  return { tripId, version: accept.json().version as number };
}

async function step(tripId: string, path: string, version: number) {
  const res = await call(app, "POST", `/trips/${tripId}/${path}`, await driverHeaders(), { expectedVersion: version });
  expect(res.statusCode).toBe(200);
  return res.json();
}

/** Accepted, at the pickup, rider on board and the trip started: the driver's last position is from the pickup. */
async function onBoard() {
  const { tripId, version } = await accepted();
  let v = version;
  await step(tripId, "head-to-pickup", v++);
  await sendFix(NORRMALM);
  await step(tripId, "arrive", v++);
  await step(tripId, "board", v++);
  const started = await step(tripId, "start", v++);
  expect(started.status).toBe("in_trip");
  return { tripId, boardedAt: new Date(clock.now), version: started.version as number };
}

describe("a driver silent with the rider on board (owner decision 2026-10-26)", () => {
  it("S1 29 minutes without a position: nothing happens", async () => {
    const { tripId } = await onBoard();
    await advance(29 * MIN);
    const view = await adminView(tripId);
    expect(view.status).toBe("in_trip");
    expect(view).not.toHaveProperty("driverSilentAlert");
    expect((await driverRow()).online_status).toBe("on_trip");
  });

  it("S2 30 minutes: an alert for admins, never shown to the rider or the driver; the trip goes on", async () => {
    const { tripId, boardedAt } = await onBoard();
    await advance(30 * MIN);
    const view = await adminView(tripId);
    expect(view.status).toBe("in_trip");
    expect(view.driverSilentAlert).toEqual({
      kind: "driver_silent",
      silentSince: boardedAt.toISOString(),
      lastFixAt: expect.any(String),
      at: clock.now.toISOString(),
      autoFailAt: new Date(boardedAt.getTime() + 3 * 3600_000).toISOString(),
    });
    // The admin list carries it too, so the panel can raise its alert from the list of trips on board.
    const admin = (await adminSession(app, database.db, "super", { now: clock.now })).headers;
    const list = (await call(app, "GET", "/admin/trips?status=rider_onboard&status=in_trip&status=approaching_dropoff", admin)).json();
    expect(list.items.find((t: { tripId: string }) => t.tripId === tripId)?.driverSilentAlert?.kind).toBe("driver_silent");
    // The alert is an event on the trip's stream (same version), redacted for the apps.
    const last = await database.db.selectFrom("trip_events").selectAll().where("trip_id", "=", tripId).orderBy("sequence", "desc").limit(1).executeTakeFirstOrThrow();
    expect(last.kind).toBe("trip_projection");
    expect(last.version).toBe(view.version);
    expect((last.projection as Record<string, unknown>)["driverSilentAlert"]).toBeDefined();
    const riderSees = (await call(app, "GET", `/trips/${tripId}`, await riderHeaders())).json();
    expect(riderSees.status).toBe("in_trip");
    expect(riderSees).not.toHaveProperty("driverSilentAlert");
    const driverSees = (await call(app, "GET", `/trips/${tripId}`, await driverHeaders())).json();
    expect(driverSees).not.toHaveProperty("driverSilentAlert");
    const events = (await call(app, "GET", `/trips/${tripId}/events?after=0`, await riderHeaders())).body;
    expect(events).not.toContain("driverSilentAlert");
    expect((await driverRow()).online_status).toBe("on_trip");
  });

  it("S3 3 hours: the server fails the trip with no charge; the rider books again and the driver is free", async () => {
    const { tripId } = await onBoard();
    await advance(30 * MIN);
    expect((await adminView(tripId)).driverSilentAlert).toBeDefined();
    await advance(149 * MIN);
    expect((await adminView(tripId)).status).toBe("in_trip");
    await advance(1 * MIN);

    const view = await adminView(tripId);
    expect(view.status).toBe("failed");
    // No charge: no fare, nothing captured, no driver money, no wallet.
    expect(view.fare).toEqual({ amountMinor: 0, currency: "SEK" });
    expect(view.fareLines).toEqual([]);
    expect(view).not.toHaveProperty("paymentStatus");
    expect(view.driverEarnings).toEqual({ amountMinor: 0, currency: "SEK" });
    expect(view.commission).toEqual({ amountMinor: 0, currency: "SEK" });
    expect(view).not.toHaveProperty("walletApplied");
    expect(view.cancellation).toEqual({ actor: "system", reasonCode: "system_error", at: clock.now.toISOString(), fee: null });
    // The booked price stays on the quote, and the reason stays on the trip for the admin.
    expect(view.quote.total.amountMinor).toBeGreaterThan(0);
    expect(view.driverSilentAlert.kind).toBe("driver_silent");
    const row = await database.db.selectFrom("trips").selectAll().where("trip_id", "=", tripId).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ ended_by_command: "fail", payment_status: null, cash_collected_minor: "0", wallet_applied_minor: "0" });
    expect(await database.db.selectFrom("earnings_entries").selectAll().where("trip_id", "=", tripId).execute()).toEqual([]);
    expect(await database.db.selectFrom("rider_fees").selectAll().where("trip_id", "=", tripId).execute()).toEqual([]);

    // Both get the normal end: one trip_projection with the failed trip, on the rider's and the driver's streams.
    const rider = await riderHeaders();
    const riderSees = (await call(app, "GET", `/trips/${tripId}`, rider)).json();
    expect(riderSees.status).toBe("failed");
    expect(riderSees).not.toHaveProperty("driverSilentAlert");
    const last = await database.db.selectFrom("trip_events").selectAll().where("trip_id", "=", tripId).orderBy("sequence", "desc").limit(1).executeTakeFirstOrThrow();
    expect(last).toMatchObject({ kind: "trip_projection", version: view.version });
    expect((last.projection as { status: string }).status).toBe("failed");
    expect((await call(app, "GET", `/trips/${tripId}`, await driverHeaders())).json().status).toBe("failed");

    // The driver is out of on_trip and gets offers again; the rider can book again.
    expect((await driverRow()).online_status).toBe("online");
    await sendFix();
    const again = await book(rider);
    expect(again.statusCode).toBe(201);
    const [offer] = (await call(app, "GET", "/driver/offers", await driverHeaders())).json().items;
    expect(offer?.tripId).toBe(again.json().tripId);
    expect(await silenceTimer(tripId)).toBeUndefined();
  });

  it("S4 fresh positions during the trip: nothing happens, however long the ride", async () => {
    const { tripId } = await onBoard();
    for (let minutes = 0; minutes < 4 * 60; minutes += 10) {
      await advance(10 * MIN);
      await sendFix();
    }
    const view = await adminView(tripId);
    expect(view.status).toBe("in_trip");
    expect(view).not.toHaveProperty("driverSilentAlert");
    expect((await driverRow()).online_status).toBe("on_trip");
    // The check is still booked, at most 30 minutes ahead (a new position does not move it; the check looks then).
    const due = (await silenceTimer(tripId))!.due_at.getTime();
    expect(due).toBeGreaterThan(clock.now.getTime());
    expect(due).toBeLessThanOrEqual(clock.now.getTime() + 30 * 60_000);
  });

  it("S5 the alert goes when positions come back, and the 3 hours start again from the last one", async () => {
    const { tripId } = await onBoard();
    await advance(40 * MIN);
    expect((await adminView(tripId)).driverSilentAlert).toBeDefined();
    await sendFix();
    const back = new Date(clock.now);
    await advance(5 * MIN);
    expect(await adminView(tripId)).not.toHaveProperty("driverSilentAlert");
    // Silent again: 3 hours from the position that came back, not from boarding.
    await advance(3 * 3600 - 5 * MIN - 1);
    const view = await adminView(tripId);
    expect(view.status).toBe("in_trip");
    expect(view.driverSilentAlert.silentSince).toBe(back.toISOString());
    await advance(1);
    expect((await adminView(tripId)).status).toBe("failed");
  });

  it("S6 before pickup (accepted, driver_to_pickup, arrived) nothing happens, however long the driver is silent", async () => {
    for (const until of ["accepted", "driver_to_pickup", "arrived"] as const) {
      const { tripId, version } = await accepted();
      let v = version;
      if (until !== "accepted") await step(tripId, "head-to-pickup", v++);
      if (until === "arrived") {
        await sendFix(NORRMALM);
        await step(tripId, "arrive", v++);
      }
      await advance(4 * 3600);
      const view = await adminView(tripId);
      expect(view.status).toBe(until);
      expect(view).not.toHaveProperty("driverSilentAlert");
      expect(await silenceTimer(tripId)).toBeUndefined();
      expect((await driverRow()).online_status).toBe("on_trip");
      // Leave it the way a rider would: cancel.
      const cancel = await call(app, "POST", `/trips/${tripId}/cancel`, await riderHeaders(), { expectedVersion: v, reasonCode: "wait_too_long" });
      expect(cancel.statusCode).toBe(200);
      await database.db.updateTable("drivers").set({ online_status: "online" }).where("driver_id", "=", driver.id).execute();
      await sendFix();
    }
  });

  it("S7 a trip already on board when the check did not exist gets one from the hourly maintenance job", async () => {
    const { tripId } = await onBoard();
    await database.db.deleteFrom("timers").where("kind", "=", DRIVER_SILENCE).execute();
    // S4 0.14b: booking the missing checks is its own hourly job (it ran inside the hourly sweep before).
    await database.db.insertInto("timers").values({ kind: "book_silence_checks", ref_id: "all", due_at: clock.now }).onConflict((c) => c.columns(["kind", "ref_id"]).doNothing()).execute();
    await advance(31 * MIN);
    expect((await adminView(tripId)).driverSilentAlert?.kind).toBe("driver_silent");
  });
});
