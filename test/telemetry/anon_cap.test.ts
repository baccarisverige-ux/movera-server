import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { seedTestPhones, TEST_PHONES } from "../../src/auth/testPhones.js";
import { readEnv } from "../../src/env.js";
import { loadSnapshot } from "../../src/telemetry/load.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { signIn } from "../support/world.js";

/**
 * B1.25 (owner W1 Q85, contract.json#telemetry.limits): calls without a valid token share a total per server copy,
 * TELEMETRY_ANON_ROWS_PER_MINUTE lines and TELEMETRY_ANON_BYTES_PER_MINUTE bytes per fixed 60 s window, on top of
 * B1.22's per-address budget. Over it the call still answers 202 but nothing is stored (the drop is counted in
 * loadSnapshot()). Every post here comes from its own address, so the per-address budget never answers.
 */

const SECRET = "b125-secret-".padEnd(48, "x");
let database: TestDatabase;
let addresses = 0;
const freshIp = () => `198.51.${Math.floor(++addresses / 250)}.${addresses % 250}`;

beforeAll(async () => {
  database = await freshDatabase();
  await seedTestPhones(database.db);
});
afterAll(async () => {
  await database.drop();
});

async function appWith(extra: Record<string, string>): Promise<{ app: FastifyInstance; advance: (ms: number) => void }> {
  let now = new Date("2026-11-12T10:00:00Z").getTime();
  const env = readEnv({ MOVERA_ENV: "staging", DATABASE_URL: database.url, JWT_SECRET: SECRET, TRUST_PROXY_HOPS: "1", ...extra });
  const app = await buildApp({ env, logger: false, db: database.db, clock: () => new Date(now) });
  return { app, advance: (ms: number) => (now += ms) };
}

const send = (app: FastifyInstance, segment: string, payload: Record<string, unknown>, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url: `/api/v1/telemetry/${segment}`, headers: { "content-type": "application/json", "x-forwarded-for": freshIp(), ...headers }, payload });

const stored = async (like: string) =>
  Number((await database.pool.query("SELECT count(*)::int AS n FROM telemetry WHERE event LIKE $1", [like])).rows[0].n);
const groups = async (message: string) =>
  Number((await database.pool.query("SELECT coalesce(sum(count), 0)::int AS n FROM error_groups WHERE message = $1", [message])).rows[0].n);
const notStored = () => ((loadSnapshot() as { telemetryNotStored?: { rows: number; bytes: number; byKind: Record<string, number> } }).telemetryNotStored ?? { rows: -1, bytes: -1, byKind: {} });

describe("B1.25: a total cap per server copy for no-token telemetry", () => {
  it("B1.25: the 4th no-token line in a minute answers 202 and is not stored", async () => {
    const { app } = await appWith({ TELEMETRY_ANON_ROWS_PER_MINUTE: "3" });
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await send(app, "logs", { level: "error", event: `cap-rows-${i}` })).statusCode);
    expect(codes).toEqual([202, 202, 202, 202]);
    expect(await stored("cap-rows-%")).toBe(3);
    await app.close();
  });

  it("B1.25: a no-token crash report over the cap makes no error group", async () => {
    const { app } = await appWith({ TELEMETRY_ANON_ROWS_PER_MINUTE: "3" });
    for (let i = 0; i < 4; i++) expect((await send(app, "crashes", { error: "CapBoom", app: "rider", platform: "android", kind: "error" })).statusCode).toBe(202);
    expect(await groups("CapBoom")).toBe(3);
    await app.close();
  });

  it("B1.25: bytes cap", async () => {
    const { app } = await appWith({ TELEMETRY_ANON_BYTES_PER_MINUTE: "4096" });
    const note = "p".repeat(1500);
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) codes.push((await send(app, "logs", { level: "info", event: `cap-bytes-${i}`, extra: { note } })).statusCode);
    expect(codes).toEqual([202, 202, 202]);
    expect(await stored("cap-bytes-%")).toBe(2);
    await app.close();
  });

  it("B1.25: signed-in lines are not counted", async () => {
    const { app } = await appWith({ TELEMETRY_ANON_ROWS_PER_MINUTE: "3" });
    const rider = await signIn(app, TEST_PHONES[0]!, "rider");
    for (let i = 0; i < 5; i++) expect((await send(app, "logs", { level: "error", event: `cap-signed-${i}` }, rider.headers)).statusCode).toBe(202);
    expect(await stored("cap-signed-%")).toBe(5);
    // The signed-in lines left the no-token total untouched: 3 no-token lines still fit.
    for (let i = 0; i < 3; i++) await send(app, "logs", { level: "error", event: `cap-after-signed-${i}` });
    expect(await stored("cap-after-signed-%")).toBe(3);
    await app.close();
  });

  it("B1.25: a new minute stores again and the drop is counted", async () => {
    const { app, advance } = await appWith({ TELEMETRY_ANON_ROWS_PER_MINUTE: "3" });
    for (let i = 0; i < 3; i++) await send(app, "analytics", { event: `cap-minute-${i}` });
    const before = notStored();
    expect((await send(app, "analytics", { event: "cap-minute-dropped" })).statusCode).toBe(202);
    const after = notStored();
    expect(after.rows).toBe(before.rows + 1);
    expect(after.bytes).toBeGreaterThan(before.bytes);
    expect(after.byKind["analytics"] ?? 0).toBe((before.byKind["analytics"] ?? 0) + 1);
    expect(await stored("cap-minute-dropped")).toBe(0);
    advance(61_000);
    expect((await send(app, "analytics", { event: "cap-minute-next" })).statusCode).toBe(202);
    expect(await stored("cap-minute-next")).toBe(1);
    await app.close();
  });
});
