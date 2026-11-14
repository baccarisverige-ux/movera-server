import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { readEnv } from "../../src/env.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";

/**
 * J5b server (contract v0.18.86 commissionSteps.validation): PUT /admin/config/pricing and POST
 * /admin/config/pricing/publish refuse bad commission steps with 400 invalid_request, reason commission_steps_invalid,
 * details ["step:<i>", "problem:<code>"], and save nothing; good steps (also a warn case: advisory only) are saved and
 * published as sent. In a SEK zone (Z002) and the TND zone (TN-TC, 3 decimals).
 */

let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-11-14T10:00:00Z") };
const SECRET = "j5b-steps-test-secret".padEnd(48, "z");
let keys = 0;
const key = () => `j5b-steps-key-${String(++keys).padStart(8, "0")}`;
const send = (method: "GET" | "PUT" | "POST", url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, headers: { ...headers, ...(method === "GET" ? {} : { "content-type": "application/json", "idempotency-key": key() }) }, ...(payload === undefined ? {} : { payload: payload as object }) });

const sample = JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/pricing_document.json`, "utf8")) as Record<string, unknown>;
const docFor = (zoneId: string, currency: string, steps?: unknown) => {
  const doc = JSON.parse(JSON.stringify(sample).replaceAll('"currency":"SEK"', `"currency":"${currency}"`)) as Record<string, unknown> & { zoneId: string; categories: Record<string, Record<string, unknown>> };
  doc.zoneId = zoneId;
  if (currency === "TND") Object.assign(doc, { country: "TN", timeZone: "Africa/Tunis" });
  if (steps !== undefined) doc.categories["economy"]!["commissionSteps"] = steps;
  return doc;
};
const TN_STEPS = [{ upToMinor: 5000, amountMinor: 1000 }, { upToMinor: 15000, pct: 18 }, { upToMinor: null, pct: 20 }];
const WARN_STEPS = [{ upToMinor: 5000, amountMinor: 500 }, { upToMinor: null, pct: 25 }];

beforeAll(async () => {
  database = await freshDatabase();
  app = await buildApp({ env: readEnv({ MOVERA_ENV: "staging", DATABASE_URL: database.url, JWT_SECRET: SECRET }), logger: false, db: database.db, clock: () => clock.now });
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

describe.each([
  ["SEK", "Z002"],
  ["TND", "TN-TC"],
])("J5b commission steps over HTTP in a %s zone (%s)", (currency, zoneId) => {
  it("PUT: a bad step is 400 commission_steps_invalid with step and problem, and nothing is saved", async () => {
    const owner = await adminSession(app, database.db, "super", { now: clock.now });
    const before = await send("GET", `/admin/config/pricing?zoneId=${zoneId}`, owner.headers);
    const version = before.statusCode === 200 ? (before.json() as { version: number }).version : 1;
    for (const [steps, details] of [
      [[{ upToMinor: 5000, amountMinor: 1000 }, { upToMinor: 5000, pct: 18 }, { upToMinor: null, pct: 20 }], ["step:1", "problem:up_to_not_increasing"]],
      [[{ upToMinor: 5000, amountMinor: 1000 }, { upToMinor: 15000, pct: 18 }], ["step:1", "problem:last_not_above"]],
      [{ upToMinor: null, pct: 15 }, ["problem:not_a_list"]],
      [[{ upToMinor: null, pct: 61 }], ["step:0", "problem:pct_out_of_range"]],
    ] as Array<[unknown, string[]]>) {
      const res = await send("PUT", "/admin/config/pricing", owner.headers, { expectedVersion: version, zoneId, document: docFor(zoneId, currency, steps) });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json()).toMatchObject({ code: "invalid_request", reason: "commission_steps_invalid", details });
    }
    const after = await send("GET", `/admin/config/pricing?zoneId=${zoneId}`, owner.headers);
    expect(after.statusCode).toBe(before.statusCode);
    if (after.statusCode === 200) expect((after.json() as { version: number }).version).toBe(version);
  });

  it("PUT + publish: the owner's steps and a warn case are saved and published exactly as sent", async () => {
    const owner = await adminSession(app, database.db, "super", { now: clock.now });
    const start = await send("GET", `/admin/config/pricing?zoneId=${zoneId}`, owner.headers);
    let version = start.statusCode === 200 ? (start.json() as { version: number }).version : 1;
    for (const steps of [WARN_STEPS, TN_STEPS]) {
      const saved = await send("PUT", "/admin/config/pricing", owner.headers, { expectedVersion: version, zoneId, document: docFor(zoneId, currency, steps) });
      expect(saved.statusCode, saved.body).toBe(200);
      expect((saved.json() as { document: { categories: Record<string, { commissionSteps?: unknown }> } }).document.categories["economy"]!.commissionSteps).toEqual(steps);
      version = (saved.json() as { version: number }).version;
    }
    const published = await send("POST", "/admin/config/pricing/publish", owner.headers, { expectedVersion: version, zoneId });
    expect(published.statusCode, published.body).toBe(200);
    const live = await database.db.selectFrom("config_live").select("document").where("doc", "=", "pricing").where("zone_id", "=", zoneId).executeTakeFirstOrThrow();
    expect((live.document as { categories: Record<string, { commissionSteps?: unknown }> }).categories["economy"]!.commissionSteps).toEqual(TN_STEPS);
  });

  it("publish: a draft stored with bad steps (an older server took them unchecked) is refused, the live document stays", async () => {
    const owner = await adminSession(app, database.db, "super", { now: clock.now });
    const draft = (await send("GET", `/admin/config/pricing?zoneId=${zoneId}`, owner.headers)).json() as { version: number };
    const liveBefore = await database.db.selectFrom("config_live").select("version").where("doc", "=", "pricing").where("zone_id", "=", zoneId).executeTakeFirstOrThrow();
    const bad = docFor(zoneId, currency, [{ upToMinor: null, pct: 20 }, { upToMinor: null, pct: 18 }]);
    await sql`UPDATE config_drafts SET document = ${JSON.stringify(bad)}::jsonb WHERE doc = 'pricing' AND zone_id = ${zoneId}`.execute(database.db);
    const res = await send("POST", "/admin/config/pricing/publish", owner.headers, { expectedVersion: draft.version, zoneId });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json()).toMatchObject({ code: "invalid_request", reason: "commission_steps_invalid", details: ["step:0", "problem:above_not_last"] });
    const liveAfter = await database.db.selectFrom("config_live").select("version").where("doc", "=", "pricing").where("zone_id", "=", zoneId).executeTakeFirstOrThrow();
    expect(liveAfter.version).toBe(liveBefore.version);
  });
});
