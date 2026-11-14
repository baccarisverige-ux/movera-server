import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { countDay } from "../../src/admin/kpis.js";
import { resumStoredKpiDays, runKpiResum } from "../../src/admin/kpiResum.js";
import { commissionOf } from "../../src/rules/commission.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver, insertRider, insertTrip } from "../support/seed.js";

/**
 * S5 J5 (owner 107 "Yes, count + fix old days (Rec.)", contract.json#moneyBase.kpiMoney: "Stored days are re-summed once
 * from the trips after the server change (summary rows only; trip data is never changed)"): the one-off re-sum rewrites
 * only the stored kpi_days rows, reports before/after totals, adds no new day, changes no trip and is safe to run again.
 */

let database: TestDatabase;
let driverId: string;
let riderId: string;
const now = new Date("2026-10-28T10:00:00Z");
const SE = { zone_id: "Z001", time_zone: "Europe/Stockholm", currency: "SEK" };

/** A stored day as the code before v0.18.82 wrote it (the debt line in gross, the rider early end left out). */
const OLD_26 = { gross: 31_800, commission: 1_795, earnings: 6_005, movera: 1_795 };

beforeAll(async () => {
  database = await freshDatabase();
  riderId = await insertRider(database.db);
  driverId = await insertDriver(database.db);
  const lines = [{ code: "base", amount: { amountMinor: 7_800, currency: "SEK" } }, { code: "outstanding_fee", amount: { amountMinor: 24_000, currency: "SEK" } }];
  const a = await insertTrip(database.db, riderId, { status: "completed", driverId });
  await database.db.updateTable("trips").set({ zone_id: "Z001", fare_minor: 31_800, fare_lines: JSON.stringify(lines), driver_earnings_minor: 6_005, commission_minor: commissionOf(31_800, lines, 6_005, 0, 0), ended_at: new Date("2026-10-26T09:00:00Z"), payment_status: "captured" }).where("trip_id", "=", a).execute();
  const b = await insertTrip(database.db, riderId, { status: "cancelled_by_rider", driverId });
  await database.db.updateTable("trips").set({ zone_id: "Z001", fare_minor: 6_000, fare_lines: JSON.stringify([{ code: "base", amount: { amountMinor: 6_000, currency: "SEK" } }]), driver_earnings_minor: 4_500, commission_minor: 1_500, ended_at: new Date("2026-10-26T10:00:00Z"), payment_status: "captured" }).where("trip_id", "=", b).execute();
  for (const [tripId, amount] of [[a, 6_005], [b, 4_500]] as const) {
    await database.db.insertInto("earnings_entries").values({ entry_id: `ern_rs_${tripId}`, driver_id: driverId, trip_id: tripId, kind: "trip", currency: "SEK", amount_minor: amount, gross_minor: null, commission_minor: null, cash_minor: null, at: now }).execute();
  }
  const zeros = { currency: "SEK", completed_trips: 0, cancelled_trips: 0, no_shows: 0, gross_minor: 0, commission_minor: 0, driver_earnings_minor: 0, pickup_pay_minor: 0, driver_bonus_minor: 0, cash_collected_minor: 0, wallet_applied_minor: 0, new_riders: 0, new_drivers: 0, tips_minor: 0, refunds_minor: 0, fees_minor: 0, movera_earnings_minor: 0, computed_at: now };
  await database.db.insertInto("kpi_days").values([
    { ...zeros, zone_id: "Z001", day: "2026-10-26", completed_trips: 1, cancelled_trips: 1, new_riders: 1, gross_minor: OLD_26.gross, commission_minor: OLD_26.commission, driver_earnings_minor: OLD_26.earnings, movera_earnings_minor: OLD_26.movera },
    { ...zeros, zone_id: "Z001", day: "2026-10-27" },
  ]).execute();
});
afterAll(async () => database.drop());

const tripsNow = () => database.db.selectFrom("trips").selectAll().orderBy("trip_id").execute();

const storedRows = () => database.db.selectFrom("kpi_days").selectAll().orderBy("zone_id").orderBy("day").execute();

describe("S5 J5: one-off re-sum of the stored KPI days (owner 107)", () => {
  it("a dry run (kpi-resum --dry-run) reports the same before/after and writes nothing (J5 supervisor S3/S5)", async () => {
    const rowsBefore = JSON.stringify(await storedRows());
    const tripsBefore = JSON.stringify(await tripsNow());
    const dry = await runKpiResum(database.db, now, true);
    expect(dry.changed).toBe(1);
    expect(dry.before[0]).toMatchObject({ gross: OLD_26.gross, moveraEarnings: OLD_26.movera });
    expect(dry.after[0]).toMatchObject({ gross: 7_800 + 6_000, driverEarnings: 6_005 + 4_500 });
    expect(JSON.stringify(await storedRows())).toBe(rowsBefore);
    expect(JSON.stringify(await tripsNow())).toBe(tripsBefore);
  });

  it("rewrites only the stored rows from the trips, with before/after totals; trips untouched; no new day", async () => {
    const tripsBefore = JSON.stringify(await tripsNow());
    const right = await countDay(database.db, SE, "2026-10-26");
    const result = await database.db.transaction().execute((trx) => resumStoredKpiDays(trx, now));
    expect(result.rows).toBe(2);
    expect(result.changed).toBe(1);
    expect(result.before).toEqual([{ currency: "SEK", rows: 2, gross: OLD_26.gross, commission: OLD_26.commission, moveraEarnings: OLD_26.movera, driverEarnings: OLD_26.earnings, pickupPay: 0, driverBonus: 0 }]);
    expect(result.after).toEqual([{ currency: "SEK", rows: 2, gross: 7_800 + 6_000, commission: 1_795 + 1_500, moveraEarnings: 1_795 + 1_500, driverEarnings: 6_005 + 4_500, pickupPay: 0, driverBonus: 0 }]);
    const stored = await database.db.selectFrom("kpi_days").select(["gross_minor", "commission_minor", "driver_earnings_minor", "movera_earnings_minor"]).where("zone_id", "=", "Z001").where("day", "=", "2026-10-26").executeTakeFirstOrThrow();
    expect([stored.gross_minor, stored.commission_minor, stored.driver_earnings_minor, stored.movera_earnings_minor].map(Number)).toEqual([right.gross, right.commission, right.driverEarnings, right.moveraEarnings]);
    expect((await database.db.selectFrom("kpi_days").select("zone_id").execute()).length).toBe(2);
    expect(JSON.stringify(await tripsNow())).toBe(tripsBefore);
  });

  it("is safe to run again: nothing changes the second time", async () => {
    const again = await database.db.transaction().execute((trx) => resumStoredKpiDays(trx, now));
    expect(again.changed).toBe(0);
    expect(again.after).toEqual(again.before);
  });
});
