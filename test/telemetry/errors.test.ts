import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { contract } from "../../src/contract/contract.js";
import { readEnv } from "../../src/env.js";
import { CLEANUP_ERROR_GROUPS, housekeepingHandlers } from "../../src/jobs/housekeeping.js";
import { MAX_EVENTS_PER_GROUP, fingerprint, normalizeMessage, topFrame } from "../../src/telemetry/errors.js";
import { ADMIN_ROLES } from "../../src/admin/permissions.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";

/**
 * Contract v0.16.0 §11 (owner 2026-10-29, Crashes & errors): optional crash report fields, grouping by fingerprint,
 * the server's own unhandled errors, GET /admin/errors and PATCH /admin/errors/{errorId} (system.read), reopen,
 * the per-group cap and the 30-day retention.
 */

let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-10-29T10:00:00Z") };
const advance = (seconds: number) => (clock.now = new Date(clock.now.getTime() + seconds * 1000));
const SECRET = "test-secret-".padEnd(48, "x");
let ipCounter = 0;
const freshIp = () => `10.7.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;
let superAdmin: { headers: Record<string, string> };
let keyCounter = 0;
const key = () => `errors-test-key-${++keyCounter}`.padEnd(20, "x");

beforeAll(async () => {
  database = await freshDatabase();
  app = await buildApp({ env: readEnv({ MOVERA_ENV: "staging", DATABASE_URL: database.url, JWT_SECRET: SECRET }), logger: false, db: database.db, clock: () => clock.now });
  app.get("/api/v1/test-only/boom/:id", async () => {
    throw new Error("Database exploded for anna@example.com at row 42");
  });
  superAdmin = await adminSession(app, database.db, "super", { now: clock.now });
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

function crash(payload: Record<string, unknown>, ip = freshIp()) {
  return app.inject({ method: "POST", url: "/api/v1/telemetry/crashes", remoteAddress: ip, headers: { "content-type": "application/json" }, payload });
}
async function list(query = "", headers = superAdmin.headers) {
  const res = await app.inject({ method: "GET", url: `/api/v1/admin/errors${query}`, headers });
  return res;
}
type Group = { id: string; app: string; platform: string; appVersions: string[]; message: string; topFrame?: string; kind: string; count: number; devices: number; firstSeen: string; lastSeen: string; status: string; fixedAt: string | null };
const items = async (query = "") => ((await list(query)).json() as { items: Group[] }).items;
function patch(id: string, status: string, headers: Record<string, string> = superAdmin.headers) {
  return app.inject({ method: "PATCH", url: `/api/v1/admin/errors/${id}`, headers: { ...headers, "content-type": "application/json", "idempotency-key": key() }, payload: { status } });
}

const STACK = (line: number) => `#0      RideScreen.build (package:movera/ride_screen.dart:${line}:7)\n#1      main (package:movera/main.dart:3:1)`;

describe("fingerprint", () => {
  it("ignores numbers, ids and line numbers; keeps app, platform, message and top frame apart", () => {
    expect(normalizeMessage("Trip trp_01JB2Z3Y4X5W6V7T8S9R0QPNMK not found after 30 s")).toBe("Trip <id> not found after <n> s");
    expect(topFrame(STACK(12))).toBe("RideScreen.build (package:movera/ride_screen.dart)");
    expect(topFrame("Error: x\n    at handler (/app/dist/trips.js:10:5)")).toBe("at handler (/app/dist/trips.js)");
    const a = fingerprint("driver", "android", "Null check at 12", STACK(12));
    expect(fingerprint("driver", "android", "Null check at 99", STACK(40))).toBe(a);
    expect(fingerprint("rider", "android", "Null check at 12", STACK(12))).not.toBe(a);
    expect(fingerprint("driver", "ios", "Null check at 12", STACK(12))).not.toBe(a);
    expect(fingerprint("driver", "android", "Other message", STACK(12))).not.toBe(a);
    expect(fingerprint("driver", "android", "Null check at 12", "#0 other (package:movera/x.dart:1:1)")).not.toBe(a);
  });

  it("the cap is the contract's", () => {
    expect(MAX_EVENTS_PER_GROUP).toBe((contract as unknown as { telemetry: { errorGroups: { maxEventsPerGroup: number } } }).telemetry.errorGroups.maxEventsPerGroup);
  });
});

describe("POST /telemetry/crashes (v0.16.0 fields)", () => {
  it("takes the optional fields and refuses values outside their enums", async () => {
    const ok = await crash({ error: "StateError: bad", app: "driver", platform: "android", appVersion: "1.4.2", build: "142", screen: "/ride", kind: "error", occurredAt: "2026-10-29T09:59:00Z" });
    expect(ok.statusCode).toBe(202);
    expect((await crash({ error: "x", app: "admin", platform: "android" })).statusCode).toBe(400);
    expect((await crash({ error: "x", app: "driver", platform: "windows" })).statusCode).toBe(400);
    expect((await crash({ error: "x", kind: "panic" })).statusCode).toBe(400);
  });

  it("an older report without app and platform is still kept, ungrouped", async () => {
    const before = (await items()).length;
    expect((await crash({ error: "OldAppError", stack: "at main.dart:1" })).statusCode).toBe(202);
    expect((await items()).length).toBe(before);
    const row = await database.db.selectFrom("telemetry").selectAll().where("kind", "=", "crash").where("error_id", "is", null).executeTakeFirst();
    expect(row).toBeDefined();
  });
});

describe("GET /admin/errors", () => {
  it("groups by fingerprint with count, distinct devices, versions, first and last seen; scrubbed", async () => {
    advance(60);
    const first = new Date(clock.now);
    const ip = freshIp();
    await crash({ error: "Null check failed for ride 17, call +46 70 174 06 08", stack: STACK(12), app: "rider", platform: "ios", appVersion: "2.0.0" }, ip);
    advance(30);
    await crash({ error: "Null check failed for ride 18, call +46 70 174 06 08", stack: STACK(13), app: "rider", platform: "ios", appVersion: "2.0.1" }, ip);
    advance(30);
    await crash({ error: "Null check failed for ride 19, call +46 70 174 06 09", stack: STACK(14), app: "rider", platform: "ios", appVersion: "2.0.1" });
    const group = (await items("?app=rider&platform=ios")).find((g) => g.message.startsWith("Null check failed"))!;
    expect(group).toMatchObject({ app: "rider", platform: "ios", kind: "crash", count: 3, devices: 2, status: "open", appVersions: ["2.0.1", "2.0.0"], fixedAt: null });
    expect(group.firstSeen).toBe(first.toISOString());
    expect(group.lastSeen).toBe(clock.now.toISOString());
    expect(group.topFrame).toBe("RideScreen.build (package:movera/ride_screen.dart)");
    const stored = JSON.stringify(await database.db.selectFrom("telemetry").selectAll().where("error_id", "=", group.id).execute());
    expect(JSON.stringify(group) + stored).not.toMatch(/174 06 08/);
  });

  it("filters by app, platform, version and status; newest lastSeen first; cursor pages", async () => {
    advance(60);
    await crash({ error: "Android only", app: "driver", platform: "android", appVersion: "3.1.0" });
    advance(60);
    await crash({ error: "Web only", app: "driver", platform: "web", appVersion: "3.2.0" });
    const all = await items();
    expect(all.map((g) => g.lastSeen)).toEqual([...all.map((g) => g.lastSeen)].sort().reverse());
    expect(all[0]!.message).toBe("Web only");
    expect((await items("?platform=android")).every((g) => g.platform === "android")).toBe(true);
    expect((await items("?version=3.1.0")).map((g) => g.message)).toEqual(["Android only"]);
    expect((await items("?app=server")).every((g) => g.app === "server")).toBe(true);
    expect((await items("?status=fixed")).length).toBe(0);
    const page1 = (await list("?limit=2")).json() as { items: Group[]; nextCursor: string | null };
    expect(page1.items.length).toBe(2);
    const page2 = (await list(`?limit=2&cursor=${page1.nextCursor}`)).json() as { items: Group[] };
    expect(page2.items[0]!.id).not.toBe(page1.items[1]!.id);
    expect([...page1.items, ...page2.items].map((g) => g.id)).toEqual(all.slice(0, page1.items.length + page2.items.length).map((g) => g.id));
    expect((await list("?app=admin")).statusCode).toBe(400);
  });

  it("is open to every admin role (owner: \"All admin roles (Recommended)\"); no token 401", async () => {
    for (const role of ADMIN_ROLES) {
      const session = await adminSession(app, database.db, role, { now: clock.now });
      expect((await list("", session.headers)).statusCode, role).toBe(200);
    }
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/errors" })).statusCode).toBe(401);
  });
});

describe("PATCH /admin/errors/{errorId}", () => {
  it("marks fixed (audited); a new report opens it again", async () => {
    advance(60);
    await crash({ error: "Fix me", app: "driver", platform: "ios" });
    const group = (await items()).find((g) => g.message === "Fix me")!;
    const fixed = await patch(group.id, "fixed");
    expect(fixed.statusCode).toBe(200);
    expect(fixed.json()).toMatchObject({ id: group.id, status: "fixed", fixedAt: clock.now.toISOString() });
    expect((await items("?status=fixed")).map((g) => g.id)).toContain(group.id);
    const auditRow = await database.db.selectFrom("admin_audit").selectAll().where("target_id", "=", group.id).executeTakeFirst();
    expect(auditRow).toMatchObject({ action: "error.fixed", target_type: "error_group" });
    advance(60);
    await crash({ error: "Fix me", app: "driver", platform: "ios" });
    const again = (await items()).find((g) => g.id === group.id)!;
    expect(again).toMatchObject({ status: "open", fixedAt: null, count: 2 });
  });

  it("any admin role may mark fixed or open again", async () => {
    await crash({ error: "Any role", app: "driver", platform: "web" });
    const group = (await items()).find((g) => g.message === "Any role")!;
    for (const role of ADMIN_ROLES.filter((r) => r !== "super")) {
      const session = await adminSession(app, database.db, role, { now: clock.now });
      const res = await patch(group.id, role.length % 2 === 0 ? "fixed" : "open", session.headers);
      expect(res.statusCode, role).toBe(200);
    }
  });

  it("needs a signed-in admin, an Idempotency-Key, a known id and a valid status", async () => {
    await crash({ error: "Guarded", app: "rider", platform: "web" });
    const group = (await items()).find((g) => g.message === "Guarded")!;
    expect((await patch(group.id, "fixed", { authorization: "Bearer nope" })).statusCode).toBe(401);
    expect((await patch(group.id, "closed")).statusCode).toBe(400);
    expect((await patch("err_missing", "fixed")).statusCode).toBe(404);
    const noKey = await app.inject({ method: "PATCH", url: `/api/v1/admin/errors/${group.id}`, headers: { ...superAdmin.headers, "content-type": "application/json" }, payload: { status: "fixed" } });
    expect(noKey.statusCode).toBe(400);
  });
});

describe("the server's own errors", () => {
  it("an unhandled 5xx is recorded as app server, scrubbed, grouped by route", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/test-only/boom/1" });
    expect(res.statusCode).toBe(500);
    await app.inject({ method: "GET", url: "/api/v1/test-only/boom/2" });
    const server = await items("?app=server");
    expect(server.length).toBe(1);
    expect(server[0]).toMatchObject({ app: "server", platform: "server", kind: "error", count: 2 });
    expect(server[0]!.message).toContain("Database exploded");
    expect(server[0]!.message).not.toContain("example.com");
    const rows = await database.db.selectFrom("telemetry").selectAll().where("error_id", "=", server[0]!.id).execute();
    expect(JSON.stringify(rows)).not.toContain("example.com");
    expect(rows[0]!.body).toMatchObject({ screen: "GET /api/v1/test-only/boom/:id" });
  });

  it("a handled error (4xx, or an ApiError) is not recorded", async () => {
    const before = (await items("?app=server"))[0]!.count;
    await app.inject({ method: "GET", url: "/api/v1/admin/errors?app=nope", headers: superAdmin.headers });
    await app.inject({ method: "GET", url: "/api/v1/no-such-route" });
    expect((await items("?app=server"))[0]!.count).toBe(before);
  });
});

describe("cap and retention", () => {
  it(`keeps at most ${MAX_EVENTS_PER_GROUP} reports per group while the count goes on`, async () => {
    const extra = 3;
    for (let i = 0; i < MAX_EVENTS_PER_GROUP + extra; i++) {
      if (i % 100 === 0) advance(61); // the per-address minute window
      await crash({ error: "Flood", app: "driver", platform: "android" }, `10.8.${Math.floor(i / 250)}.${i % 250}`);
    }
    const group = (await items()).find((g) => g.message === "Flood")!;
    expect(group.count).toBe(MAX_EVENTS_PER_GROUP + extra);
    const kept = await database.db.selectFrom("telemetry").select((eb) => eb.fn.countAll<string>().as("n")).where("error_id", "=", group.id).executeTakeFirstOrThrow();
    expect(Number(kept.n)).toBe(MAX_EVENTS_PER_GROUP);
  }, 60_000);

  it("groups not seen for 30 days go with their reports", async () => {
    const later = new Date(clock.now.getTime() + 31 * 24 * 3600_000);
    // S4 0.14b: the error-group clean-up has its own hourly timer.
    await database.db.transaction().execute((trx) => housekeepingHandlers[CLEANUP_ERROR_GROUPS]!(trx, { firedAt: later } as never));
    expect(await database.db.selectFrom("error_groups").selectAll().execute()).toEqual([]);
    expect(await database.db.selectFrom("error_group_devices").selectAll().execute()).toEqual([]);
  });
});
