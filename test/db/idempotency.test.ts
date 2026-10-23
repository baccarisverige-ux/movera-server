import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiError } from "../../src/http/errors.js";
import { bodyHash, canonicalJson, countIdempotencyKeys, runIdempotent, sweepIdempotencyKeys, type IdempotencyRequest } from "../../src/http/idempotency.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";

let database: TestDatabase;
beforeAll(async () => {
  database = await freshDatabase();
});
afterAll(async () => {
  await database.drop();
});

let n = 0;
const uniqueKey = () => `key-${String(++n).padStart(4, "0")}-${Math.random().toString(36).slice(2, 12)}`;
const request = (overrides: Partial<IdempotencyRequest> = {}): IdempotencyRequest => ({
  actor: "rider",
  subjectId: "rdr_1",
  key: uniqueKey(),
  method: "POST",
  route: "/api/v1/trips/trp_1/cancel",
  body: { expectedVersion: 3, reason: "changed_plans" },
  ...overrides,
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const ridersNamed = async (name: string) =>
  Number((await database.pool.query("SELECT count(*) AS n FROM riders WHERE first_name = $1", [name])).rows[0].n);

describe("canonical body", () => {
  it("ignores key order and undefined fields, keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: undefined } })).toBe('{"a":{"d":[2,1]},"b":1}');
    expect(bodyHash({ a: 1, b: 2 })).toBe(bodyHash({ b: 2, a: 1 }));
    expect(bodyHash([1, 2])).not.toBe(bodyHash([2, 1]));
    expect(bodyHash(undefined)).toBe(bodyHash(null));
  });
});

describe("runIdempotent", () => {
  it("runs once; the same request again replays the first answer", async () => {
    const req = request();
    let runs = 0;
    const work = async () => ({ status: 200, body: { run: ++runs } });
    expect(await runIdempotent(database.db, req, work)).toEqual({ status: 200, body: { run: 1 }, replayed: false });
    expect(await runIdempotent(database.db, { ...req, body: { reason: "changed_plans", expectedVersion: 3 } }, work)).toEqual({
      status: 200,
      body: { run: 1 },
      replayed: true,
    });
    expect(runs).toBe(1);
  });

  it("replays a 204 with no body", async () => {
    const req = request();
    await runIdempotent(database.db, req, async () => ({ status: 204, body: undefined }));
    expect(await runIdempotent(database.db, req, async () => ({ status: 204, body: undefined }))).toEqual({ status: 204, body: null, replayed: true });
  });

  it.each([
    ["a different body", { body: { expectedVersion: 4, reason: "changed_plans" } }],
    ["a different path", { route: "/api/v1/trips/trp_2/cancel" }],
    ["a different method", { method: "PATCH" }],
  ])("the same key with %s is 409 conflict idempotency_key_reused", async (_label, change) => {
    const req = request();
    await runIdempotent(database.db, req, async () => ({ status: 200, body: { ok: true } }));
    const error = await runIdempotent(database.db, { ...req, ...change }, async () => ({ status: 200, body: { ok: false } })).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: "conflict", status: 409, options: { reason: "idempotency_key_reused" } });
  });

  it("keys belong to their sender: another rider may use the same key", async () => {
    const req = request();
    await runIdempotent(database.db, req, async () => ({ status: 200, body: { who: "first" } }));
    const other = await runIdempotent(database.db, { ...req, subjectId: "rdr_2" }, async () => ({ status: 200, body: { who: "second" } }));
    expect(other).toEqual({ status: 200, body: { who: "second" }, replayed: false });
  });

  it("an error keeps nothing: the command's writes and the key are undone, and a retry runs again", async () => {
    const req = request();
    const before = await countIdempotencyKeys(database.db);
    const failing = runIdempotent(database.db, req, async (trx) => {
      await trx.insertInto("riders").values({ rider_id: "rdr_rolled_back", phone: "+46700000001", first_name: "rolled", email: null, language: null }).execute();
      throw new ApiError("invalid_transition", "Too late to cancel.");
    });
    await expect(failing).rejects.toMatchObject({ code: "invalid_transition" });
    expect(await countIdempotencyKeys(database.db)).toBe(before);
    expect(await ridersNamed("rolled")).toBe(0);
    expect(await runIdempotent(database.db, req, async () => ({ status: 200, body: { second: true } }))).toMatchObject({ replayed: false });
  });

  it("parallel requests with one key run the command once; the rest wait and replay", async () => {
    const req = request();
    let runs = 0;
    const work = async (trx: Parameters<Parameters<typeof runIdempotent>[2]>[0]) => {
      runs++;
      await trx.insertInto("riders").values({ rider_id: "rdr_parallel", phone: "+46700000002", first_name: "parallel", email: null, language: null }).execute();
      await sleep(150);
      return { status: 201, body: { riderId: "rdr_parallel" } };
    };
    const results = await Promise.all(Array.from({ length: 6 }, () => runIdempotent(database.db, req, work)));
    expect(runs).toBe(1);
    expect(await ridersNamed("parallel")).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    for (const result of results) expect(result).toMatchObject({ status: 201, body: { riderId: "rdr_parallel" } });
  });

  it("when the first of two parallel requests fails, the waiting one runs", async () => {
    const req = request();
    let runs = 0;
    const first = runIdempotent(database.db, req, async () => {
      runs++;
      await sleep(150);
      throw new ApiError("unavailable", "Try again.");
    });
    await sleep(30);
    const second = runIdempotent(database.db, req, async () => {
      runs++;
      return { status: 200, body: { second: true } };
    });
    await expect(first).rejects.toMatchObject({ code: "unavailable" });
    expect(await second).toEqual({ status: 200, body: { second: true }, replayed: false });
    expect(runs).toBe(2);
  });

  it.each([
    [undefined, "idempotency_key_missing"],
    ["too-short", "idempotency_key_invalid"],
    ["x".repeat(129), "idempotency_key_invalid"],
    ["has a space in it ok", "idempotency_key_invalid"],
  ])("key %s is 400 %s", async (key, reason) => {
    await expect(runIdempotent(database.db, request({ key }), async () => ({ status: 200, body: {} }))).rejects.toMatchObject({
      code: "invalid_request",
      options: { reason },
    });
  });

  it("a command that answers outside 2xx is a programming error and stores nothing", async () => {
    const req = request();
    await expect(runIdempotent(database.db, req, async () => ({ status: 409, body: {} }))).rejects.toThrow(/must answer 2xx/);
    expect(await runIdempotent(database.db, req, async () => ({ status: 200, body: {} }))).toMatchObject({ replayed: false });
  });

  it("old keys are swept", async () => {
    await runIdempotent(database.db, request(), async () => ({ status: 200, body: {} }));
    const swept = await sweepIdempotencyKeys(database.db, new Date(Date.now() + 60_000));
    expect(swept).toBeGreaterThan(0);
    expect(await countIdempotencyKeys(database.db)).toBe(0);
  });
});

