import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { cacheGeometry } from "../../src/config/geometryCache.js";
import { seedDriver } from "../../src/drivers/service.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { approveDriverDocuments, approveVehicleDocuments } from "../support/seed.js";
import { call, signIn, testWorld } from "../support/world.js";

/**
 * Stress T-A part 3 (owner 2026-11-10, audits/stress-ta-2026-11-10/RESULT-3.md): at 700 + 700 the pool filled because
 * POST /driver/location ran 8–12 small statements in one transaction while Postgres waited on Node between them. This
 * counts the statements one location request sends (all of them, and those inside its transaction) and keeps them
 * under a budget. Before the change (wip/pool c15c087): online, no trip, inside his zone = 14 in the transaction
 * (BEGIN … COMMIT included), 15 in all; outside his zone = 15 / 16. After: 6 / 7 both.
 * S7 W2 Q114 (0.20): the idempotency_keys INSERT and UPDATE are gone. In the transaction now (supervisor SF4, measured):
 * 4 steady (BEGIN, the facts read that also sets the Q112 lock limit and takes the per-driver GPS lock (SF1), the position
 * upsert, COMMIT); 5 when the outage mark runs (drivers/presence.ts noteFixAfterOutage, once per 10 s per copy); 6 with
 * BQ-V44's cold campaign cache (branch …-v44r, not merged). So 6 is the real worst case and stays the cap; the steady
 * case is pinned at 4 below, so no new statement slips in unseen. No idempotency_keys statement is sent.
 */

let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-11-10T08:00:00Z") };
const STOCKHOLM = { lat: 59.3335, lng: 18.0655 };
const OUTSIDE = { lat: 59.636, lng: 17.077 };
const phone = TEST_PHONES[3]!;
let driverId = "";

beforeAll(async () => {
  cacheGeometry(15_000);
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  const made = await database.db.transaction().execute((trx) =>
    seedDriver(trx, { phone, firstName: "Driver SE", make: "Volvo", model: "V60", year: 2021, color: "Black", plate: "STM001", categoryIds: ["economy"], zoneIds: ["Z001"] }, clock.now),
  );
  driverId = made.driverId;
  await database.db.updateTable("drivers").set({ language: "sv", country: "SE" }).where("driver_id", "=", driverId).execute();
  await approveDriverDocuments(database.db, driverId);
  await approveVehicleDocuments(database.db, made.vehicleId, driverId, "SE");
});
afterAll(async () => {
  cacheGeometry(0);
  await app?.close();
  await database?.drop();
});

let headers: Record<string, string> = {};
beforeEach(async () => {
  clock.now = new Date(clock.now.getTime() + 3600_000);
  headers = (await signIn(app, phone, "driver")).headers;
  await database.db.updateTable("drivers").set({ online_status: "online", online_since: clock.now }).where("driver_id", "=", driverId).execute();
});

/** Every statement any pg client sends while `run` runs, and how many of them sit inside a BEGIN … COMMIT. */
async function counted<T>(run: () => Promise<T>): Promise<{ result: T; total: number; inTransaction: number; texts: string[] }> {
  const original = pg.Client.prototype.query;
  const texts: string[] = [];
  pg.Client.prototype.query = function (this: pg.Client, ...args: unknown[]) {
    const first = args[0];
    texts.push(typeof first === "string" ? first : String((first as { text?: string })?.text ?? ""));
    return (original as (...a: unknown[]) => unknown).apply(this, args);
  } as typeof original;
  try {
    const result = await run();
    const begin = texts.findIndex((t) => /^\s*begin/i.test(t));
    const commit = texts.findIndex((t) => /^\s*commit/i.test(t));
    return { result, total: texts.length, inTransaction: begin >= 0 && commit > begin ? commit - begin + 1 : 0, texts };
  } finally {
    pg.Client.prototype.query = original;
  }
}

const send = async (at: { lat: number; lng: number }) => {
  clock.now = new Date(clock.now.getTime() + 1000);
  return call(app, "POST", "/driver/location", headers, { fixes: [{ ...at, accuracy: 5, measuredAt: clock.now.toISOString() }] });
};

describe("POST /driver/location: statements per request (stress T-A part 3)", () => {
  it("online, no trip, inside his zone: at most 6 statements in the transaction (was 14); 4 when steady", async () => {
    await send(STOCKHOLM); // warms the geometry cache, as the first request of a server copy does
    await send(STOCKHOLM); // and the outage-mark check (at most once per 10 s per copy), so this is the steady case
    const { result, total, inTransaction, texts } = await counted(() => send(STOCKHOLM));
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ accepted: 1, outsideArea: false });
    console.info(`location inside: ${inTransaction} in transaction, ${total} in all\n  ${texts.map((t) => t.replace(/\s+/g, " ").slice(0, 110)).join("\n  ")}`);
    expect(inTransaction).toBeLessThanOrEqual(6);
    expect(inTransaction, texts.join("\n")).toBe(4); // SF4: the steady case, pinned
    expect(texts.some((t) => /"idempotency_keys"/i.test(t))).toBe(false);
    expect(texts.some((t) => /from "zones"/i.test(t))).toBe(false);
    expect(texts.some((t) => /from "airport_queue_areas"/i.test(t))).toBe(false);
  });

  it("online, outside his zones: the same budget, areaZones named from memory", async () => {
    await send(STOCKHOLM);
    const { result, inTransaction, total, texts } = await counted(() => send(OUTSIDE));
    expect(result.statusCode).toBe(200);
    expect(texts.some((t) => /"idempotency_keys"/i.test(t))).toBe(false);
    expect(result.json()).toMatchObject({ accepted: 1, outsideArea: true, areaZones: [{ zoneId: "Z001" }] });
    console.info(`location outside: ${inTransaction} in transaction, ${total} in all`);
    expect(inTransaction).toBeLessThanOrEqual(6);
  });

  // S7 W2 Q114 (0.20, owner "Yes, stop storing (Rec.)"): the key is taken and not looked at. It is still checked like
  // every mutation's header (missing or malformed = 400, contract §1 Headers), but no idempotency_keys row is written,
  // nothing is replayed and the same key with another body is not a 409. A resent batch is safe on its own (Q113).
  it("Q114: the Idempotency-Key is accepted and ignored: no key row, no replay, no 409", async () => {
    const rows = async () => Number((await database.db.selectFrom("idempotency_keys").select((eb) => eb.fn.countAll<string>().as("n")).where("subject_id", "=", driverId).where("route", "like", "%/driver/location").executeTakeFirstOrThrow()).n);
    clock.now = new Date(clock.now.getTime() + 1000);
    const body = { fixes: [{ ...STOCKHOLM, accuracy: 5, measuredAt: clock.now.toISOString() }] };
    const first = await call(app, "POST", "/driver/location", headers, body, "loc-replay-key-0000001");
    expect(first.statusCode).toBe(200);
    clock.now = new Date(clock.now.getTime() + 1000);
    const again = await call(app, "POST", "/driver/location", headers, body, "loc-replay-key-0000001");
    expect(again.statusCode).toBe(200);
    // Run again, not replayed: the answer carries this request's server time.
    expect(again.json()["serverTime"]).toBe(clock.now.toISOString());
    expect(again.json()["serverTime"]).not.toBe(first.json()["serverTime"]);
    clock.now = new Date(clock.now.getTime() + 1000);
    const other = await call(app, "POST", "/driver/location", headers, { fixes: [{ ...STOCKHOLM, accuracy: 6, measuredAt: clock.now.toISOString() }] }, "loc-replay-key-0000001");
    expect(other.statusCode).toBe(200);
    expect(await rows()).toBe(0);
    // The header itself is still checked like on every mutation (supervisor SF3: also a missing one).
    const bad = await call(app, "POST", "/driver/location", headers, body, "short");
    expect(bad.statusCode).toBe(400);
    expect(bad.json()["reason"]).toBe("idempotency_key_invalid");
    const missing = await app.inject({ method: "POST", url: "/api/v1/driver/location", headers: { ...headers, "content-type": "application/json" }, payload: body });
    expect(missing.statusCode, missing.body).toBe(400);
    expect(missing.json()["reason"]).toBe("idempotency_key_missing");
    expect(await rows()).toBe(0);
  });
});
