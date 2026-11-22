import { refreshKeptDebts } from "../accounts/deletion.js";
import { sql } from "kysely";
import type { Principal } from "../auth/guard.js";
import { adminCoversZone } from "../auth/guard.js";
import type { Executor, Trx } from "../db/db.js";
import { ApiError, badRequest, notFound } from "../http/errors.js";
import { newId } from "../ids.js";
import { audit } from "./audit.js";
import { owedByDriver, owesLimitOf, PAID_AFTER_PAYOUT, type OwesLimit } from "../drivers/owes.js";
import { freezePayoutSummary } from "./payoutSummary.js";

/**
 * S5 J8, contract v0.18.84 debtModel.driverOwes.adminList + paidMovera (owner Q-S5-1a "Both", 2026-11-12 ~17:02):
 * the admin's list of drivers who owe Movera and the "Driver paid Movera" button (a correction entry with a reason,
 * audited; never an edit of past entries).
 */

type Money = { amountMinor: number; currency: string };
const REASON_MAX = 300;

/** The same sum as drivers/owes.ts owedByDriver, for every driver at once: unpaid entries + open payouts below 0. */
export const NET_PER_DRIVER = sql`
  SELECT driver_id, currency, sum(s)::bigint AS net FROM (
    SELECT e.driver_id, e.currency, sum(e.amount_minor - CASE WHEN e.kind IN ('trip', 'tip') THEN coalesce(e.cash_minor, 0) ELSE 0 END) AS s
      FROM earnings_entries e WHERE e.payout_id IS NULL GROUP BY e.driver_id, e.currency
    UNION ALL
    SELECT p.driver_id, p.currency, sum(p.amount_minor + ${PAID_AFTER_PAYOUT}) AS s
      FROM payouts p WHERE p.amount_minor < 0 AND p.status IN ('pending', 'pending_approval') GROUP BY p.driver_id, p.currency
  ) parts GROUP BY driver_id, currency HAVING sum(s) < 0`;

type OwingRow = { driver_id: string; currency: string; owed: string; first_name: string | null; last_name: string | null; zone_id: string | null; country: string | null; last_paid_at: Date | null };

async function owingView(ex: Executor, row: OwingRow, limits: Map<string, OwesLimit>) {
  const country = row.country;
  let limit = country ? limits.get(country) : undefined;
  if (country && limit === undefined) limits.set(country, (limit = await owesLimitOf(ex, country)));
  const max = limit?.enabled && limit.max && limit.max.currency === row.currency ? limit.max : null;
  const owed = Number(row.owed);
  return {
    driverId: row.driver_id,
    driverName: [row.first_name, row.last_name].filter(Boolean).join(" ") || row.driver_id,
    ...(row.zone_id ? { zoneId: row.zone_id } : {}),
    ...(country ? { country } : {}),
    owed: { amountMinor: owed, currency: row.currency },
    limit: max,
    overLimit: max !== null && owed >= max.amountMinor,
    ...(row.last_paid_at ? { lastPaidMoveraAt: new Date(row.last_paid_at).toISOString() } : {}),
  };
}

const LAST_PAID = sql<Date | null>`(SELECT max(x.at) FROM earnings_entries x WHERE x.driver_id = d.driver_id AND x.kind = 'paid_to_movera')`;

/**
 * GET /admin/drivers-owing: drivers with owed > 0, largest first (then driverId), one row per currency; only drivers whose
 * first zone is in the admin's (narrowed) zones. Cursor = "<owed>:<driverId>:<currency>" of the last row.
 */
export async function listOwingDrivers(ex: Executor, who: Principal, input: { cursor?: string; limit: number }) {
  const zones = who.zones.includes("*") ? null : who.zones;
  const after = input.cursor ? /^(\d+):([A-Za-z0-9_-]+):([A-Z]{3})$/.exec(input.cursor) : null;
  if (input.cursor && !after) throw badRequest("The cursor is not valid.", "invalid_cursor");
  const scope = zones === null ? sql`true` : zones.length ? sql`d.zone_ids[1] = ANY(${sql.val(zones)}::text[])` : sql`false`;
  const page = after
    ? sql`(-n.net < ${Number(after[1])} OR (-n.net = ${Number(after[1])} AND (d.driver_id, n.currency) > (${after[2]}, ${after[3]})))`
    : sql`true`;
  const rows = await sql<OwingRow>`
    SELECT d.driver_id, n.currency, (-n.net)::text AS owed, d.first_name, d.last_name, d.zone_ids[1] AS zone_id, d.country, ${LAST_PAID} AS last_paid_at
      FROM (${NET_PER_DRIVER}) n JOIN drivers d ON d.driver_id = n.driver_id
     WHERE ${scope} AND ${page}
     ORDER BY -n.net DESC, d.driver_id, n.currency
     LIMIT ${input.limit + 1}`.execute(ex);
  const total = input.cursor
    ? undefined
    : Number((await sql<{ n: string }>`SELECT count(*)::text AS n FROM (${NET_PER_DRIVER}) n JOIN drivers d ON d.driver_id = n.driver_id WHERE ${scope}`.execute(ex)).rows[0]?.n ?? 0);
  const limits = new Map<string, OwesLimit>();
  const items = [];
  for (const row of rows.rows.slice(0, input.limit)) items.push(await owingView(ex, row, limits));
  const last = rows.rows[input.limit - 1];
  return { items, nextCursor: rows.rows.length > input.limit && last ? `${last.owed}:${last.driver_id}:${last.currency}` : null, ...(total !== undefined ? { total } : {}) };
}

/** One driver's OwingDriver in one currency (the answer of paid-movera and of its 409). */
async function owingDriver(ex: Executor, driverId: string, currency: string) {
  const d = await ex.selectFrom("drivers as d").select(["d.driver_id", "d.first_name", "d.last_name", sql<string | null>`d.zone_ids[1]`.as("zone_id"), "d.country", LAST_PAID.as("last_paid_at")]).where("d.driver_id", "=", driverId).executeTakeFirstOrThrow();
  const owed = (await owedByDriver(ex, [driverId], currency)).get(driverId) ?? 0;
  return owingView(ex, { ...d, currency, owed: String(owed) } as OwingRow, new Map());
}

/** 404 driver_not_found / 403 zone_out_of_scope for a driver whose first zone is outside the admin's zones. */
export async function driverInScope(ex: Executor, who: Principal, driverId: string): Promise<void> {
  const driver = await ex.selectFrom("drivers").select("zone_ids").where("driver_id", "=", driverId).executeTakeFirst();
  if (!driver) throw notFound("No such driver.", "driver_not_found");
  const zone = driver.zone_ids[0];
  if (zone && !adminCoversZone(who, zone)) throw new ApiError("forbidden", "This zone is outside your scope.", { reason: "zone_out_of_scope" });
}

/**
 * POST /admin/drivers/{driverId}/paid-movera { expectedOwed, amount, reason }: money the driver paid Movera another way.
 * Checked under the driver row lock: a stale expectedOwed is 409 owed_changed (a second click adds nothing, owner 106
 * rule); more than owed now is 400 paid_above_owed. Writes one earnings entry kind paid_to_movera (+amount).
 */
export async function driverPaidMovera(trx: Trx, who: Principal, driverId: string, body: { expectedOwed: Money; amount: Money; reason: string }, now: Date) {
  const reason = body.reason.trim();
  if (reason.length < 1 || reason.length > REASON_MAX) throw new ApiError("invalid_request", "Write why (1 to 300 characters).", { reason: "reason_required" });
  if (body.amount.currency !== body.expectedOwed.currency) throw badRequest(`The amount is in ${body.expectedOwed.currency}.`, "currency_mismatch");
  if (!(body.amount.amountMinor > 0)) throw badRequest("The amount must be above 0.", "invalid_amount");
  const driver = await trx.selectFrom("drivers").select(["driver_id", "zone_ids"]).where("driver_id", "=", driverId).forUpdate().executeTakeFirst();
  if (!driver) throw notFound("No such driver.", "driver_not_found");
  const zone = driver.zone_ids[0] ?? null;
  if (zone && !adminCoversZone(who, zone)) throw new ApiError("forbidden", "This zone is outside your scope.", { reason: "zone_out_of_scope" });
  const currency = body.expectedOwed.currency;
  const owedBefore = (await owedByDriver(trx, [driverId], currency)).get(driverId) ?? 0;
  if (owedBefore !== body.expectedOwed.amountMinor) {
    throw new ApiError("conflict", "What the driver owes changed; check it again.", { reason: "owed_changed", projection: await owingDriver(trx, driverId, currency) });
  }
  if (body.amount.amountMinor > owedBefore) throw badRequest("That is more than the driver owes Movera.", "paid_above_owed");
  // Must-fix 2 (supervisor J8 round 1; owner Q-M3 "Next payout" + Q-S5-7 "Carry over": the negative rest carries): the
  // money settles the carried rest first. Each open payout below 0, oldest first, gets an entry LINKED to it (payout_id
  // set, so no later payout run ever takes it and pays it back to him); one it covers in full is paid. Only the part
  // above the carried rest is an unlinked entry (the next payout's paid_to_movera line, against this week's cash).
  // J8b (round 3 SF1): when a period of his has ended but its payout row is not made yet (the hourly step, or his
  // payouts are paused), that unlinked entry is taken by that period's payout when the row is made (payouts.ts
  // makePayouts), never by a later one. The payout step takes this same driver lock (lockPayoutDriver).
  // J8b: the rest of each = −amount − the money linked to it after it was made (PAID_AFTER_PAYOUT, the same as owed).
  const open = await trx.selectFrom("payouts as p").select(["p.payout_id", "p.amount_minor", "p.zone_id", PAID_AFTER_PAYOUT.as("linked")]).where("p.driver_id", "=", driverId).where("p.currency", "=", currency)
    .where("p.amount_minor", "<", "0").where("p.status", "in", ["pending", "pending_approval"]).orderBy("p.period_start").orderBy("p.payout_id").forUpdate("p").execute();
  let left = body.amount.amountMinor;
  let n = 0;
  // J8b round 2 (supervisor SF1): the audit row names the entries this payment wrote, so a later split of one of them
  // (payouts.ts, audit driver.paid_movera_split with the same entry id) is traceable back to this one payment.
  const written: { entryId: string; amountMinor: number; payoutId: string | null }[] = [];
  const entry = (amount: number, payoutId: string | null) => {
    const entryId = newId("ern", now.getTime() + n++);
    written.push({ entryId, amountMinor: amount, payoutId });
    return { entry_id: entryId, driver_id: driverId, trip_id: null, kind: "paid_to_movera" as const, currency, amount_minor: amount, gross_minor: null, commission_minor: null, cash_minor: null, payout_id: payoutId, at: now };
  };
  for (const p of open) {
    if (left <= 0) break;
    const rest = -Number(p.amount_minor) - Number(p.linked);
    if (rest <= 0) continue;
    const take = Math.min(left, rest);
    await trx.insertInto("earnings_entries").values(entry(take, p.payout_id)).execute();
    left -= take;
    if (take === rest) {
      await trx.updateTable("payouts").set({ status: "paid", paid_at: now, paid_by: who.subjectId, note: "Driver paid Movera" }).where("payout_id", "=", p.payout_id).execute();
      // Owner M26 (payoutSummary.frozenWhenPaid, "a paid payout's numbers never change"): frozen now, as Mark as paid does.
      await freezePayoutSummary(trx, { payout_id: p.payout_id, currency });
      await audit(trx, { adminId: who.subjectId, action: "payout.paid", targetType: "payout", targetId: p.payout_id, zoneId: p.zone_id, detail: { note: "Driver paid Movera", reason }, at: now });
    }
  }
  if (left > 0) await trx.insertInto("earnings_entries").values(entry(left, null)).execute();
  const owedAfter = owedBefore - body.amount.amountMinor;
  await audit(trx, { adminId: who.subjectId, action: "driver.paid_movera", targetType: "driver", targetId: driverId, zoneId: zone, detail: { amount: body.amount, owedBefore: { amountMinor: owedBefore, currency }, owedAfter: { amountMinor: owedAfter, currency }, reason, entries: written }, at: now });
  // v0.18.134 (contract.json#accountDeletion.debt): a kept debt record follows the live amount (0 = settled).
  await refreshKeptDebts(trx, "driver", driverId, now);
  return owingDriver(trx, driverId, currency);
}
