import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { CADENCES, budgetPerMinute, cadenceRows } from "../../tools/loadtest/cadences.mjs";
import { checkPhoneLimits, PHONE_MAX } from "../../tools/loadtest/guards.mjs";
import { runVirtual, type PhoneReport } from "../../tools/loadtest/simulate.mjs";
import { parseZoneShare, phoneNumber, ZONES } from "../../tools/loadtest/zones.mjs";

/**
 * Global plan step 60 (T1 part 2): fake phones with the real apps' cadences, an open arrival model, real token refresh
 * and Tunis traffic (owner TN-9a). Proof: "G0 counts = request budgets within 10 %" — a short local run of the phone
 * code (simulated time, fake server) and each phone state's measured requests per minute against the cadence table.
 */
const ROOT = join(import.meta.dirname, "..", "..");
const TOOL = join(ROOT, "tools", "loadtest", "phone-load.mjs");
const sum = (o: Record<string, number>) => Object.values(o).reduce((s, x) => s + x, 0);

describe("cadence table (tools/loadtest/cadences.mjs)", () => {
  it("cites the app code for every number", () => {
    for (const row of cadenceRows()) expect(row.source, `${row.app}.${row.state} ${row.id}`).toMatch(/^(rider|driver) \S+\.dart:\d+/);
  });
  it("matches the audited request budgets (R09 §3.1, GM3 §3.2)", () => {
    const total = (app: "rider" | "driver", state: string) => Math.round(sum(budgetPerMinute(app, state)) * 100) / 100;
    expect({ home: total("rider", "home"), choose: total("rider", "choose"), finding: total("rider", "finding"), late: total("rider", "finding_late"), waiting: total("rider", "waiting"), receipt: total("rider", "receipt") }).toEqual({ home: 8.83, choose: 19.5, finding: 7.5, late: 11.5, waiting: 13.5, receipt: 7.5 });
    expect({ offline: total("driver", "offline_home"), idle: total("driver", "online_idle"), pickup: total("driver", "to_pickup"), trip: total("driver", "on_trip") }).toEqual({ offline: 7, idle: 14, pickup: 9.67, trip: 9.67 });
  });
});

describe("short local run: measured counts per phone state = cadence table ± 10 %", () => {
  let run: Awaited<ReturnType<typeof runVirtual>>;
  let report: PhoneReport;
  beforeAll(async () => {
    // Long stays, so each per-minute rate is a steady-state rate (a stay of T s is off by up to every / 2T).
    run = await runVirtual({ minutes: 60, riderArrivalsPerMinute: 6, drivers: 150, accessTtlSeconds: 120, riderDwell: { home: 600_000, choose: 120_000, receipt: 120_000 }, driverDwell: { toPickup: 900_000, atPickup: 120_000, onTrip: 900_000 } });
    report = run.report;
  }, 60_000);

  it("gates every state of both apps and every one is within 10 %", () => {
    const states = Object.keys(CADENCES.rider).length + Object.keys(CADENCES.driver).length;
    const out = Object.entries(report.states).flatMap(([name, s]) => Object.entries(s.endpoints).filter(([, e]) => !e.within).map(([id, e]) => `${name} ${id}: ${e.perMinute}/min vs ${e.budgetPerMinute} (${e.deviationPct} %)`));
    expect(out).toEqual([]);
    expect(report.gatedStates).toBe(states);
    expect(report.pass).toBe(true);
  });
  it("reacts to every rider_trip_changed with the app's 2 GETs", () => {
    const r = report.reactions["rider.rider_trip_changed"]!;
    expect(r.events).toBeGreaterThan(1000);
    expect(r.perEvent).toBe(2);
  });
  it("refreshes tokens like the apps: every phone refreshes, no request stays 401", () => {
    expect(report.extra["rider.refresh"]).toBeGreaterThan(0);
    expect(report.extra["driver.refresh"]).toBeGreaterThanOrEqual(150);
    expect(report.extra["rider.false401AfterRefresh"] ?? 0).toBe(0);
    expect(report.extra["driver.false401AfterRefresh"] ?? 0).toBe(0);
    expect(report.extra["rider.signedOut"] ?? 0).toBe(0);
    expect(report.status["401"] ?? 0).toBe(0);
  });
  it("lets riders arrive by a Poisson rate (open model), not a fixed loop", () => {
    expect(Math.abs(run.arrivals - run.expectedArrivals) / run.expectedArrivals).toBeLessThan(0.15);
    expect(report.extra["rider.booked"]).toBeGreaterThan(0);
    expect(report.extra["driver.completed"]).toBeGreaterThan(0);
    expect(report.extra["rider.abandonedSearch"]).toBeGreaterThan(0);
  });
  it("puts the TN-9a share of traffic in Tunis (TN-TC) next to Stockholm and Paris", () => {
    const riders = sum(run.zones.rider);
    expect(run.zones.rider["TN-TC"]! / riders).toBeCloseTo(0.2, 1);
    expect(run.zones.rider["FR-PC"]! / riders).toBeCloseTo(0.3, 1);
    expect(run.zones.rider["Z001"]! / riders).toBeCloseTo(0.5, 1);
    expect(run.zones.driver["TN-TC"]).toBe(30);
  });
});

describe("zones and guards of the phone tool", () => {
  it("knows Tunis: TN, TND, +216 test numbers", () => {
    expect(ZONES["TN-TC"]).toMatchObject({ country: "TN", currency: "TND" });
    expect(phoneNumber(ZONES["TN-TC"]!, "rider", 7)).toMatch(/^\+216\d{8}$/);
    expect(parseZoneShare("TN-TC=1")).toEqual([{ zoneId: "TN-TC", share: 1 }]);
    expect(() => parseZoneShare("XX-YY=1")).toThrow(/LOADTEST GUARD: --zone-share: unknown zone/);
  });
  it("needs an explicit, capped arrival rate and a bounded token life", () => {
    const ok = { drivers: 5, riders: 10, seconds: 60 };
    expect(checkPhoneLimits({ ...ok, riderArrivals: "12", accessTtl: "60" })).toEqual({ drivers: 5, riders: 10, seconds: 60, riderArrivalsPerMinute: 12, accessTtlSeconds: 60 });
    expect(() => checkPhoneLimits({ ...ok })).toThrow(/--rider-arrivals must be a positive number/);
    expect(() => checkPhoneLimits({ ...ok, riderArrivals: PHONE_MAX.riderArrivalsPerMinute + 1 })).toThrow(/hard max/);
    expect(() => checkPhoneLimits({ ...ok, riderArrivals: 5, accessTtl: 5 })).toThrow(/--access-ttl/);
    expect(() => checkPhoneLimits({ drivers: 5, seconds: 60, riderArrivals: 5 })).toThrow(/--riders is required/);
  });
  it("phone-load.mjs refuses a non-local database before touching anything (exit 2)", () => {
    const r = spawnSync(process.execPath, [TOOL, "--db", "movera_loadtest_phones", "--drivers", "5", "--riders", "10", "--seconds", "5", "--rider-arrivals", "5"], { env: { PATH: process.env.PATH, HOME: process.env.HOME, LOADTEST_ADMIN_URL: "postgres://movera:secret@db.example.com/movera" }, encoding: "utf8", timeout: 30_000 });
    expect(r.status).toBe(2);
    expect(`${r.stdout}${r.stderr}`).toMatch(/LOADTEST GUARD: refusing host "db.example.com"/);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/secret/);
  });
});
