import { TEST_CODE } from "../../src/auth/service.js";
import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { seedTestPhones, TEST_PHONES } from "../../src/auth/testPhones.js";
import { readEnv } from "../../src/env.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";

// v0.18.25 admin real app preview (contract.json#previewSession; owner P1 a, P2 b, P3 a).
let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-11-04T10:00:00Z") };
const SECRET = "preview-test-secret".padEnd(48, "z");
const sample = (name: string) => JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/${name}.json`, "utf8")) as Record<string, unknown>;
let keys = 0;
const send = (method: "GET" | "PUT" | "POST" | "PATCH" | "DELETE", url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, headers: { ...headers, ...(method === "GET" ? {} : { "content-type": "application/json", "idempotency-key": `preview-key-${String(++keys).padStart(8, "0")}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) });

beforeAll(async () => {
  database = await freshDatabase();
  await seedTestPhones(database.db);
  app = await buildApp({ env: readEnv({ MOVERA_ENV: "staging", DATABASE_URL: database.url, JWT_SECRET: SECRET }), logger: false, db: database.db, clock: () => clock.now });
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

async function preview(role: "rider" | "driver", zoneId: string, useDraft = false) {
  const owner = await adminSession(app, database.db, "super", { now: clock.now });
  const res = await send("POST", "/admin/preview-sessions", owner.headers, { role, zoneId, useDraft });
  expect(res.statusCode).toBe(201);
  return { owner, session: res.json() as { token: string; expiresAt: string; subjectId: string; role: string; zoneId: string }, headers: { authorization: `Bearer ${res.json().token}` } };
}

describe("POST /admin/preview-sessions", () => {
  it("gives a 15-minute token for the zone; needs settings.read and the zone in scope", async () => {
    const { session } = await preview("rider", "Z002");
    expect(session).toMatchObject({ role: "rider", zoneId: "Z002", useDraft: false, subjectId: "preview:rider:Z002", expiresAt: new Date(clock.now.getTime() + 900_000).toISOString() });
    const viewer = await adminSession(app, database.db, "viewer", { now: clock.now });
    expect((await send("POST", "/admin/preview-sessions", viewer.headers, { role: "rider", zoneId: "Z002" })).json()).toMatchObject({ reason: "missing_permission" });
    const local = await adminSession(app, database.db, "config", { zoneIds: ["Z002"], now: clock.now });
    expect((await send("POST", "/admin/preview-sessions", local.headers, { role: "driver", zoneId: "Z004" })).json()).toMatchObject({ reason: "zone_out_of_scope" });
  });

  it("a preview token cannot book, accept, pay, go online or change anything: 403 preview_blocked", async () => {
    const rider = await preview("rider", "Z002");
    const driver = await preview("driver", "Z002");
    let checked = 0;
    let blocked = 0;
    for (const [method, url, headers] of [
      ["POST", "/quotes", rider.headers],
      ["POST", "/trips", rider.headers],
      ["POST", "/trips/trp_x/tip", rider.headers],
      ["PATCH", "/rider/profile", rider.headers],
      ["POST", "/driver/availability", driver.headers],
      ["POST", "/driver/reservations/trp_x/accept", driver.headers],
      ["PUT", "/driver/home-area", driver.headers],
      ["POST", "/driver/location", driver.headers],
    ] as const) {
      checked += 1;
      const res = await send(method, url, headers, {});
      if (res.statusCode === 404 && res.json().reason === "operation_not_enabled") continue; // no such route on this server
      blocked += 1;
      expect({ url, status: res.statusCode, reason: res.json().reason }).toEqual({ url, status: 403, reason: "preview_blocked" });
    }
    expect(checked).toBe(8);
    expect(blocked).toBeGreaterThanOrEqual(7);
  });

  it("expires after 15 minutes", async () => {
    const { headers } = await preview("rider", "Z002");
    const saved = clock.now;
    clock.now = new Date(saved.getTime() + 901_000);
    expect((await send("GET", "/rider/config?zoneId=Z002", headers)).statusCode).toBe(401);
    clock.now = saved;
  });
});

describe("GET /rider/config?draft=1", () => {
  it("serves the saved draft to a preview token only; a real rider always gets live", async () => {
    const owner = await adminSession(app, database.db, "super", { now: clock.now });
    const live = { ...sample("rider_app_config"), zoneId: "Z003" };
    await send("PUT", "/admin/config/rider_app_config", owner.headers, { expectedVersion: 1, zoneId: "Z003", document: live });
    expect((await send("POST", "/admin/config/rider_app_config/publish", owner.headers, { expectedVersion: 2, zoneId: "Z003" })).statusCode).toBe(200);
    const draft = { ...live, brandName: "Draft name" };
    const current = (await send("GET", "/admin/config/rider_app_config?zoneId=Z003", owner.headers)).json() as { version: number };
    const put = await send("PUT", "/admin/config/rider_app_config", owner.headers, { expectedVersion: current.version, zoneId: "Z003", document: draft });
    expect(put.statusCode).toBe(200);

    const { headers } = await preview("rider", "Z003", true);
    const asDraft = await send("GET", "/rider/config?draft=1", headers);
    expect(asDraft.statusCode).toBe(200);
    expect(asDraft.json().brandName).toBe("Draft name");
    expect((await send("GET", "/rider/config?draft=0", headers)).json().brandName).not.toBe("Draft name");

    const phone = TEST_PHONES[0]!;
    const challenge = await app.inject({ method: "POST", url: "/api/v1/auth/otp/request", payload: { phone, app: "rider" } });
    const verify = await app.inject({ method: "POST", url: "/api/v1/auth/otp/verify", payload: { phone, sessionId: challenge.json().sessionId, code: TEST_CODE } });
    const real = await send("GET", "/rider/config?zoneId=Z003&draft=1", { authorization: `Bearer ${verify.json().accessToken}` });
    expect(real.json().brandName).not.toBe("Draft name");
  });
});
