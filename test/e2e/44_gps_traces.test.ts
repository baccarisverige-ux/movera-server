import { readdirSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { haversineKm } from "../../src/maps/routing.js";
import { prepareTestWeek } from "../../src/testWeek.js";
import { driven } from "../../src/trips/ride/settings.js";
import { bookAndAccept, drive, type Json, Sim } from "./harness.js";

/**
 * Step 72 (T13, global plan V35.24, "tests that passed and failed live"): every other test drives with perfect fixes
 * (accuracy 5, in order, one per call). These feed a recorded-style trace (test/fixtures/traces/*.json, made by
 * generate.mjs there: jitter, 30–90 s gaps, a tunnel, a backwards jump, 100 m+ accuracy, duplicate timestamps,
 * out-of-order and late batches, a parked driver drifting) through the real server, batch by batch as the driver app
 * sends them (POST /driver/location), and check the numbers the rider and driver see: the driven km and fare
 * (trips/ride/settings.ts kmOnBoard + driven), the ETA (trips/eta.ts), the near-drop-off step (trips/ride/steps.ts
 * maybeNearDropoff) and the trip's path (trips/path.ts). One test per trace file.
 */

type TraceFix = { t: number; lat: number; lng: number; accuracy: number; speedMps?: number; heading: number; truthM: number; defect?: string };
type Trace = {
  name: string; zoneId: string; roadMeters: number; boardT: number;
  pickup: { address: string; lat: number; lng: number }; dropoff: { address: string; lat: number; lng: number };
  road: Array<{ lat: number; lng: number }>;
  fixes: TraceFix[]; batches: Array<{ phase: "waiting" | "on_board"; sendT: number; fixes: number[] }>;
};

const trace = (name: string): Trace => JSON.parse(readFileSync(new URL(`../fixtures/traces/${name}.json`, import.meta.url), "utf8")) as Trace;

/** Where the car really was `m` metres along the trace's road (the fixes' `truthM`). */
function truthAt(tr: Trace, m: number): { lat: number; lng: number } {
  let left = m;
  for (let i = 1; i < tr.road.length; i++) {
    const a = tr.road[i - 1]!;
    const b = tr.road[i]!;
    const seg = haversineKm(a, b) * 1000;
    if (left <= seg) return { lat: a.lat + ((b.lat - a.lat) * left) / seg, lng: a.lng + ((b.lng - a.lng) * left) / seg };
    left -= seg;
  }
  return tr.road[tr.road.length - 1]!;
}

/** What one trace did on the server. */
type Run = {
  km: number[]; fares: number[]; etas: Json[]; statuses: string[]; nearDropoffAt: { remaining: number } | null;
  transitionsToApproaching: number; finalKm: number; pathMeters: number; pathSource: string; completed: Json;
};

let sim: Sim;

beforeAll(async () => {
  sim = await Sim.start();
  // Owner order TN-9: Tunis in every test. Grand Tunis starts closed on a fresh server: open it, then prepare the
  // test week again so the test drivers work it and it gets the sample settings (as staging did, 2026-11-10).
  const owner = await sim.owner();
  const tn = ((await owner.get("/admin/zones")).body["zones"] as Json[]).find((z) => z["zoneId"] === "TN-TC")!;
  expect((await owner.post("/admin/zones/TN-TC/open", { expectedVersion: tn["version"] })).status).toBe(200);
  await prepareTestWeek(sim.db, sim.env, { info: () => undefined }, { now: sim.clock.now });
});
afterAll(async () => {
  await sim?.stop();
});

/** Each trace has its own rider and driver (index), so one failing trace leaves no live trip for the next. */
async function run(tr: Trace, index: 0 | 1 | 2): Promise<Run> {
  const rider = await sim.rider(index);
  const driver = await sim.driver(index, tr.pickup);
  sim.driverApps.delete(driver); // only the trace's fixes, no perfect heartbeat fixes
  const { tripId } = await bookAndAccept(sim, rider, driver, { pickup: tr.pickup, dropoff: tr.dropoff });
  await drive(driver, tripId, "arrived", tr.pickup);
  const base = sim.clock.now.getTime() + 5_000;
  const at = (t: number) => new Date(base + t * 1000);
  const send = async (batch: Trace["batches"][number]) => {
    sim.clock.now = at(batch.sendT);
    const fixes = batch.fixes.map((i) => {
      const f = tr.fixes[i]!;
      return { lat: f.lat, lng: f.lng, accuracy: f.accuracy, heading: f.heading, ...(f.speedMps !== undefined ? { speedMps: f.speedMps } : {}), measuredAt: at(f.t).toISOString() };
    });
    const res = await driver.post("/driver/location", { fixes });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await sim.tick();
  };
  for (const b of tr.batches.filter((x) => x.phase === "waiting")) await send(b);
  sim.clock.now = at(tr.boardT);
  await drive(driver, tripId, "in_trip", tr.pickup);
  const out: Run = { km: [], fares: [], etas: [], statuses: [], nearDropoffAt: null, transitionsToApproaching: 0, finalKm: 0, pathMeters: 0, pathSource: "", completed: {} };
  for (const b of tr.batches.filter((x) => x.phase === "on_board")) {
    await send(b);
    const row = await sim.db.selectFrom("trips").selectAll().where("trip_id", "=", tripId).executeTakeFirstOrThrow();
    const measured = await driven(sim.db, row, sim.clock.now);
    out.km.push(measured.km);
    out.fares.push(measured.fare.total.amountMinor);
    const view = await rider.trip(tripId);
    if (view["eta"]) out.etas.push(view["eta"] as Json);
    out.statuses.push(view["status"]);
    if (view["status"] === "approaching_dropoff" && out.nearDropoffAt === null) {
      const newest = b.fixes.map((i) => tr.fixes[i]!).reduce((a, c) => (c.t > a.t ? c : a));
      // Straight line from where the car really was to the drop-off (the 500 m rule is a straight line too).
      out.nearDropoffAt = { remaining: haversineKm(truthAt(tr, newest.truthM), tr.dropoff) * 1000 };
    }
  }
  const row = await sim.db.selectFrom("trips").selectAll().where("trip_id", "=", tripId).executeTakeFirstOrThrow();
  out.finalKm = (await driven(sim.db, row, sim.clock.now)).km;
  const events = await sim.db.selectFrom("trip_events").select(["kind", "projection"]).where("trip_id", "=", tripId).where("kind", "=", "trip_projection").orderBy("sequence").execute();
  let last = "";
  for (const e of events) {
    const status = String((e.projection as Json | null)?.["status"] ?? "");
    if (status === "approaching_dropoff" && last !== "approaching_dropoff") out.transitionsToApproaching++;
    if (status) last = status;
  }
  const preview = await driver.get(`/driver/trips/${tripId}/complete-preview`);
  expect(preview.status, JSON.stringify(preview.body)).toBe(200);
  const done = await driver.command(tripId, "complete", { previewId: preview.body["previewId"], cashCollected: preview.body["cashDue"] });
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  out.completed = done.body;
  const path = await rider.get(`/trips/${tripId}/path`);
  expect(path.status).toBe(200);
  out.pathSource = path.body["source"];
  const pts = path.body["points"] as Array<{ lat: number; lng: number }>;
  out.pathMeters = pts.slice(1).reduce((s, p, i) => s + haversineKm(pts[i]!, p) * 1000, 0);
  return out;
}

/** The checks every trace must pass: what a rider is charged and shown must be sane on real-world GPS. */
function expectSane(tr: Trace, r: Run) {
  const roadKm = tr.roadMeters / 1000;
  // No negative distance, and the driven km never goes down as more fixes come in (late / out-of-order batches).
  expect(Math.min(...r.km)).toBeGreaterThanOrEqual(0);
  r.km.forEach((km, i) => expect(km, `km after batch ${i}`).toBeGreaterThanOrEqual(r.km[i - 1] ?? 0));
  // The fare never goes down while driving.
  r.fares.forEach((f, i) => expect(f, `fare after batch ${i}`).toBeGreaterThanOrEqual(r.fares[i - 1] ?? 0));
  // ETA: never negative, never NaN.
  for (const eta of r.etas) {
    expect(Number.isFinite(eta["etaSeconds"])).toBe(true);
    expect(eta["etaSeconds"]).toBeGreaterThanOrEqual(0);
    expect(eta["distanceMeters"]).toBeGreaterThanOrEqual(0);
  }
  // Arrival near the drop-off is detected once, and only when the car is really near (500 m rule + 50 m noise).
  expect(r.transitionsToApproaching).toBe(1);
  expect(r.nearDropoffAt).not.toBeNull();
  expect(r.nearDropoffAt!.remaining).toBeLessThanOrEqual(550);
  expect(r.completed["status"]).toBe("completed");
  // The trip's map line is the driven one.
  expect(r.pathSource).toBe("driven");
  // Not under-credited: tunnel and gaps are bridged by straight lines, close to the road.
  expect(r.finalKm).toBeGreaterThanOrEqual(roadKm * 0.85);
}

/** No teleport credit: the km charged and the path drawn are at most 10 % over the real road length. */
function expectNoTeleportCredit(tr: Trace, r: Run) {
  const roadKm = tr.roadMeters / 1000;
  expect(r.finalKm, `driven km vs road ${roadKm} km`).toBeLessThanOrEqual(roadKm * 1.1);
  expect(r.pathMeters / 1000, `path km vs road ${roadKm} km`).toBeLessThanOrEqual(roadKm * 1.1);
}

/**
 * One describe per trace file: the trace runs once (beforeAll) and both checks read that run.
 * REAL BUG kept as it.fails (proof for later, behaviour not changed here): the driven km over-credits real-world GPS by
 * more than 10 % in Paris (4.765 km on a 4.290 km road) and Tunis (9.085 km on 8.171 km). Cause: kmOnBoard,
 * src/trips/ride/settings.ts:252-269 (and the same filter in cleanTrace, src/trips/path.ts:19-21 + 28-40), takes every
 * fix with accuracy <= 50 m and counts every step >= 25 m: 30–40 m urban-canyon noise (accuracy 35–45 m) and the drift
 * of a car standing at a red light zigzag into paid km. (The backwards jump is caught by the 150 km/h rule.)
 */
function traceSuite(name: string, index: 0 | 1 | 2, overCredits: boolean) {
  describe(name, () => {
    const tr = trace(name);
    let r: Run;
    beforeAll(async () => {
      r = await run(tr, index);
    }, 180_000);
    it("sane on real-world GPS: km >= 0 and never down, fare never down, ETA >= 0, near drop-off once and only when near, driven path", () => {
      expectSane(tr, r);
    });
    (overCredits ? it.fails : it)(`no teleport credit: driven km and path <= road x 1.10${overCredits ? " (FAILS today: src/trips/ride/settings.ts:252-269, src/trips/path.ts:28-40)" : ""}`, () => {
      expectNoTeleportCredit(tr, r);
    });
  });
}

const TRACES = ["stockholm_sergels_medborgar", "paris_chatelet_eiffel", "tunis_bourguiba_carthage"];

describe("recorded-style GPS traces through the server (T13)", () => {
  it("every trace file has exactly one suite below (fixtures used by one test each)", () => {
    const files = readdirSync(new URL("../fixtures/traces/", import.meta.url)).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
    expect(files.sort()).toEqual([...TRACES].sort());
  });
  traceSuite("stockholm_sergels_medborgar", 0, false);
  traceSuite("paris_chatelet_eiffel", 1, true);
  // Owner order TN-9: Avenue Habib Bourguiba → Aéroport Tunis-Carthage.
  traceSuite("tunis_bourguiba_carthage", 2, true);
});
