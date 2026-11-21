import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { budgetPerMinute, CADENCE_TABLES, CADENCES, cadenceRows, cadenceTable, nearAirport } from "../../tools/loadtest/cadences.mjs";
import { runVirtual, type PhoneReport } from "../../tools/loadtest/simulate.mjs";

/**
 * S4e (Rules audits/impact/stress-s4b-2026-11-20.md "S4e"): the load test with the REAL app cadences of the load-cut
 * branches (rider #677 ...-loadcut-r, driver #654 ...-loadcut-d), chosen with LOADTEST_CADENCE=real. The S4e session
 * ran it with local tool changes only; this makes it repeatable. The old table stays the default (old runs comparable).
 */
const real = cadenceTable("real");
const entries = (app: "rider" | "driver", state: string) => real.cadences[app][state] ?? [];
const find = (app: "rider" | "driver", state: string, id: string) => entries(app, state).find((e) => e.id === id);
const total = (app: "rider" | "driver", state: string) => Math.round(Object.values(budgetPerMinute(app, state, real)).reduce((s, x) => s + x, 0) * 100) / 100;

describe("LOADTEST_CADENCE picks the table", () => {
  it("defaults to the old table, so old runs stay comparable", () => {
    expect(cadenceTable(undefined).name).toBe("old");
    expect(cadenceTable("").name).toBe("old");
    expect(cadenceTable("old").cadences).toBe(CADENCES);
    expect(cadenceTable("real")).toBe(CADENCE_TABLES.real);
  });
  it("refuses an unknown name", () => {
    expect(() => cadenceTable("new")).toThrow(/LOADTEST GUARD: LOADTEST_CADENCE/);
  });
  it("phone-load.mjs reads it from the environment and hands it to the phones and the counter", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "..", "tools", "loadtest", "phone-load.mjs"), "utf8");
    expect(src).toContain("cadenceTable(process.env.LOADTEST_CADENCE)");
    expect(src).toMatch(/new Counter\(CADENCE\)/);
    expect(src).toMatch(/cadence: CADENCE/);
    expect(src).toContain("cadenceRows(CADENCE)");
  });
});

describe("the real table has the S4e numbers", () => {
  it("rider GET /rider/trips/active every 60 s while the config stream is up", () => {
    for (const state of ["home", "choose"]) expect(find("rider", state, "GET /rider/trips/active")).toMatchObject({ every: 60, timer: "rider_trip_watch" });
  });
  it("driver home badges = ONE GET /driver/home-badges every 60 s (not 4 GETs)", () => {
    for (const state of ["offline_home", "online_idle"]) {
      const badges = entries("driver", state).filter((e) => e.id.includes("badges"));
      expect(badges).toHaveLength(1);
      expect(badges[0]).toMatchObject({ id: "GET /driver/home-badges", method: "GET", every: 60 });
      expect(badges[0]!.batch).toBeUndefined();
      expect(budgetPerMinute("driver", state, real)["GET /driver/home-badges"]).toBe(1);
    }
    // none of the four old reads is left on a timer
    const paths = Object.values(real.cadences.driver).flat().flatMap((e) => e.batch ?? [e.path?.({ lat: 0, lng: 0, toLat: 0, toLng: 0, tripId: "t" })]);
    for (const old of ["/driver/profile", "/notifications", "/driver/reminders", "/driver/onboarding/settings"]) expect(paths).not.toContain(old);
  });
  it("driver GPS POST /driver/location stays every 10 s in every online state", () => {
    for (const state of ["online_idle", "to_pickup", "at_pickup", "on_trip"]) expect(find("driver", state, "POST /driver/location")).toMatchObject({ every: 10, method: "POST" });
    expect(find("driver", "offline_home", "POST /driver/location")).toBeUndefined();
  });
  it("has NO rider messages poll", () => {
    for (const [state, list] of Object.entries(real.cadences.rider)) for (const e of list) expect(`${state} ${e.id}`).not.toMatch(/messages/);
  });
  it("has no trip poll while the streams are up (only the search check after 3 min)", () => {
    const tripPolls = Object.values(real.cadences.rider).flat().filter((e) => e.id.startsWith("GET /trips/{id}"));
    expect(tripPolls.map((e) => e.id)).toEqual(["GET /trips/{id} (search check)"]);
    expect(find("rider", "finding_late", "GET /trips/{id} (search check)")).toMatchObject({ every: 15 });
    expect(find("rider", "finding", "GET /trips/{id} (search check)")).toBeUndefined();
  });
  it("keeps the other app timers: presence 45 s, nearby cars 5 s (server refreshSeconds, 5-30), surge 60 s, route 90 s", () => {
    expect(find("rider", "home", "GET /rider/nearby-vehicles (presence)")).toMatchObject({ every: 45, immediate: true });
    expect(find("rider", "choose", "GET /rider/nearby-vehicles (choose)")).toMatchObject({ every: 5, dynamic: { field: "refreshSeconds", min: 5, max: 30 } });
    expect(find("driver", "online_idle", "GET /driver/surge-map")).toMatchObject({ every: 60 });
    expect(find("driver", "to_pickup", "GET /routes/driving (to pickup)")).toMatchObject({ every: 90 });
    expect(find("driver", "on_trip", "GET /routes/driving (to drop-off)")).toMatchObject({ every: 90 });
  });
  it("request budgets per phone-minute", () => {
    expect({ home: total("rider", "home"), choose: total("rider", "choose"), finding: total("rider", "finding"), late: total("rider", "finding_late"), waiting: total("rider", "waiting"), trip: total("rider", "in_trip"), receipt: total("rider", "receipt") }).toEqual({ home: 2.33, choose: 13, finding: 0, late: 4, waiting: 0, trip: 0, receipt: 0 });
    expect({ offline: total("driver", "offline_home"), idle: total("driver", "online_idle"), pickup: total("driver", "to_pickup"), at: total("driver", "at_pickup"), trip: total("driver", "on_trip") }).toEqual({ offline: 1, idle: 8, pickup: 6.67, at: 6.67, trip: 6.67 });
  });
  it("cites the load-cut app code (file:line) for every number", () => {
    const rows = cadenceRows(real);
    expect(rows.length).toBeGreaterThan(10);
    for (const row of rows) expect(row.source, `${row.app}.${row.state} ${row.id}`).toMatch(/^(rider|driver) \S+\.dart:\d+/);
    for (const rule of [...Object.values(real.reactions.rider), ...Object.values(real.reactions.driver)]) expect(rule.source).toMatch(/\.dart:\d+/);
  });
});

describe("the airport poll: only for drivers online near an airport, 60 s fallback + the airport_queue_changed hint", () => {
  const airport = (state: string) => find("driver", state, "GET /driver/airport-queue");
  const CDG = { lat: 49.01, lng: 2.55 };
  const PARIS = { lat: 48.8566, lng: 2.3522 };
  it("is a 60 s timer (immediate, as startPolling) behind a condition in the online states, none offline", () => {
    for (const state of ["online_idle", "to_pickup", "at_pickup", "on_trip"]) expect(airport(state)).toMatchObject({ every: 60, immediate: true, only: "online_near_airport" });
    expect(airport("offline_home")).toBeUndefined();
  });
  it("asks only while the driver is online and at / near (about 2 km) an airport zone", () => {
    const when = airport("online_idle")!.when!;
    expect(when({ app: "driver", state: "online_idle", pos: CDG })).toBe(true);
    expect(when({ app: "driver", state: "online_idle", pos: { lat: 48.985 - 0.015, lng: 2.55 } })).toBe(true); // inside the 0.02° margin
    expect(when({ app: "driver", state: "online_idle", pos: PARIS })).toBe(false);
    expect(when({ app: "driver", state: "offline_home", pos: CDG })).toBe(false);
    expect(nearAirport(PARIS)).toBe(false);
    expect(nearAirport({ lat: 59.649, lng: 17.929 })).toBe(true); // Arlanda
  });
  it("is not in the per-minute budget (a condition, not every phone)", () => {
    expect(budgetPerMinute("driver", "online_idle", real)["GET /driver/airport-queue"]).toBeUndefined();
  });
  it("reads again on airport_queue_changed, at most once per 5 s, under the same condition", () => {
    const rule = real.reactions.driver["airport_queue_changed"]!;
    expect(rule).toMatchObject({ perEvent: 1, minGapSeconds: 5, only: "online_near_airport" });
  });
});

describe("short simulated run with the real table: measured counts per state = real table ± 10 %", () => {
  let report: PhoneReport;
  beforeAll(async () => {
    const run = await runVirtual({ cadence: "real", minutes: 60, riderArrivalsPerMinute: 6, drivers: 150, accessTtlSeconds: 120, riderDwell: { home: 600_000, choose: 120_000, receipt: 120_000 }, driverDwell: { toPickup: 900_000, atPickup: 120_000, onTrip: 900_000 } });
    report = run.report;
  }, 60_000);
  it("every gated state is within 10 %", () => {
    const out = Object.entries(report.states).flatMap(([name, s]) => Object.entries(s.endpoints).filter(([, e]) => !e.within).map(([id, e]) => `${name} ${id}: ${e.perMinute}/min vs ${e.budgetPerMinute} (${e.deviationPct} %)`));
    expect(out).toEqual([]);
    expect(report.pass).toBe(true);
    expect(report.states["driver.online_idle"]!.endpoints["GET /driver/home-badges"]!.perMinute).toBeCloseTo(1, 0);
  });
  it("sends no messages poll, no airport poll (no phone is near an airport), no old badge reads", () => {
    const ids = [...Object.values(report.states).flatMap((s) => Object.entries(s.endpoints).filter(([, e]) => e.count > 0).map(([id]) => id)), ...Object.values(report.other).flatMap((o) => Object.keys(o))];
    expect(ids.filter((id) => /messages|airport|Home badges \(4\)/.test(id))).toEqual([]);
  });
  it("reacts to rider_trip_changed like the app: list + active trip on Home, only the list on a ride screen", () => {
    const r = report.reactions["rider.rider_trip_changed"]!;
    expect(r.events).toBeGreaterThan(1000);
    expect(r.perEvent).toBeGreaterThanOrEqual(1);
    expect(r.perEvent).toBeLessThan(1.5);
  });
});
