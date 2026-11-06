import { TEST_CODE } from "../../src/auth/service.js";
import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { seedTestPhones, TEST_PHONES } from "../../src/auth/testPhones.js";
import { CONFIG_CHANNEL } from "../../src/config/service.js";
import { readEnv } from "../../src/env.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";

let database: TestDatabase;
let app: FastifyInstance;
let listener: pg.Client;
const published: Array<{ doc: string; zoneId: string; version: number }> = [];
const clock = { now: new Date("2026-10-24T10:00:00Z") };
const advance = (seconds: number) => (clock.now = new Date(clock.now.getTime() + seconds * 1000));
const SECRET = "config-test-secret".padEnd(48, "z");

const sample = (name: string) => JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/${name}.json`, "utf8")) as Record<string, unknown>;
const forZone = (doc: Record<string, unknown>, zoneId: string) => ({ ...doc, zoneId });

let keys = 0;
const key = () => `config-key-${String(++keys).padStart(8, "0")}`;
const send = (method: "GET" | "PUT" | "POST", url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, headers: { ...headers, ...(method === "GET" ? {} : { "content-type": "application/json", "idempotency-key": key() }) }, ...(payload === undefined ? {} : { payload: payload as object }) });

async function riderHeaders() {
  const phone = TEST_PHONES[0]!;
  const challenge = await app.inject({ method: "POST", url: "/api/v1/auth/otp/request", payload: { phone, app: "rider" } });
  const verify = await app.inject({ method: "POST", url: "/api/v1/auth/otp/verify", payload: { phone, sessionId: challenge.json().sessionId, code: TEST_CODE } });
  return { authorization: `Bearer ${verify.json().accessToken}` };
}

beforeAll(async () => {
  database = await freshDatabase();
  await seedTestPhones(database.db);
  app = await buildApp({ env: readEnv({ MOVERA_ENV: "staging", DATABASE_URL: database.url, JWT_SECRET: SECRET }), logger: false, db: database.db, clock: () => clock.now });
  listener = new pg.Client({ connectionString: database.url });
  await listener.connect();
  listener.on("notification", (message) => published.push(JSON.parse(message.payload ?? "{}")));
  await listener.query(`LISTEN ${CONFIG_CHANNEL}`);
});
afterAll(async () => {
  await listener.end();
  await app.close();
  await database.drop();
});
beforeEach(() => {
  advance(3600);
});

describe("drafts", () => {
  it("nothing yet: 404 config_not_found; the first save uses expectedVersion 1; a stale save is 409 with the draft", async () => {
    const owner = await adminSession(app, database.db, "super", { now: clock.now });
    const missing = await send("GET", "/admin/config/rider_app_config?zoneId=Z002", owner.headers);
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ reason: "config_not_found" });

    const doc = forZone(sample("rider_app_config"), "Z002");
    const saved = await send("PUT", "/admin/config/rider_app_config", owner.headers, { expectedVersion: 1, zoneId: "Z002", document: doc });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ doc: "rider_app_config", zoneId: "Z002", version: 2, liveVersion: 0, document: doc, updatedBy: owner.adminId });

    const stale = await send("PUT", "/admin/config/rider_app_config", owner.headers, { expectedVersion: 1, zoneId: "Z002", document: doc });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "version_mismatch", projection: { version: 2 } });
  });

  it("a document outside the contract, for another zone or in another currency is refused", async () => {
    const owner = await adminSession(app, database.db, "super", { now: clock.now });
    const bad = await send("PUT", "/admin/config/pricing", owner.headers, { expectedVersion: 1, zoneId: "Z003", document: { zoneId: "Z003" } });
    expect(bad.json()).toMatchObject({ code: "invalid_request", reason: "invalid_document" });
    const other = await send("PUT", "/admin/config/pricing", owner.headers, { expectedVersion: 1, zoneId: "Z003", document: sample("pricing_document") });
    expect(other.json()).toMatchObject({ reason: "zone_mismatch" });
    const euros = await send("PUT", "/admin/config/pricing", owner.headers, { expectedVersion: 1, zoneId: "Z003", document: { ...forZone(sample("pricing_document"), "Z003"), currency: "EUR" } });
    expect(euros.json()).toMatchObject({ code: "invalid_request" });
    expect((await send("GET", "/admin/config/pricing?zoneId=NOPE", owner.headers)).json()).toMatchObject({ reason: "zone_not_found" });
  });

  it("an admin limited to some zones cannot touch others; a viewer cannot edit", async () => {
    const local = await adminSession(app, database.db, "config", { zoneIds: ["Z002"], now: clock.now });
    expect((await send("GET", "/admin/config/rider_app_config?zoneId=Z001", local.headers)).json()).toMatchObject({ code: "forbidden", reason: "zone_out_of_scope" });
    const viewer = await adminSession(app, database.db, "viewer", { now: clock.now });
    const res = await send("PUT", "/admin/config/rider_app_config", viewer.headers, { expectedVersion: 1, zoneId: "Z001", document: sample("rider_app_config") });
    expect(res.json()).toMatchObject({ code: "forbidden", reason: "missing_permission" });
  });
});

describe("publish", () => {
  it("a Super admin publishes at once: version 1, 2, … stamped into the document, the apps read it, a notification goes out", async () => {
    const owner = await adminSession(app, database.db, "super", { now: clock.now });
    const rider = await riderHeaders();
    expect((await send("GET", "/rider/config?zoneId=Z004", rider)).json()).toMatchObject({ reason: "config_not_published" });

    const doc = forZone(sample("rider_app_config"), "Z004");
    await send("PUT", "/admin/config/rider_app_config", owner.headers, { expectedVersion: 1, zoneId: "Z004", document: doc });
    published.length = 0;
    const first = await send("POST", "/admin/config/rider_app_config/publish", owner.headers, { expectedVersion: 2, zoneId: "Z004", note: "first" });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ doc: "rider_app_config", zoneId: "Z004", version: 1, publishedAt: clock.now.toISOString() });

    const served = await send("GET", "/rider/config?zoneId=Z004", rider);
    expect(served.statusCode).toBe(200);
    // v0.18.10 (contract.json#finish.paymentMethods.served): the server adds what it takes today (cash).
    // v0.18.19 (liveFixes.horizon): the served bookingHorizonDays is the zone's maxAheadDays (90).
    expect(served.json()).toEqual({ ...doc, booking: { ...(doc as unknown as { booking: object }).booking, bookingHorizonDays: 90, reservationsOn: true }, version: 1, publishedAt: clock.now.toISOString(), dontMatchAgain: { on: true, atStars: 1 }, paymentOptions: ((doc as { paymentMethods?: string[] }).paymentMethods ?? []).map((method: string) => ({ method, status: method === "cash" ? "available" : "coming_soon" })) });

    advance(60);
    const draft = (await send("GET", "/admin/config/rider_app_config?zoneId=Z004", owner.headers)).json();
    const second = await send("POST", "/admin/config/rider_app_config/publish", owner.headers, { expectedVersion: draft.version, zoneId: "Z004" });
    expect(second.json()).toMatchObject({ version: 2 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(published.filter((p) => p.zoneId === "Z004").map((p) => p.version)).toEqual([1, 2]);

    const history = await database.db.selectFrom("config_history").select(["version", "note"]).where("zone_id", "=", "Z004").orderBy("version").execute();
    expect(history).toEqual([{ version: 1, note: "first" }, { version: 2, note: null }]);
    const audit = await database.db.selectFrom("admin_audit").select("action").where("zone_id", "=", "Z004").execute();
    expect(audit.map((a) => a.action)).toContain("config.publish");
  });

  it("pricing and dispatch are never served to the apps", async () => {
    const rider = await riderHeaders();
    const res = await app.inject({ method: "GET", url: "/api/v1/rider/config/pricing", headers: rider });
    expect(res.statusCode).toBe(404);
  });

  it("v0.8.0: any admin with the publish right publishes at once (200, no second admin); without it, 403", async () => {
    const editorA = await adminSession(app, database.db, "config", { now: clock.now });
    const viewer = await adminSession(app, database.db, "viewer", { now: clock.now });
    const doc = forZone(sample("driver_app_config"), "Z005");
    await send("PUT", "/admin/config/driver_app_config", editorA.headers, { expectedVersion: 1, zoneId: "Z005", document: doc });

    const refused = await send("POST", "/admin/config/driver_app_config/publish", viewer.headers, { expectedVersion: 2, zoneId: "Z005" });
    expect(refused.json()).toMatchObject({ code: "forbidden", reason: "missing_permission" });
    const asked = await send("POST", "/admin/config/driver_app_config/publish", editorA.headers, { expectedVersion: 2, zoneId: "Z005" });
    expect(asked.statusCode).toBe(200);
    expect(asked.json()).toEqual({ doc: "driver_app_config", zoneId: "Z005", version: 1, publishedAt: clock.now.toISOString() });
    const live = await database.db.selectFrom("config_live").selectAll().where("zone_id", "=", "Z005").executeTakeFirstOrThrow();
    expect(live).toMatchObject({ doc: "driver_app_config", version: 1, published_by: editorA.adminId });
    expect(await database.db.selectFrom("approvals").select("approval_id").where("target_id", "=", "driver_app_config").execute()).toEqual([]);
  });

  it("a publish of a draft that changed since fails with version_mismatch; the version the admin sends is ignored", async () => {
    const editorA = await adminSession(app, database.db, "config", { now: clock.now });
    const editorB = await adminSession(app, database.db, "config", { now: clock.now });
    const doc = { ...forZone(sample("rider_app_config"), "Z009"), version: 41 };
    await send("PUT", "/admin/config/rider_app_config", editorA.headers, { expectedVersion: 1, zoneId: "Z009", document: doc });
    await send("PUT", "/admin/config/rider_app_config", editorB.headers, { expectedVersion: 2, zoneId: "Z009", document: doc });
    const stale = await send("POST", "/admin/config/rider_app_config/publish", editorA.headers, { expectedVersion: 2, zoneId: "Z009" });
    expect(stale.json()).toMatchObject({ code: "version_mismatch", reason: "draft_changed" });
    const ok = await send("POST", "/admin/config/rider_app_config/publish", editorA.headers, { expectedVersion: 3, zoneId: "Z009" });
    expect(ok.json()).toMatchObject({ version: 1 });
  });

  it("dispatch rules need dispatch.edit; the publish replays with the same key", async () => {
    const config = await adminSession(app, database.db, "config", { now: clock.now });
    const owner = await adminSession(app, database.db, "super", { now: clock.now });
    const doc = forZone(sample("dispatch_document"), "Z003");
    expect((await send("PUT", "/admin/config/dispatch", config.headers, { expectedVersion: 1, zoneId: "Z003", document: doc })).json()).toMatchObject({ reason: "missing_permission" });
    await send("PUT", "/admin/config/dispatch", owner.headers, { expectedVersion: 1, zoneId: "Z003", document: doc });
    const headers = { ...owner.headers, "content-type": "application/json", "idempotency-key": "publish-dispatch-z003-key" };
    const first = await app.inject({ method: "POST", url: "/api/v1/admin/config/dispatch/publish", headers, payload: { expectedVersion: 2, zoneId: "Z003" } });
    const replay = await app.inject({ method: "POST", url: "/api/v1/admin/config/dispatch/publish", headers, payload: { expectedVersion: 2, zoneId: "Z003" } });
    expect(first.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
    expect((await database.db.selectFrom("config_history").select("version").where("doc", "=", "dispatch").where("zone_id", "=", "Z003").execute()).length).toBe(1);
  });
});

describe("driver config", () => {
  it("a driver gets their zone's document, else the default zone's", async () => {
    const owner = await adminSession(app, database.db, "super", { now: clock.now });
    const doc = forZone(sample("driver_app_config"), "Z001");
    await send("PUT", "/admin/config/driver_app_config", owner.headers, { expectedVersion: 1, zoneId: "Z001", document: doc });
    await send("POST", "/admin/config/driver_app_config/publish", owner.headers, { expectedVersion: 2, zoneId: "Z001" });
    const phone = TEST_PHONES[1]!;
    const challenge = await app.inject({ method: "POST", url: "/api/v1/auth/otp/request", payload: { phone, app: "driver" } });
    const verify = await app.inject({ method: "POST", url: "/api/v1/auth/otp/verify", payload: { phone, sessionId: challenge.json().sessionId, code: TEST_CODE } });
    const res = await send("GET", "/driver/config", { authorization: `Bearer ${verify.json().accessToken}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ zoneId: "Z001", version: 1 });
    const rider = await riderHeaders();
    expect((await send("GET", "/driver/config", rider)).json()).toMatchObject({ code: "forbidden", reason: "wrong_actor" });
  });
});
