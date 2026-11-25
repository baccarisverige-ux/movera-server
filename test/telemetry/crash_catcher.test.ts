import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { readEnv } from "../../src/env.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";

/**
 * Contract v0.18.158 (contract.json#crashCatcher; owner 2026-11-24 "Add to admin all kind of crash"): the new kinds
 * dart_error / native_crash / freeze and fields, GET /admin/errors?kind=, GET /admin/errors/{errorId}/reports and the
 * per-device limit of stored crash reports. Rule 36: fails on main — kind native_crash is 400 there (the contract
 * copy lists crash | error), the error_groups kind check refuses it, there is no ?kind= and no reports route.
 */
let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-11-24T10:00:00Z") };
const advance = (seconds: number) => (clock.now = new Date(clock.now.getTime() + seconds * 1000));
const SECRET = "test-secret-".padEnd(48, "x");
let ipCounter = 0;
const freshIp = () => `10.9.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;
let superAdmin: { headers: Record<string, string> };

beforeAll(async () => {
  database = await freshDatabase();
  app = await buildApp({ env: readEnv({ MOVERA_ENV: "staging", DATABASE_URL: database.url, JWT_SECRET: SECRET }), logger: false, db: database.db, clock: () => clock.now });
  superAdmin = await adminSession(app, database.db, "super", { now: clock.now });
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

const crash = (payload: Record<string, unknown>, ip = freshIp()) =>
  app.inject({ method: "POST", url: "/api/v1/telemetry/crashes", remoteAddress: ip, headers: { "content-type": "application/json" }, payload });
type Group = { id: string; kind: string; message: string; count: number; devices: number };
const groups = async (query = "") => ((await app.inject({ method: "GET", url: `/api/v1/admin/errors${query}`, headers: superAdmin.headers })).json() as { items: Group[] }).items;
const reports = (id: string, query = "", headers = superAdmin.headers) => app.inject({ method: "GET", url: `/api/v1/admin/errors/${id}/reports${query}`, headers });

const crumbs = [
  { at: "2026-11-24T09:59:50Z", type: "route", message: "/home" },
  { at: "2026-11-24T09:59:55Z", type: "network", message: "GET /rider/trips/:id 503 call +46 70 174 06 08" },
  { at: "2026-11-24T09:59:58Z", type: "lifecycle", message: "paused" },
];

describe("crash catcher kinds and fields (v0.18.158)", () => {
  it("takes dart_error, native_crash and freeze with the new fields; the group carries the kind", async () => {
    for (const kind of ["dart_error", "native_crash", "freeze"]) {
      const res = await crash({
        error: `${kind} sample`,
        stack: "#0      Home.build (package:movera_rider/home.dart:10:5)",
        app: "rider",
        platform: "ios",
        appVersion: "1.0.0",
        build: "7",
        kind,
        osVersion: "iOS 17.1",
        deviceModel: "iPhone15,2",
        tripId: "trp_01JB2Z3Y4X5W6V7T8S9R0QPNMK",
        zoneId: "Z001",
        breadcrumbs: crumbs,
        ...(kind === "native_crash" ? { nativeReason: { name: "NSInvalidArgumentException", reason: "invalid GOOGLE_APP_ID" } } : {}),
        ...(kind === "freeze" ? { freezeMs: 7200 } : {}),
      });
      expect(res.statusCode, kind).toBe(202);
    }
    const all = await groups("?app=rider&platform=ios");
    for (const kind of ["dart_error", "native_crash", "freeze"]) expect(all.find((g) => g.message === `${kind} sample`)?.kind, kind).toBe(kind);
  });

  it("refuses an unknown kind, too many breadcrumbs or a breadcrumb of an unknown type", async () => {
    expect((await crash({ error: "x", app: "rider", platform: "ios", kind: "panic" })).statusCode).toBe(400);
    const many = Array.from({ length: 31 }, (_, i) => ({ at: "2026-11-24T09:59:50Z", type: "route", message: `/r${i}` }));
    expect((await crash({ error: "x", app: "rider", platform: "ios", kind: "dart_error", breadcrumbs: many })).statusCode).toBe(400);
    expect((await crash({ error: "x", app: "rider", platform: "ios", kind: "dart_error", breadcrumbs: [{ at: "2026-11-24T09:59:50Z", type: "tap", message: "x" }] })).statusCode).toBe(400);
  });
});

describe("GET /admin/errors?kind=", () => {
  it("filters by kind; a bad kind is 400", async () => {
    const natives = await groups("?kind=native_crash");
    expect(natives.length).toBeGreaterThan(0);
    expect(natives.every((g) => g.kind === "native_crash")).toBe(true);
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/errors?kind=panic", headers: superAdmin.headers })).statusCode).toBe(400);
  });
});

describe("GET /admin/errors/{errorId}/reports", () => {
  it("returns the kept reports newest first with stack, breadcrumbs, device, OS and native reason, scrubbed", async () => {
    const group = (await groups("?kind=native_crash"))[0]!;
    advance(60);
    await crash({ error: "native_crash sample", stack: "#0      Home.build (package:movera_rider/home.dart:10:5)", app: "rider", platform: "ios", appVersion: "1.0.1", build: "8", kind: "native_crash", nativeReason: { name: "SIGABRT", reason: "" }, breadcrumbs: [] });
    const res = await reports(group.id);
    expect(res.statusCode).toBe(200);
    const items = (res.json() as { items: Record<string, unknown>[] }).items;
    expect(items.length).toBe(2);
    expect(items[0]).toMatchObject({ kind: "native_crash", appVersion: "1.0.1", build: "8", nativeReason: { name: "SIGABRT" }, breadcrumbs: [] });
    expect(items[1]).toMatchObject({
      kind: "native_crash",
      appVersion: "1.0.0",
      platform: "ios",
      osVersion: "iOS 17.1",
      deviceModel: "iPhone15,2",
      zoneId: "Z001",
      tripId: "trp_01JB2Z3Y4X5W6V7T8S9R0QPNMK",
      message: "native_crash sample",
      nativeReason: { name: "NSInvalidArgumentException", reason: "invalid GOOGLE_APP_ID" },
    });
    expect(String(items[1]!["stack"])).toContain("Home.build");
    expect((items[1]!["breadcrumbs"] as unknown[]).length).toBe(3);
    expect(JSON.stringify(items)).not.toMatch(/174 06 08/);
    expect(Date.parse(String(items[0]!["at"]))).toBeGreaterThan(Date.parse(String(items[1]!["at"])));
    expect(((await reports(group.id, "?limit=1")).json() as { items: unknown[] }).items.length).toBe(1);
  });

  it("404 for an unknown group, 400 for a bad limit, 401 without a session; every admin role may read", async () => {
    expect((await reports("err_missing")).statusCode).toBe(404);
    const group = (await groups())[0]!;
    expect((await reports(group.id, "?limit=51")).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `/api/v1/admin/errors/${group.id}/reports` })).statusCode).toBe(401);
    const support = await adminSession(app, database.db, "support", { now: clock.now });
    expect((await reports(group.id, "", support.headers)).statusCode).toBe(200);
  });
});

describe("per-device limit (crashCatcher.server.perDevicePerMinute)", () => {
  it("stores at most 10 crash reports per device and minute; over it 202 and nothing stored; the next minute stores again", async () => {
    advance(120);
    const ip = freshIp();
    for (let n = 0; n < 12; n++) {
      const res = await crash({ error: `Burst ${n}`, app: "driver", platform: "android", kind: "dart_error" }, ip);
      expect(res.statusCode).toBe(202);
    }
    const burst = (await groups("?app=driver&platform=android")).filter((g) => g.message.startsWith("Burst"));
    expect(burst.reduce((sum, g) => sum + g.count, 0)).toBe(10);
    advance(61);
    await crash({ error: "Burst 99", app: "driver", platform: "android", kind: "dart_error" }, ip);
    const after = (await groups("?app=driver&platform=android")).filter((g) => g.message.startsWith("Burst"));
    expect(after.reduce((sum, g) => sum + g.count, 0)).toBe(11);
  });
});
