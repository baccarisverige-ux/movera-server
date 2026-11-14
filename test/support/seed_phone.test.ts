import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { freshDatabase, type TestDatabase } from "./db.js";
import { insertDriver, insertRider } from "./seed.js";

/**
 * BQ-O16 (test flake): test/cleanup/payouts.test.ts once failed with a duplicate drivers_phone_key, because the seed
 * phone came from Math.random and two drivers in one test database drew the same number. Seed phones must be
 * unique by construction (never by luck) and must not land on the fixed +4670… numbers other tests type in.
 */

let database: TestDatabase;
beforeAll(async () => {
  database = await freshDatabase();
});
afterAll(async () => database.drop());
afterEach(() => vi.restoreAllMocks());

describe("seed phones are unique per run (BQ-O16)", () => {
  it("two drivers get different phones even when Math.random repeats itself", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const a = await insertDriver(database.db);
    const b = await insertDriver(database.db);
    const phones = await database.db.selectFrom("drivers").select("phone").where("driver_id", "in", [a, b]).execute();
    expect(new Set(phones.map((p) => p.phone)).size).toBe(2);
  });

  it("two riders get different phones even when Math.random repeats itself", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const a = await insertRider(database.db);
    const b = await insertRider(database.db);
    const phones = await database.db.selectFrom("riders").select("phone").where("rider_id", "in", [a, b]).execute();
    expect(new Set(phones.map((p) => p.phone)).size).toBe(2);
  });

  it("a seeded rider never takes a fixed test number (+46701234567 is typed in by other tests)", async () => {
    await insertRider(database.db, { phone: "+46701234567" });
    // 0.026_252_6… is the Math.random value the old seed turned into +46701234567.
    vi.spyOn(Math, "random").mockReturnValue(234_567.5 / 8_999_999);
    await expect(insertRider(database.db)).resolves.toMatch(/^rdr_/);
  });

  it("many seeded drivers and riders in one database all have distinct, valid phones", async () => {
    for (let i = 0; i < 300; i++) {
      await insertDriver(database.db);
      await insertRider(database.db);
    }
    for (const table of ["drivers", "riders"] as const) {
      const rows = await database.db.selectFrom(table).select("phone").execute();
      expect(new Set(rows.map((r) => r.phone)).size).toBe(rows.length);
      for (const r of rows) expect(r.phone).toMatch(/^\+[1-9][0-9]{6,14}$/);
    }
  });
});
