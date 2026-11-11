import { Kysely, PostgresDialect } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../src/db/schema.js";
import { driverEarnings } from "../../src/trips/ride/earnings.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver } from "../support/seed.js";

/** S07 T5 (E9): GET /driver/earnings computes each period's end in its main query (no query per period). */
let database: TestDatabase;
let traced: Kysely<Database>;
let queries = 0;
const now = new Date("2026-11-11T12:00:00.000Z");
const tz = "Europe/Stockholm";

beforeAll(async () => {
  database = await freshDatabase();
  traced = new Kysely<Database>({ dialect: new PostgresDialect({ pool: database.pool }), log: (e) => void (e.level === "query" && queries++) });
  const id = await insertDriver(database.db, { driverId: "drv_e9" });
  // Days around the end of summer time (2026-10-25) and the month turns.
  const days = ["2026-09-30T22:30:00Z", "2026-10-24T10:00:00Z", "2026-10-25T00:30:00Z", "2026-10-25T23:30:00Z", "2026-10-31T23:30:00Z", "2026-11-01T10:00:00Z", "2026-11-10T08:00:00Z"];
  await database.db
    .insertInto("earnings_entries")
    .values(days.map((at, i) => ({ entry_id: `ee_${i}`, driver_id: id, trip_id: null, kind: "trip" as const, currency: "SEK", amount_minor: 10_000 + i, gross_minor: 12_000, commission_minor: 2_000, cash_minor: 0, at: new Date(at) })))
    .execute();
});
afterAll(async () => {
  await database.drop();
});

describe("driver earnings periods (S07 T5)", () => {
  it.each([
    ["day", 6],
    ["week", 4],
    ["month", 2],
  ] as const)("%s: each period ends where the next local %s starts, in two queries whatever the number of periods", async (period, count) => {
    queries = 0;
    const report = await driverEarnings(traced as never, "drv_e9", { period, from: "2026-09-01T00:00:00Z", timeZone: tz, currency: "SEK" }, now);
    expect(queries).toBe(2);
    expect(report.periods).toHaveLength(count);
    for (const p of report.periods) {
      // The query each period used to cost.
      const expected = (await database.pool.query<{ end: Date }>(`SELECT (($1::timestamptz AT TIME ZONE $2 + $3::interval) AT TIME ZONE $2) AS end`, [p.periodStart, tz, `1 ${period}`])).rows[0]!.end;
      expect(p.periodEnd).toBe(expected.toISOString());
    }
    if (period === "day") expect(report.periods.find((p) => p.periodStart === "2026-10-24T22:00:00.000Z")?.periodEnd).toBe("2026-10-25T23:00:00.000Z");
    if (period === "month")
      expect(report.periods.map((p) => [p.periodStart, p.periodEnd])).toEqual([
        ["2026-09-30T22:00:00.000Z", "2026-10-31T23:00:00.000Z"],
        ["2026-10-31T23:00:00.000Z", "2026-11-30T23:00:00.000Z"],
      ]);
  });
});
