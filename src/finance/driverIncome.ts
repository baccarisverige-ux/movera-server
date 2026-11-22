import { sql, type RawBuilder } from "kysely";
import type { Executor } from "../db/db.js";
import { contract } from "../contract/contract.js";
import { badRequest } from "../http/errors.js";
import { exponentOf, type CurrencyCode } from "../rules/money.js";

/**
 * v0.18.153 P29 (contract.json#driverIncomeYear; owner 2026-11-21 "Don't only save ! Execute ! Add section in admin all what
 * need and in code and everywhere" + "Also another one ( yearly but with monthly details ) and can choose with monthly and
 * daily or monthly and dayly and even all trip per day also"; EU DAC7, lag 2022:1681): what each payee (the driver's fleet,
 * else the driver) earned through the app in a year, for the owner's accountant, and the driver's own statement.
 *
 * Money comes ONLY from the earnings entries (the single money base: moneyBase, kpis.money, the kinds GET /driver/earnings
 * and GET /driver/trips use); no new formula. paid_to_movera entries are in no field. Each entry sits on the zone-local
 * day of its trip's end (else its own time), so a level is always the sum of the same entries: trips → day → month →
 * quarter → year add up by construction (the server groups once at the finest level asked and sums up in code).
 * Rule 33: bounded reads (one payee page, an index range on earnings_entries.at from migration 0132), nothing kept in the
 * server copy, so several copies give the same answer.
 */

const DI = (contract as unknown as { driverIncomeYear: { admin: { maxTripLines: number } } }).driverIncomeYear;
/** The trip-line cap (contract maxTripLines); an object so a test can lower it (SHOULD-5). */
export const incomeLimits = { maxTripLines: DI.admin.maxTripLines };
const COUNTRY_TZ = (contract as unknown as { payouts: { schedule: { countryTimeZones: Record<string, string> } } }).payouts.schedule.countryTimeZones;

export type IncomeDetail = "quarter" | "month" | "day" | "trips";
export const MONEY_FIELDS = ["grossFares", "tips", "bonuses", "adjustments", "pickupPay", "feeShare", "moveraCommission", "moveraFees", "netEarnings", "cashCollectedByDriver", "paidOutByMovera"] as const;
type MoneyField = (typeof MONEY_FIELDS)[number];
type Sums = { rides: number } & Record<MoneyField, number>;
type Money = { amountMinor: number; currency: string };

export type IncomeScope = {
  year: number;
  month?: string | undefined;
  detail: IncomeDetail;
  /** null = every zone (an all-zones admin or the driver's own statement). */
  zones: string[] | null;
  payeeId?: string | undefined;
  /** The driver's statement when he drives for a fleet he does not own: only his own entries. */
  driverId?: string | undefined;
};

/** 400 income_year_invalid / income_month_invalid / income_detail_too_big (contract driverIncomeYear.admin.errors). */
export function checkIncomeQuery(raw: { year?: string; month?: string | undefined; detail: IncomeDetail; payeeId?: string | undefined }, now: Date): { year: number; month?: string } {
  const year = /^\d{4}$/.test(raw.year ?? "") ? Number(raw.year) : NaN;
  if (!Number.isInteger(year) || year < 2020 || year > now.getUTCFullYear()) throw badRequest("Pick a year from 2020 up to this year.", "income_year_invalid");
  if (raw.month !== undefined) {
    const m = /^(\d{4})-(\d{2})$/.exec(raw.month);
    if (!m || Number(m[1]) !== year || Number(m[2]) < 1 || Number(m[2]) > 12) throw badRequest("The month must be YYYY-MM inside the year.", "income_month_invalid");
  }
  if (raw.detail === "trips" && raw.month === undefined && raw.payeeId === undefined) throw badRequest("All trips needs a month or one payee.", "income_detail_too_big");
  return raw.month === undefined ? { year } : { year, month: raw.month };
}

/** 400 unknown_country when no zone is in that country. */
export async function checkCountry(ex: Executor, country: string | undefined): Promise<void> {
  if (country === undefined) return;
  const row = await ex.selectFrom("zones").select("zone_id").where("country", "=", country).limit(1).executeTakeFirst();
  if (!row) throw badRequest("No zone is in that country.", "unknown_country");
}

const tzCase = sql.join(Object.entries(COUNTRY_TZ).map(([country, tz]) => sql`WHEN ${country} THEN ${tz}`), sql` `);

/**
 * Every money row in scope with its payee, zone and zone-local time (the rows the levels are summed from):
 * - each earnings entry at its OWN time (e.at, when it was credited; SHOULD-1, the DAC7 "paid or credited" period, the same
 *   periods as GET /driver/earnings), in the time zone of its trip's zone, else the driver's first zone, else his country;
 * - each PAID payout of the payee's drivers at its paid_at, as a row of kind payout that carries only paid_out =
 *   max(0, payouts.amount_minor) (SHOULD-2: what Movera paid out, never below 0; a payout the driver owed on pays nothing).
 * Both bounds of the time range sit on an index (earnings_at, migration 0132; payouts by paid_at is a small table).
 */
function moneyRows(scope: IncomeScope, zones: string[] | null = scope.zones): RawBuilder<unknown> {
  // The local year is at most 14 h off the UTC year: read a day more on each side, then keep the local year (below).
  const lo = new Date(Date.UTC(scope.year, 0, 1) - 86_400_000);
  const hi = new Date(Date.UTC(scope.year + 1, 0, 1) + 86_400_000);
  const zoneFilter = zones === null ? sql`` : zones.length === 0 ? sql`AND false` : sql`AND x.zone_id IN (${sql.join(zones)})`;
  const monthFilter = scope.month === undefined ? sql`` : sql`AND to_char(x.local, 'YYYY-MM') = ${scope.month}`;
  const payeeFilter = scope.payeeId === undefined ? sql`` : sql`AND x.payee_id = ${scope.payeeId}`;
  const driverFilter = scope.driverId === undefined ? sql`` : sql`AND x.driver_id = ${scope.driverId}`;
  const driverTz = sql`coalesce(zd.time_zone, CASE d.country ${tzCase} END, 'Europe/Stockholm')`;
  return sql`
    SELECT x.* FROM (
      SELECT e.entry_id, e.driver_id, e.trip_id, e.kind, e.currency,
             e.amount_minor AS amount, coalesce(e.gross_minor, 0) AS gross, coalesce(e.commission_minor, 0) AS commission, coalesce(e.cash_minor, 0) AS cash,
             CASE WHEN e.kind = 'fee_share' THEN coalesce(t.commission_minor, 0) ELSE 0 END AS movera_fee,
             0::bigint AS paid_out,
             e.at AT TIME ZONE coalesce(zt.time_zone, ${driverTz}) AS local,
             coalesce(t.zone_id, d.zone_ids[1]) AS zone_id,
             t.payment_method,
             CASE WHEN d.fleet_id IS NOT NULL THEN 'company' ELSE 'driver' END AS payee_kind,
             coalesce(d.fleet_id, d.driver_id) AS payee_id
        FROM earnings_entries e
        JOIN drivers d ON d.driver_id = e.driver_id
        LEFT JOIN trips t ON t.trip_id = e.trip_id
        LEFT JOIN zones zt ON zt.zone_id = t.zone_id
        LEFT JOIN zones zd ON zd.zone_id = d.zone_ids[1]
       WHERE e.kind <> 'paid_to_movera' AND e.at >= ${lo} AND e.at < ${hi}
      UNION ALL
      SELECT p.payout_id, p.driver_id, NULL, 'payout', p.currency,
             0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint,
             greatest(p.amount_minor, 0)::bigint,
             p.paid_at AT TIME ZONE coalesce(zp.time_zone, ${driverTz}),
             coalesce(p.zone_id, d.zone_ids[1]),
             NULL,
             CASE WHEN d.fleet_id IS NOT NULL THEN 'company' ELSE 'driver' END,
             coalesce(d.fleet_id, d.driver_id)
        FROM payouts p
        JOIN drivers d ON d.driver_id = p.driver_id
        LEFT JOIN zones zp ON zp.zone_id = p.zone_id
        LEFT JOIN zones zd ON zd.zone_id = d.zone_ids[1]
       WHERE p.status = 'paid' AND p.paid_at >= ${lo} AND p.paid_at < ${hi}
    ) x
    WHERE extract(year FROM x.local) = ${scope.year} ${monthFilter} ${zoneFilter} ${payeeFilter} ${driverFilter}`;
}

const SUMS = sql`
  count(*) FILTER (WHERE kind = 'trip') AS rides,
  coalesce(sum(gross) FILTER (WHERE kind = 'trip'), 0) AS "grossFares",
  coalesce(sum(amount) FILTER (WHERE kind = 'tip'), 0) AS tips,
  coalesce(sum(amount) FILTER (WHERE kind = 'bonus'), 0) AS bonuses,
  coalesce(sum(amount) FILTER (WHERE kind = 'adjustment'), 0) AS adjustments,
  coalesce(sum(amount) FILTER (WHERE kind = 'pickup_pay'), 0) AS "pickupPay",
  coalesce(sum(amount) FILTER (WHERE kind = 'fee_share'), 0) AS "feeShare",
  coalesce(sum(commission) FILTER (WHERE kind = 'trip'), 0) AS "moveraCommission",
  coalesce(sum(movera_fee), 0) AS "moveraFees",
  coalesce(sum(amount) FILTER (WHERE kind <> 'payout'), 0) AS "netEarnings",
  coalesce(sum(cash) FILTER (WHERE kind IN ('trip', 'tip')), 0) AS "cashCollectedByDriver",
  coalesce(sum(paid_out), 0) AS "paidOutByMovera"`;

type Group = { payee_id: string; payee_kind: "company" | "driver"; currency: string; period: string; drivers: string[]; line_key?: string | null; trip_id?: string | null; zone_id?: string | null; payment_method?: string | null; local_time?: string; has_trip?: boolean; is_payout?: boolean } & Record<string, unknown>;

const zero = (): Sums => ({ rides: 0, grossFares: 0, tips: 0, bonuses: 0, adjustments: 0, pickupPay: 0, feeShare: 0, moveraCommission: 0, moveraFees: 0, netEarnings: 0, cashCollectedByDriver: 0, paidOutByMovera: 0 });
const sumsOf = (g: Record<string, unknown>): Sums => {
  const s = zero();
  s.rides = Number(g["rides"] ?? 0);
  for (const f of MONEY_FIELDS) s[f] = Number(g[f] ?? 0);
  return s;
};
const add = (into: Sums, s: Sums) => {
  into.rides += s.rides;
  for (const f of MONEY_FIELDS) into[f] += s[f];
};
const view = (s: Sums, currency: string) => {
  const out: Record<string, number | Money> = { rides: s.rides };
  for (const f of MONEY_FIELDS) out[f] = { amountMinor: s[f], currency };
  return out;
};

/** How many trip lines the query holds (all its payees): over incomeLimits.maxTripLines is 400 income_detail_too_big. */
export async function checkTripLines(ex: Executor, scope: IncomeScope): Promise<void> {
  if (scope.detail !== "trips") return;
  const row = await sql<{ n: string }>`SELECT count(*) AS n FROM (SELECT 1 FROM (${moneyRows(scope)}) y GROUP BY payee_id, currency, to_char(local, 'YYYY-MM-DD'), coalesce(trip_id, entry_id) LIMIT ${incomeLimits.maxTripLines + 1}) c`.execute(ex);
  if (Number(row.rows[0]!.n) > incomeLimits.maxTripLines) throw badRequest(`More than ${incomeLimits.maxTripLines} trip lines: pick a month or one payee.`, "income_detail_too_big");
}

export type IncomePayee = { payeeId: string; currency: string };
const cursorOf = (p: IncomePayee) => Buffer.from(`${p.payeeId}|${p.currency}`).toString("base64url");
function readCursor(cursor: string): IncomePayee {
  const [payeeId, currency] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  if (!payeeId || !currency || !/^[A-Z]{3}$/.test(currency)) throw badRequest("The cursor is not valid.", "invalid_cursor");
  return { payeeId, currency };
}

/** One page of payee rows, ordered by payeeId then currency; a page never splits a payee row. */
export async function incomePage(ex: Executor, scope: IncomeScope, input: { cursor?: string | undefined; limit: number }): Promise<{ items: Record<string, unknown>[]; nextCursor: string | null }> {
  const after = input.cursor ? readCursor(input.cursor) : null;
  const keys = await sql<{ payee_id: string; currency: string }>`
    SELECT payee_id, currency FROM (${moneyRows(scope)}) y
     ${after ? sql`WHERE (payee_id, currency) > (${after.payeeId}, ${after.currency})` : sql``}
     GROUP BY payee_id, currency ORDER BY payee_id, currency LIMIT ${input.limit + 1}`.execute(ex);
  const page = keys.rows.slice(0, input.limit);
  const items = await incomeRows(ex, scope, page.map((k) => ({ payeeId: k.payee_id, currency: k.currency })));
  const last = page.at(-1);
  return { items, nextCursor: keys.rows.length > input.limit && last ? cursorOf({ payeeId: last.payee_id, currency: last.currency }) : null };
}

/** The payee rows of these payees (in this order), at the scope's detail level. */
export async function incomeRows(ex: Executor, scope: IncomeScope, payees: readonly IncomePayee[]): Promise<Record<string, unknown>[]> {
  if (payees.length === 0) return [];
  const ids = [...new Set(payees.map((p) => p.payeeId))];
  const level = scope.detail === "quarter" || scope.detail === "month" ? sql`to_char(local, 'YYYY-MM')` : sql`to_char(local, 'YYYY-MM-DD')`;
  const tripCols = scope.detail === "trips"
    ? sql`, coalesce(trip_id, entry_id) AS line_key, trip_id, max(zone_id) AS zone_id, max(payment_method) AS payment_method, to_char(min(local), 'YYYY-MM-DD"T"HH24:MI') AS local_time, bool_or(kind = 'trip') AS has_trip, bool_or(kind = 'payout') AS is_payout`
    : sql``;
  const tripGroup = scope.detail === "trips" ? sql`, coalesce(trip_id, entry_id), trip_id` : sql``;
  const groups = await sql<Group>`
    SELECT payee_id, max(payee_kind) AS payee_kind, currency, ${level} AS period, array_agg(DISTINCT driver_id) AS drivers ${tripCols}, ${SUMS}
      FROM (${moneyRows(scope)}) y
     WHERE payee_id IN (${sql.join(ids)})
     GROUP BY payee_id, currency, ${level} ${tripGroup}
     ORDER BY payee_id, currency, period ${scope.detail === "trips" ? sql`, local_time, line_key` : sql``}`.execute(ex);
  const info = await payeeInfo(ex, groups.rows);
  const partial = await outsideScope(ex, scope, ids);
  const wanted = new Set(payees.map((p) => `${p.payeeId}|${p.currency}`));
  const rows = new Map<string, Record<string, unknown>>();
  for (const p of payees) rows.set(`${p.payeeId}|${p.currency}`, {});
  const built = new Map<string, { kind: "company" | "driver"; drivers: Set<string>; year: Sums; quarters: Map<number, Sums>; months: Map<string, { sums: Sums; days: Map<string, { sums: Sums; trips: Record<string, unknown>[] }> }> }>();
  for (const g of groups.rows) {
    const key = `${g.payee_id}|${g.currency}`;
    if (!wanted.has(key)) continue;
    let b = built.get(key);
    if (!b) built.set(key, (b = { kind: g.payee_kind, drivers: new Set(), year: zero(), quarters: new Map(), months: new Map() }));
    for (const d of g.drivers) b.drivers.add(d);
    const s = sumsOf(g);
    const month = g.period.slice(0, 7);
    const quarter = Math.floor((Number(month.slice(5, 7)) - 1) / 3) + 1;
    add(b.year, s);
    if (!b.quarters.has(quarter)) b.quarters.set(quarter, zero());
    add(b.quarters.get(quarter)!, s);
    if (!b.months.has(month)) b.months.set(month, { sums: zero(), days: new Map() });
    const m = b.months.get(month)!;
    add(m.sums, s);
    if (g.period.length === 10) {
      if (!m.days.has(g.period)) m.days.set(g.period, { sums: zero(), trips: [] });
      const d = m.days.get(g.period)!;
      add(d.sums, s);
      if (scope.detail === "trips") d.trips.push({ localTime: g.local_time, lineKind: g.is_payout ? "payout" : g.has_trip ? "trip" : "credit", tripId: g.trip_id ?? null, zoneId: g.zone_id ?? null, paymentMethod: g.trip_id ? (g.payment_method ?? null) : null, ...view(s, g.currency) });
    }
  }
  const out: Record<string, unknown>[] = [];
  for (const p of payees) {
    const b = built.get(`${p.payeeId}|${p.currency}`);
    if (!b) continue;
    const who = info.get(p.payeeId);
    const row: Record<string, unknown> = {
      kind: b.kind,
      payeeId: p.payeeId,
      name: who?.name ?? "",
      orgNumber: who?.orgNumber ?? null,
      address: who?.address ?? null,
      country: who?.country ?? null,
      currency: p.currency,
      // Bank details are an uploaded document today (driverOnboarding.adminActions.bankType), never data: null.
      bank: null,
      driverIds: [...b.drivers].sort(),
      // SHOULD-4: a zone-limited view of a payee who also has money outside those zones in the same period.
      ...(partial.has(`${p.payeeId}|${p.currency}`) ? { partial: true } : {}),
      ...(scope.driverId !== undefined && b.kind === "company" ? { ownPartOnly: true } : {}),
      ...view(b.year, p.currency),
      quarters: [...b.quarters.entries()].sort(([a], [c]) => a - c).map(([quarter, s]) => ({ quarter, ...view(s, p.currency) })),
    };
    if (scope.detail !== "quarter") {
      row["months"] = [...b.months.entries()].sort(([a], [c]) => a.localeCompare(c)).map(([month, m]) => ({
        month,
        ...view(m.sums, p.currency),
        ...(scope.detail === "day" || scope.detail === "trips"
          ? { days: [...m.days.entries()].sort(([a], [c]) => a.localeCompare(c)).map(([day, d]) => ({ day, ...view(d.sums, p.currency), ...(scope.detail === "trips" ? { trips: d.trips } : {}) })) }
          : {}),
      }));
    }
    out.push(row);
  }
  return out;
}

/** SHOULD-4: the payees (payeeId|currency) that also have money rows outside the scope's zones in the same period. */
async function outsideScope(ex: Executor, scope: IncomeScope, ids: readonly string[]): Promise<Set<string>> {
  if (scope.zones === null || ids.length === 0) return new Set();
  const inside = scope.zones.length ? sql`x2.zone_id IN (${sql.join(scope.zones)})` : sql`false`;
  const found = await sql<{ payee_id: string; currency: string }>`
    SELECT payee_id, currency FROM (${moneyRows(scope, null)}) x2
     WHERE payee_id IN (${sql.join(ids)}) AND (x2.zone_id IS NULL OR NOT (${inside}))
     GROUP BY payee_id, currency`.execute(ex);
  return new Set(found.rows.map((r) => `${r.payee_id}|${r.currency}`));
}

/** Name, org number, address and country of each payee: the fleet's, else the driver's (no home address is stored). */
async function payeeInfo(ex: Executor, groups: readonly Group[]): Promise<Map<string, { name: string; orgNumber: string | null; address: string | null; country: string | null }>> {
  const fleetIds = [...new Set(groups.filter((g) => g.payee_kind === "company").map((g) => g.payee_id))];
  const driverIds = [...new Set(groups.filter((g) => g.payee_kind === "driver").map((g) => g.payee_id))];
  const out = new Map<string, { name: string; orgNumber: string | null; address: string | null; country: string | null }>();
  if (fleetIds.length) {
    for (const f of await ex.selectFrom("fleets").select(["fleet_id", "name", "org_number", "address", "country"]).where("fleet_id", "in", fleetIds).execute()) {
      out.set(f.fleet_id, { name: f.name, orgNumber: f.org_number || null, address: f.address || null, country: f.country || null });
    }
  }
  if (driverIds.length) {
    const rows = await ex
      .selectFrom("drivers as d")
      .leftJoin("zones as z", (j) => j.on(sql<boolean>`z.zone_id = d.zone_ids[1]`))
      .select(["d.driver_id", "d.first_name", "d.last_name", "d.country", "z.country as zone_country"])
      .where("d.driver_id", "in", driverIds)
      .execute();
    for (const d of rows) out.set(d.driver_id, { name: `${d.first_name} ${d.last_name}`.trim(), orgNumber: null, address: null, country: d.country ?? d.zone_country ?? null });
  }
  return out;
}

/** The driver's own payee: his fleet's whole row when he owns it, his own part of it when he only drives for it, else himself. */
export async function ownPayee(ex: Executor, driverId: string): Promise<{ payeeId: string; driverId?: string }> {
  const me = await ex.selectFrom("drivers as d").leftJoin("fleets as f", "f.fleet_id", "d.fleet_id").select(["d.fleet_id", "f.owner_driver_id"]).where("d.driver_id", "=", driverId).executeTakeFirst();
  if (!me?.fleet_id) return { payeeId: driverId };
  return me.owner_driver_id === driverId ? { payeeId: me.fleet_id } : { payeeId: me.fleet_id, driverId };
}

/**
 * All payees of the scope, for the CSV (in pages of `batch`), after a `first` page the caller already read (so a failure of
 * the first read is a clean error answer before any header is sent).
 */
export async function* incomeAllPages(ex: Executor, scope: IncomeScope, batch = 200, first?: { items: Record<string, unknown>[]; nextCursor: string | null }): AsyncGenerator<Record<string, unknown>[]> {
  let cursor: string | undefined;
  if (first) {
    if (first.items.length) yield first.items;
    if (!first.nextCursor) return;
    cursor = first.nextCursor;
  }
  for (;;) {
    const page = await incomePage(ex, scope, { ...(cursor ? { cursor } : {}), limit: batch });
    if (page.items.length) yield page.items;
    if (!page.nextCursor) return;
    cursor = page.nextCursor;
  }
}

/* ------------------------------------------------------------------------------------------------------------ CSV */

export const CSV_COLUMNS = ["level", "period", "payeeKind", "payeeId", "name", "orgNumber", "address", "country", "currency", "bankHolder", "bankLast4", "driverIds", "partial", "rides", ...MONEY_FIELDS, "localTime", "tripId", "zoneId", "paymentMethod", "lineKind"] as const;

/** A CSV cell: a text that could run as a spreadsheet formula (= + - @, tab, CR) gets a leading quote; quoted when needed. */
export function csvCell(value: unknown, numeric = false): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (!numeric && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const major = (minor: number, currency: string) => {
  const exp = exponentOf(currency as CurrencyCode);
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  const unit = 10 ** exp;
  return `${sign}${Math.floor(abs / unit)}.${String(abs % unit).padStart(exp, "0")}`;
};

/** The CSV lines of one payee row: year, quarters, then months → days → trips as far as the row goes. */
export function csvLines(row: Record<string, unknown>): string[] {
  const currency = row["currency"] as string;
  const bank = row["bank"] as { holder: string; last4: string } | null;
  const head = [row["kind"], row["payeeId"], row["name"], row["orgNumber"], row["address"], row["country"], currency, bank?.holder ?? "", bank?.last4 ?? "", (row["driverIds"] as string[]).join(" "), row["partial"] === true ? "true" : ""];
  const line = (level: string, period: string, t: Record<string, unknown>, trip?: Record<string, unknown>) =>
    [
      csvCell(level), csvCell(period), ...head.map((v) => csvCell(v)), csvCell(t["rides"], true),
      ...MONEY_FIELDS.map((f) => csvCell(major((t[f] as Money).amountMinor, currency), true)),
      csvCell(trip?.["localTime"] ?? ""), csvCell(trip?.["tripId"] ?? ""), csvCell(trip?.["zoneId"] ?? ""), csvCell(trip?.["paymentMethod"] ?? ""), csvCell(trip?.["lineKind"] ?? ""),
    ].join(",");
  const out = [line("year", "", row)];
  for (const q of row["quarters"] as Record<string, unknown>[]) out.push(line("quarter", `Q${q["quarter"]}`, q));
  for (const m of (row["months"] as Record<string, unknown>[] | undefined) ?? []) {
    out.push(line("month", m["month"] as string, m));
    for (const d of (m["days"] as Record<string, unknown>[] | undefined) ?? []) {
      out.push(line("day", d["day"] as string, d));
      for (const t of (d["trips"] as Record<string, unknown>[] | undefined) ?? []) out.push(line("trip", d["day"] as string, t, t));
    }
  }
  return out;
}
