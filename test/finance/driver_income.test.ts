import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { seedDriver } from "../../src/drivers/service.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { adminSession } from "../support/admin.js";
import { insertDriver, insertRider, insertTrip } from "../support/seed.js";
import { signIn, testWorld } from "../support/world.js";

/**
 * v0.18.153 P29 (contract.json#driverIncomeYear; owner 2026-11-21 "Don't only save ! Execute ! Add section in admin all what
 * need and in code and everywhere" + "Also another one ( yearly but with monthly details ) and can choose with monthly and
 * daily or monthly and dayly and even all trip per day also"; EU DAC7): the yearly income per payee (the driver's fleet,
 * else the driver) for the accountant, and the driver's own year statement. Fake values only (no real ID numbers).
 */

let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-03-01T10:00:00Z") };
let finance: Record<string, string>;
let franceOnly: Record<string, string>;
let support: Record<string, string>;
let financeId: string;
const ids = { fleet: "flt_inc_test1", d1: "", d2: "", d3: "", d4: "", t1: "", t2: "", t3: "", t4: "", t5: "", t6: "", t7: "" };
const drv: Record<string, Record<string, string>> = {};
let n = 0;

const get = (url: string, headers: Record<string, string>) => app.inject({ method: "GET", url: `/api/v1${url}`, headers });
type Kind = "trip" | "pickup_pay" | "fee_share" | "adjustment" | "tip" | "bonus" | "paid_to_movera";
const entry = (driverId: string, tripId: string | null, kind: Kind, currency: string, amount: number, extra: { gross?: number; commission?: number; cash?: number; at: string; payoutId?: string }) =>
  database.db.insertInto("earnings_entries").values({
    entry_id: `ern_inc_${++n}`, driver_id: driverId, trip_id: tripId, kind, currency, amount_minor: amount,
    gross_minor: extra.gross ?? null, commission_minor: extra.commission ?? null, cash_minor: extra.cash ?? null, at: new Date(extra.at), payout_id: extra.payoutId ?? null,
  }).execute();
async function trip(driverId: string, m: { zone: string; currency: string; method: string; endedAt: string; status?: string; commission?: number }) {
  const rider = await insertRider(database.db);
  const id = await insertTrip(database.db, rider, { status: m.status ?? "completed", driverId });
  await database.db.updateTable("trips").set({ zone_id: m.zone, currency: m.currency, payment_method: m.method, ended_at: new Date(m.endedAt), ...(m.commission !== undefined ? { commission_minor: m.commission } : {}) }).where("trip_id", "=", id).execute();
  return id;
}
type Totals = Record<string, number> & { rides: number };
const FIELDS = ["grossFares", "tips", "bonuses", "adjustments", "pickupPay", "feeShare", "moveraCommission", "moveraFees", "netEarnings", "cashCollectedByDriver", "paidOutByMovera"];
const flat = (o: Record<string, unknown>): Totals => {
  const out: Record<string, number> = { rides: o["rides"] as number };
  for (const f of FIELDS) out[f] = (o[f] as { amountMinor: number }).amountMinor;
  return out as Totals;
};
const sum = (list: Record<string, unknown>[]): Totals => {
  const out: Record<string, number> = { rides: 0 };
  for (const f of FIELDS) out[f] = 0;
  for (const x of list) {
    const t = flat(x);
    for (const k of Object.keys(out)) out[k]! += t[k]!;
  }
  return out as Totals;
};
type Row = Record<string, unknown> & { payeeId: string; currency: string; quarters: Record<string, unknown>[]; months?: (Record<string, unknown> & { month: string; days?: (Record<string, unknown> & { day: string; trips?: (Record<string, unknown> & { tripId: string | null })[] })[] })[] };
async function page(query: string, headers = finance): Promise<{ items: Row[]; nextCursor: string | null; year: number; detail: string }> {
  const res = await get(`/admin/finance/driver-income?${query}`, headers);
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}
const rowOf = (items: Row[], payeeId: string, currency = "SEK") => items.find((r) => r.payeeId === payeeId && r.currency === currency)!;

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  const fin = await adminSession(app, database.db, "finance", { now: clock.now });
  finance = fin.headers;
  financeId = fin.adminId;
  franceOnly = (await adminSession(app, database.db, "finance", { zoneIds: ["FR-PC"], now: clock.now })).headers;
  support = (await adminSession(app, database.db, "support", { now: clock.now })).headers;
  // D1 owns the fleet (a company), D2 drives for it, D3 drives alone (Sweden), D4 alone in France (EUR).
  for (const [key, i] of [["d1", 1], ["d2", 2], ["d3", 3]] as const) {
    const made = await database.db.transaction().execute((trx) =>
      seedDriver(trx, { phone: TEST_PHONES[i]!, firstName: `Inc${i}`, make: "Volvo", model: "V60", year: 2021, color: "Black", plate: `INC00${i}`, categoryIds: ["economy"], zoneIds: ["Z001"] }, clock.now));
    ids[key] = made.driverId;
  }
  ids.d4 = await insertDriver(database.db);
  await database.db.updateTable("drivers").set({ zone_ids: ["FR-PC"], country: "FR", first_name: "Inc4", last_name: "Paris" }).where("driver_id", "=", ids.d4).execute();
  await database.db.updateTable("drivers").set({ country: "SE", last_name: "Test" }).where("driver_id", "in", [ids.d1, ids.d2, ids.d3]).execute();
  await database.db.insertInto("fleets").values({ fleet_id: ids.fleet, owner_driver_id: ids.d1, name: "=Test Taxi AB", org_number: "000000-0000", address: "Testgatan 1, 111 11 Teststad", country: "SE", city_id: "stockholm", zone_id: "Z001", status: "approved", created_at: clock.now, updated_at: clock.now }).execute();
  await database.db.updateTable("drivers").set({ fleet_id: ids.fleet }).where("driver_id", "in", [ids.d1, ids.d2]).execute();
  // A paid payout (D2's January cash trip is in it).
  await database.db.insertInto("payouts").values({ payout_id: "pay_inc_1", driver_id: ids.d2, zone_id: "Z001", currency: "SEK", amount_minor: -2000, lines: "[]", trip_count: 1, source: "manual", status: "paid", period_start: new Date("2025-01-13T00:00:00Z"), period_end: new Date("2025-01-20T00:00:00Z"), note: null, created_by: null, created_at: new Date("2025-01-20T08:00:00Z"), paid_at: new Date("2025-01-21T08:00:00Z") }).execute();

  // t1: D1, card, ends 2025-03-31 22:30 UTC = 2025-04-01 00:30 in Stockholm → Q2, April.
  ids.t1 = await trip(ids.d1, { zone: "Z001", currency: "SEK", method: "card", endedAt: "2025-03-31T22:30:00Z" });
  await entry(ids.d1, ids.t1, "trip", "SEK", 16_000, { gross: 20_000, commission: 4_000, cash: 0, at: "2025-03-31T22:30:00Z" });
  await entry(ids.d1, ids.t1, "tip", "SEK", 1_000, { cash: 0, at: "2025-03-31T22:35:00Z" });
  // t2: D2, pay in the car (cash), 2025-01-15, in the paid payout.
  ids.t2 = await trip(ids.d2, { zone: "Z001", currency: "SEK", method: "cash", endedAt: "2025-01-15T10:00:00Z" });
  await entry(ids.d2, ids.t2, "trip", "SEK", 8_000, { gross: 10_000, commission: 2_000, cash: 10_000, at: "2025-01-15T10:00:00Z", payoutId: "pay_inc_1" });
  // t3: D3, cash, ends 2025-12-31 23:30 UTC = 2026-01-01 00:30 in Stockholm → NOT in 2025.
  ids.t3 = await trip(ids.d3, { zone: "Z001", currency: "SEK", method: "cash", endedAt: "2025-12-31T23:30:00Z" });
  await entry(ids.d3, ids.t3, "trip", "SEK", 9_000, { gross: 11_000, commission: 2_000, cash: 11_000, at: "2025-12-31T23:30:00Z" });
  // t4: D3, cash, ends 2024-12-31 23:30 UTC = 2025-01-01 00:30 → in 2025 (Q1, 1 January), pickup pay, a later tip and a pay change.
  ids.t4 = await trip(ids.d3, { zone: "Z001", currency: "SEK", method: "cash", endedAt: "2024-12-31T23:30:00Z" });
  await entry(ids.d3, ids.t4, "trip", "SEK", 12_000, { gross: 15_000, commission: 3_000, cash: 15_000, at: "2024-12-31T23:30:00Z" });
  await entry(ids.d3, ids.t4, "pickup_pay", "SEK", 500, { at: "2024-12-31T23:30:00Z" });
  await entry(ids.d3, ids.t4, "tip", "SEK", 700, { cash: 700, at: "2025-01-02T09:00:00Z" });
  await entry(ids.d3, ids.t4, "adjustment", "SEK", -300, { at: "2025-02-10T09:00:00Z" });
  // t6: D3's no-show fee share (Movera's share 32,50 kr is the fee trip's commission), 2025-05-05.
  ids.t6 = await trip(ids.d3, { zone: "Z001", currency: "SEK", method: "cash", endedAt: "2025-05-05T08:00:00Z", status: "no_show", commission: 3_250 });
  await entry(ids.d3, ids.t6, "fee_share", "SEK", 3_250, { at: "2025-05-05T08:00:00Z" });
  // A bonus campaign award (no trip), 2025-06-10, and money D3 paid Movera (in no field).
  await entry(ids.d3, null, "bonus", "SEK", 5_000, { at: "2025-06-10T10:00:00Z" });
  await entry(ids.d3, null, "paid_to_movera", "SEK", 99_999, { at: "2025-06-11T10:00:00Z" });
  // t5: D4, Paris, EUR, 2025-07-01.
  ids.t5 = await trip(ids.d4, { zone: "FR-PC", currency: "EUR", method: "card", endedAt: "2025-07-01T12:00:00Z" });
  await entry(ids.d4, ids.t5, "trip", "EUR", 2_400, { gross: 3_000, commission: 600, cash: 0, at: "2025-07-01T12:00:00Z" });
  // t7: D3 in 2024 (another year): never in 2025.
  ids.t7 = await trip(ids.d3, { zone: "Z001", currency: "SEK", method: "cash", endedAt: "2024-06-01T10:00:00Z" });
  await entry(ids.d3, ids.t7, "trip", "SEK", 1_000, { gross: 1_200, commission: 200, cash: 1_200, at: "2024-06-01T10:00:00Z" });
  for (const [key, i] of [["d1", 1], ["d2", 2], ["d3", 3]] as const) drv[key] = (await signIn(app, TEST_PHONES[i]!, "driver")).headers;
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

describe("v0.18.153 GET /admin/finance/driver-income (driverIncomeYear)", () => {
  it("one row per payee: the fleet with its two drivers is ONE company row; a driver alone is his own row; quarters are zone-local by trip end", async () => {
    const body = await page("year=2025");
    expect(body.detail).toBe("quarter");
    const company = rowOf(body.items, ids.fleet);
    expect(company).toMatchObject({ kind: "company", name: "=Test Taxi AB", orgNumber: "000000-0000", address: "Testgatan 1, 111 11 Teststad", country: "SE", currency: "SEK", bank: null });
    expect([...(company["driverIds"] as string[])].sort()).toEqual([ids.d1, ids.d2].sort());
    expect(flat(company)).toMatchObject({ rides: 2, grossFares: 30_000, tips: 1_000, moveraCommission: 6_000, netEarnings: 25_000, cashCollectedByDriver: 10_000 });
    // t2 (January) is Q1, t1 (00:30 on 1 April in Stockholm, still 31 March in UTC) is Q2.
    expect(company.quarters.map((q) => [q["quarter"], q["rides"]])).toEqual([[1, 1], [2, 1]]);
    const alone = rowOf(body.items, ids.d3);
    expect(alone).toMatchObject({ kind: "driver", name: "Inc3 Test", orgNumber: null, address: null, country: "SE", driverIds: [ids.d3] });
    expect(body.items.filter((r) => r.payeeId === ids.d1 || r.payeeId === ids.d2)).toEqual([]);
  });

  it("pay in the car (cash) rides count; the 1 January 00:30 trip is in, the 31 December 00:30-next-day trip is out; paid_to_movera is in no field", async () => {
    const d3 = rowOf((await page("year=2025")).items, ids.d3);
    // t4 (cash) only: t3 is 2026-01-01 local, t7 is 2024.
    expect(flat(d3)).toEqual({
      rides: 1, grossFares: 15_000, tips: 700, bonuses: 5_000, adjustments: -300, pickupPay: 500, feeShare: 3_250, moveraCommission: 3_000, moveraFees: 3_250,
      netEarnings: 12_000 + 500 + 700 - 300 + 3_250 + 5_000, cashCollectedByDriver: 15_700, paidOutByMovera: 0,
    });
    const next = rowOf((await page("year=2026")).items, ids.d3);
    expect(flat(next)).toMatchObject({ rides: 1, grossFares: 11_000, cashCollectedByDriver: 11_000 });
  });

  it("paidOutByMovera = amount − cash of the entries in a paid payout (D2's cash trip: 80 − 100 kr)", async () => {
    const company = rowOf((await page("year=2025")).items, ids.fleet);
    expect(flat(company).paidOutByMovera).toBe(-2_000);
  });

  it("month and day details: months[] then days[]; the levels add up trips → day → month → quarter → year for every field", async () => {
    const months = rowOf((await page("year=2025&detail=month")).items, ids.d3);
    // The later tip (2 January) and pay change (10 February) of t4 sit on t4's end day (1 January): by trip end time.
    expect(months.months!.map((m) => m.month)).toEqual(["2025-01", "2025-05", "2025-06"]);
    expect(months.months![0]!["days"]).toBeUndefined();
    const days = rowOf((await page("year=2025&detail=day")).items, ids.d3);
    expect(days.months![0]!.days!.map((d) => d.day)).toEqual(["2025-01-01"]);
    const trips = rowOf((await page(`year=2025&detail=trips&payeeId=${ids.d3}`)).items, ids.d3);
    const year = flat(trips);
    expect(sum(trips.quarters)).toEqual(year);
    expect(sum(trips.months!)).toEqual(year);
    for (const m of trips.months!) {
      expect(sum(m.days!)).toEqual(flat(m));
      for (const d of m.days!) expect(sum(d.trips!)).toEqual(flat(d));
    }
    const jan1 = trips.months![0]!.days![0]!.trips!;
    expect(jan1).toHaveLength(1);
    expect(jan1[0]).toMatchObject({ tripId: ids.t4, zoneId: "Z001", paymentMethod: "cash", localTime: "2025-01-01T00:30" });
    // The campaign award has no trip: a line of its own.
    const june = trips.months!.find((m) => m.month === "2025-06")!.days![0]!.trips!;
    expect(june[0]).toMatchObject({ tripId: null, paymentMethod: null });
    expect(flat(june[0]!).bonuses).toBe(5_000);
  });

  it("with month only that month is counted", async () => {
    const body = await page("year=2025&detail=trips&month=2025-01");
    expect(body.items.map((r) => r.payeeId).sort()).toEqual([ids.d3, ids.fleet].sort());
    expect(flat(rowOf(body.items, ids.fleet)).rides).toBe(1);
  });

  it("never adds across currencies: the Paris driver is an EUR row of his own", async () => {
    const body = await page("year=2025");
    expect(flat(rowOf(body.items, ids.d4, "EUR"))).toMatchObject({ rides: 1, grossFares: 3_000, netEarnings: 2_400 });
    expect(rowOf(body.items, ids.d4, "SEK")).toBeUndefined();
  });

  it("zone scope as adminListFilters: a France-only admin sees only France; naming a Swedish zone is 403 zone_out_of_scope; country filter", async () => {
    expect((await page("year=2025", franceOnly)).items.map((r) => r.payeeId)).toEqual([ids.d4]);
    const res = await get("/admin/finance/driver-income?year=2025&zoneIds=Z001", franceOnly);
    expect(res.statusCode).toBe(403);
    expect(res.json().reason).toBe("zone_out_of_scope");
    expect((await page("year=2025&country=FR")).items.map((r) => r.payeeId)).toEqual([ids.d4]);
    expect((await get("/admin/finance/driver-income?year=2025", support)).statusCode).toBe(403);
  });

  it("400s: trips detail without month or payeeId is income_detail_too_big; bad / future year; month outside the year; unknown country; unknown key", async () => {
    const reason = async (q: string) => {
      const res = await get(`/admin/finance/driver-income?${q}`, finance);
      expect(res.statusCode, res.body).toBe(400);
      return res.json().reason;
    };
    expect(await reason("year=2025&detail=trips")).toBe("income_detail_too_big");
    expect(await reason("year=2027")).toBe("income_year_invalid");
    expect(await reason("year=19")).toBe("income_year_invalid");
    expect(await reason("year=2025&month=2024-03")).toBe("income_month_invalid");
    expect(await reason("year=2025&country=XX")).toBe("unknown_country");
    expect(await reason("year=2025&colour=red")).toBe("unknown_filter");
    expect(await reason("year=2025&detail=week")).toBe("invalid_body");
  });

  it("cursor paging never splits a payee row and walks every row once", async () => {
    const first = await page("year=2025&limit=1");
    expect(first.items).toHaveLength(1);
    const seen = [...first.items.map((r) => `${r.payeeId}:${r.currency}`)];
    let cursor = first.nextCursor;
    while (cursor) {
      const next = await page(`year=2025&limit=1&cursor=${encodeURIComponent(cursor)}`);
      seen.push(...next.items.map((r) => `${r.payeeId}:${r.currency}`));
      cursor = next.nextCursor;
    }
    expect(seen.sort()).toEqual([`${ids.d3}:SEK`, `${ids.d4}:EUR`, `${ids.fleet}:SEK`].sort());
  });

  it("every JSON download writes one audit row with its detail level", async () => {
    await page("year=2025&detail=day");
    const rows = await database.db.selectFrom("admin_audit").select(["action", "target_type", "target_id", "detail"]).where("admin_id", "=", financeId).where("action", "=", "finance.driver_income.read").execute();
    const last = rows.at(-1)!;
    expect(last).toMatchObject({ target_type: "driver_income", target_id: "2025" });
    expect(last.detail).toMatchObject({ year: 2025, detail: "day", format: "json" });
  });
});

describe("v0.18.153 GET /admin/finance/driver-income.csv", () => {
  it("the accountant's file: BOM, header, one line per payee and level, formula cells guarded, audited", async () => {
    const res = await get("/admin/finance/driver-income.csv?year=2025&detail=month", finance);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/csv; charset=utf-8/);
    expect(res.headers["content-disposition"]).toBe('attachment; filename="movera-driver-income-2025-month.csv"');
    expect(res.body.startsWith("﻿level,period,payeeKind,payeeId,name,")).toBe(true);
    const lines = res.body.slice(1).split("\r\n").filter(Boolean);
    const company = lines.filter((l) => l.includes(ids.fleet));
    // The fleet name "=Test Taxi AB" gets a leading quote, so a spreadsheet never runs it.
    expect(company[0]).toContain(`,'=Test Taxi AB,`);
    expect(company.map((l) => l.split(",")[0])).toEqual(["year", "quarter", "quarter", "month", "month"]);
    expect(company[0]).toContain(",300.00,");
    const audit = await database.db.selectFrom("admin_audit").select(["detail"]).where("admin_id", "=", financeId).where("action", "=", "finance.driver_income.csv").execute();
    expect(audit.at(-1)!.detail).toMatchObject({ year: 2025, detail: "month", format: "csv" });
  });

  it("the same too-big rule", async () => {
    expect((await get("/admin/finance/driver-income.csv?year=2025&detail=trips", finance)).json().reason).toBe("income_detail_too_big");
  });
});

describe("v0.18.153 GET /driver/income-statement", () => {
  it("a driver alone sees only his own row", async () => {
    const res = await get("/driver/income-statement?year=2025", drv["d3"]!);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.detail).toBe("month");
    expect(body.items.map((r: Row) => r.payeeId)).toEqual([ids.d3]);
    expect(flat(body.items[0]).netEarnings).toBe(21_150);
  });

  it("the fleet owner sees the fleet's row (what is reported); another fleet driver only his own money (ownPartOnly)", async () => {
    const owner = (await get("/driver/income-statement?year=2025", drv["d1"]!)).json();
    expect(owner.items).toHaveLength(1);
    expect(owner.items[0]).toMatchObject({ kind: "company", payeeId: ids.fleet });
    expect(owner.items[0].ownPartOnly).toBeUndefined();
    expect(flat(owner.items[0]).rides).toBe(2);
    const other = (await get("/driver/income-statement?year=2025&detail=trips&month=2025-01", drv["d2"]!)).json();
    expect(other.items[0]).toMatchObject({ kind: "company", payeeId: ids.fleet, ownPartOnly: true, driverIds: [ids.d2] });
    expect(flat(other.items[0])).toMatchObject({ rides: 1, grossFares: 10_000 });
    const none = (await get("/driver/income-statement?year=2025&detail=trips&month=2025-04", drv["d2"]!)).json();
    expect(none.items).toEqual([]);
  });

  it("trips detail needs a month; no quarter detail for the driver", async () => {
    expect((await get("/driver/income-statement?year=2025&detail=trips", drv["d3"]!)).json().reason).toBe("income_detail_too_big");
    expect((await get("/driver/income-statement?year=2025&detail=quarter", drv["d3"]!)).statusCode).toBe(400);
  });
});
