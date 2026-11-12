import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { readEnv } from "../../src/env.js";
import { askRideCheck } from "../../src/safety/rideCheckServer.js";
import { rideCheckSettings } from "../../src/trips/onTripSettings.js";
import { bookAndAccept, Driver, fakeOsrm, PLACES, Sim, type Admin, type Rider } from "./harness.js";

/**
 * B1.22 supervisor N1: the ride-check endpoint is outside the write limit for signed-in callers, so the app's OWN
 * checks (new client-chosen checkIds) are capped per trip and side at RIDE_CHECK_APP_MAX_PER_TRIP (default 30): over
 * the cap no new row and no no-answer timer (the general timer lanes SOS escalation uses), the answer is the newest app
 * check (200, the same receipt as today, so the apps keep working). Answers to an existing check, I need help, and the
 * server's own checks (origin server) are never capped.
 */

const CAP = 30;
let sim: Sim;
let osrm: Awaited<ReturnType<typeof fakeOsrm>>;
let rider: Rider;
let a: Driver;
let dispatcher: Admin;

const GPS = { lat: 59.3331, lng: 18.0651, accuracyM: 8, at: "2026-10-27T10:00:30Z" };

beforeAll(async () => {
  osrm = await fakeOsrm({ distance: 8000, duration: 1080 });
  sim = await Sim.start({ osrmUrl: osrm.url });
  rider = await sim.rider(0);
  a = await sim.driver(1, PLACES.nearSergels);
  dispatcher = await sim.admin("dispatcher", ["Z001"]);
});
afterAll(async () => {
  await sim.stop();
  await osrm.close();
});
afterEach(async () => {
  const active = await rider.get("/rider/trips/active");
  const tripId = active.status === 200 ? (active.body["tripId"] as string | undefined) : undefined;
  if (tripId) {
    const version = (await dispatcher.get(`/admin/trips/${tripId}`)).body["version"];
    await dispatcher.post(`/admin/trips/${tripId}/cancel`, { expectedVersion: version, reasonCode: "admin_other", note: "clean-up" });
  }
});

const check = (who: Rider | Driver, tripId: string, checkId: string, answer?: "ok" | "need_help") =>
  who.post(`/${who instanceof Driver ? "driver" : "rider"}/trips/${tripId}/ride-check`, { checkId, trigger: "long_stop", at: sim.clock.now.toISOString(), ...(answer ? { answer } : {}), position: GPS });
const rows = async (tripId: string, side: "rider" | "driver", origin: "app" | "server") =>
  Number((await sim.db.selectFrom("ride_checks").select(sql<number>`count(*)`.as("n")).where("trip_id", "=", tripId).where("side", "=", side).where("origin", "=", origin).executeTakeFirstOrThrow()).n);
const timers = async (tripId: string, side: "rider" | "driver", prefix = "") =>
  Number((await sim.db.selectFrom("timers").select(sql<number>`count(*)`.as("n")).where("kind", "=", "ride_check_no_answer").where("ref_id", "like", `${tripId}|${side}|${prefix}%`).executeTakeFirstOrThrow()).n);

describe("B1.22 N1: the app's own ride checks are capped per trip and side", () => {
  it("200 different checkIds on one trip and side make at most 30 rows and 30 timers; over the cap the newest app check answers (200)", async () => {
    const { tripId } = await bookAndAccept(sim, rider, a);
    let last: Record<string, unknown> | undefined;
    for (let n = 0; n < 200; n++) {
      const res = await check(rider, tripId, `flood-${String(n).padStart(3, "0")}`);
      expect(res.status).toBe(200);
      last = res.body;
    }
    expect(await rows(tripId, "rider", "app")).toBe(CAP);
    expect(await timers(tripId, "rider")).toBe(CAP);
    // The newest app check that was kept (the 30th), the same receipt shape as today.
    expect(last).toMatchObject({ checkId: `flood-${String(CAP - 1).padStart(3, "0")}`, tripId, receivedAt: expect.any(String) });
    // The other side has its own cap: the driver's checks still go in.
    expect((await check(a, tripId, "d-1")).body).toMatchObject({ checkId: "d-1" });
    expect(await rows(tripId, "driver", "app")).toBe(1);

    // Answers to an existing check are never capped: ok is saved and its timer stops.
    const ok = await check(rider, tripId, "flood-005", "ok");
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ checkId: "flood-005", answer: "ok" });
    expect(await timers(tripId, "rider", "flood-005")).toBe(0);
    // I need help is never capped, even on a new checkId over the cap: the alarm case opens.
    const help = await check(rider, tripId, "flood-help", "need_help");
    expect(help.status).toBe(200);
    expect(help.body).toMatchObject({ checkId: "flood-help", answer: "need_help", incidentId: expect.stringMatching(/^inc_/) });
    expect(await timers(tripId, "rider")).toBe(CAP - 1);

    // The server's own scan check is not counted and not blocked: rows and timers for both sides, and it can be answered.
    const server = await sim.db.transaction().execute(async (trx) => {
      const trip = await trx.selectFrom("trips").selectAll().where("trip_id", "=", tripId).forUpdate().executeTakeFirstOrThrow();
      return askRideCheck(trx, trip, "long_stop", await rideCheckSettings(trx, trip.zone_id), sim.clock.now, GPS);
    });
    expect(await rows(tripId, "rider", "server")).toBe(1);
    expect(await rows(tripId, "driver", "server")).toBe(1);
    expect(await timers(tripId, "rider", server.checkId)).toBe(1);
    const answered = await check(rider, tripId, server.checkId, "ok");
    expect(answered.body).toMatchObject({ checkId: server.checkId, answer: "ok" });
    expect(await timers(tripId, "rider", server.checkId)).toBe(0);
    expect(await rows(tripId, "rider", "app")).toBe(CAP);
  });

  it("RIDE_CHECK_APP_MAX_PER_TRIP: default 30, range 1-500", () => {
    const base = { MOVERA_ENV: "development" };
    expect(readEnv(base).RIDE_CHECK_APP_MAX_PER_TRIP).toBe(30);
    expect(readEnv({ ...base, RIDE_CHECK_APP_MAX_PER_TRIP: "500" }).RIDE_CHECK_APP_MAX_PER_TRIP).toBe(500);
    for (const bad of ["0", "501", "x"]) expect(() => readEnv({ ...base, RIDE_CHECK_APP_MAX_PER_TRIP: bad })).toThrow(/RIDE_CHECK_APP_MAX_PER_TRIP/);
  });

  it("the setting is used: a cap of 2 keeps 2 app checks on the driver's side", async () => {
    const small = await Sim.start({ osrmUrl: osrm.url, env: { RIDE_CHECK_APP_MAX_PER_TRIP: "2" } });
    try {
      const r = await small.rider(0);
      const d = await small.driver(1, PLACES.nearSergels);
      const { tripId } = await bookAndAccept(small, r, d);
      const post = (id: string) => d.post(`/driver/trips/${tripId}/ride-check`, { checkId: id, trigger: "off_route", at: small.clock.now.toISOString() });
      for (const id of ["s-1", "s-2", "s-3", "s-4"]) expect((await post(id)).status).toBe(200);
      const kept = await small.db.selectFrom("ride_checks").select("check_id").where("trip_id", "=", tripId).where("side", "=", "driver").orderBy("check_id").execute();
      expect(kept.map((k) => k.check_id)).toEqual(["s-1", "s-2"]);
      expect((await post("s-4")).body).toMatchObject({ checkId: "s-2" });
    } finally {
      await small.stop();
    }
  });
});
