import { sql } from "kysely";
import { NET_PER_DRIVER } from "../admin/driversOwing.js";
import { liveDocument, standardKey } from "../config/service.js";
import type { Executor } from "../db/db.js";
import { ApiError } from "../http/errors.js";
import type { TimerHandler } from "../jobs/timers.js";
import { noticeLanguage, type Lang } from "../notifications/noticeLanguage.js";
import { notify } from "../notifications/service.js";
import { moneyShown } from "../rules/money.js";
import { owedByDriver } from "./owes.js";
import { DEFAULT_PAY_REQUEST as DEFAULT, isAmount, isDay, isPayLink, type Money, type PayRequestSetting } from "./payRequestSetting.js";

/**
 * Contract v0.18.139 `driverPayRequest` (owner 2026-11-20 "We are making system temporary so ask driver monthly to pay
 * how much due to Movera, so adding notification and push screen with link to pay" + "Link sumup for exp"): a TEMPORARY
 * monthly settlement. Once a month a driver who owes Movera more than the country's minimum gets a bell notice + push
 * and can open a Pay Movera screen with the amount, a reference and the admin's payment link.
 *
 * MONEY rules kept here:
 *   - the amount is always the server's owed (drivers/owes.ts, the same number as the admin owing list);
 *   - nothing is paid or confirmed by this code: the admin records a payment with "Driver paid Movera"
 *     (admin/driversOwing.ts), which lowers owed;
 *   - no payout rule changes (jobs/payouts.ts, admin/payouts.ts are not touched);
 *   - off by default in every country: while off the job asks nobody.
 */

/**
 * The country's live setting (its standard; a zone's own value is ignored). `enabled` is true only with a usable link
 * and a minimum amount in `currency` — a document that somehow lacks one is read as off (nobody is asked).
 */
export async function payRequestSettingOf(ex: Executor, country: string | null, currency: string): Promise<PayRequestSetting> {
  if (!country) return { ...DEFAULT, enabled: false };
  const set = (await liveDocument<{ driverPayRequest?: Partial<PayRequestSetting> }>(ex, "country_rules", standardKey(country)))?.document?.driverPayRequest;
  const dayOfMonth = isDay(set?.dayOfMonth) ? set.dayOfMonth : DEFAULT.dayOfMonth;
  const payLink = isPayLink(set?.payLink) ? set.payLink : "";
  const minAmount = isAmount(set?.minAmount, currency) ? { amountMinor: set.minAmount.amountMinor, currency } : null;
  return { enabled: set?.enabled === true && payLink !== "" && minAmount !== null, dayOfMonth, payLink, minAmount };
}

/** The country's currency and clock: its first zone's (as the country standard, config/service.ts). */
export async function countryHome(ex: Executor, country: string): Promise<{ currency: string; timeZone: string } | null> {
  const row = await ex.selectFrom("zones").select(["currency", "time_zone"]).where("country", "=", country).orderBy("zone_id").executeTakeFirst();
  return row ? { currency: row.currency, timeZone: row.time_zone } : null;
}

/** The wall clock of `at` in `timeZone`: "YYYY-MM", the day of the month and the hour. */
export function localMonthDay(at: Date, timeZone: string): { month: string; day: number; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { month: `${part("year")}-${part("month")}`, day: Number(part("day")), hour: Number(part("hour")) };
}

/** "<driverId>-<YYYYMM>": what the driver writes on the payment so Movera finds him and the month. */
export const payReference = (driverId: string, month: string): string => `${driverId}-${month.replace("-", "")}`;

export const PAY_MOVERA_NOTICE = {
  kind: "driver_pay_movera",
  deepLink: "movera-driver://pay-movera",
  title: { sv: "Betala Movera", fr: "Payer Movera", en: "Pay Movera" },
  body: {
    sv: "Du är skyldig Movera {amount}. Öppna för att betala.",
    fr: "Vous devez {amount} à Movera. Ouvrez pour payer.",
    en: "You owe Movera {amount}. Open to pay.",
  },
} as const;

export function payMoveraText(lang: Lang, owed: Money): { title: string; body: string } {
  return { title: PAY_MOVERA_NOTICE.title[lang], body: PAY_MOVERA_NOTICE.body[lang].replace("{amount}", moneyShown(owed)) };
}

/**
 * GET /driver/pay-movera (DriverPayMovera): what he owes now in his country's currency, the reference, and — only while
 * his country's request is on — the payment link and the minimum; his newest request if any.
 */
export async function driverPayMovera(ex: Executor, driverId: string, now: Date) {
  const driver = await ex.selectFrom("drivers").select(["country"]).where("driver_id", "=", driverId).executeTakeFirst();
  const home = driver?.country ? await countryHome(ex, driver.country) : null;
  if (!driver?.country || home === null) throw new ApiError("not_found", "No country yet.", { reason: "no_country" });
  const setting = await payRequestSettingOf(ex, driver.country, home.currency);
  const owed = (await owedByDriver(ex, [driverId], home.currency)).get(driverId) ?? 0;
  const last = await ex.selectFrom("driver_pay_requests").selectAll().where("driver_id", "=", driverId).orderBy("month", "desc").executeTakeFirst();
  return {
    enabled: setting.enabled,
    owedToMovera: { amountMinor: owed, currency: home.currency },
    reference: payReference(driverId, last?.month ?? localMonthDay(now, home.timeZone).month),
    ...(setting.enabled ? { payLink: setting.payLink, minAmount: setting.minAmount! } : {}),
    ...(last ? { request: { month: last.month, askedAt: new Date(last.asked_at).toISOString(), askedAmount: { amountMinor: Number(last.asked_minor), currency: last.currency } } } : {}),
  };
}

/* ------------------------------------------------------------------ the monthly job */

export const PAY_REQUEST_SCAN = "pay_request_scan";
const HOUR_MS = 60 * 60 * 1000;
/** Drivers asked per step; while more are left the job comes back after PAY_REQUEST_BATCH_GAP_MS (Rule 33). */
export const PAY_REQUEST_BATCH = 200;
export const PAY_REQUEST_BATCH_GAP_MS = 5_000;
/** Nobody is asked before this hour of the day (the country's clock). */
export const PAY_REQUEST_FROM_HOUR = 9;

/**
 * One step for one country: on its day (from 09:00 local) asks up to PAY_REQUEST_BATCH drivers of the country who owe
 * more than the minimum and have no request for this month. Returns true when more drivers may be left.
 * Idempotent: the request row (driver, month) is inserted first; only a NEW row writes the notice, in this transaction.
 */
export async function askCountry(ex: Executor, country: string, now: Date): Promise<boolean> {
  const home = await countryHome(ex, country);
  if (home === null) return false;
  const setting = await payRequestSettingOf(ex, country, home.currency);
  if (!setting.enabled || setting.minAmount === null) return false;
  const local = localMonthDay(now, home.timeZone);
  if (local.day !== setting.dayOfMonth || local.hour < PAY_REQUEST_FROM_HOUR) return false;
  const rows = await sql<{ driver_id: string; owed: string; language: string | null }>`
    SELECT d.driver_id, (-n.net)::text AS owed, d.language
      FROM (${NET_PER_DRIVER}) n JOIN drivers d ON d.driver_id = n.driver_id
     WHERE d.country = ${country} AND n.currency = ${home.currency} AND -n.net > ${setting.minAmount.amountMinor}
       AND NOT EXISTS (SELECT 1 FROM driver_pay_requests r WHERE r.driver_id = d.driver_id AND r.month = ${local.month})
     ORDER BY d.driver_id
     LIMIT ${PAY_REQUEST_BATCH + 1}`.execute(ex);
  for (const row of rows.rows.slice(0, PAY_REQUEST_BATCH)) {
    const owed = { amountMinor: Number(row.owed), currency: home.currency };
    const made = await ex
      .insertInto("driver_pay_requests")
      .values({ driver_id: row.driver_id, month: local.month, currency: home.currency, asked_minor: owed.amountMinor, asked_at: now })
      .onConflict((conflict) => conflict.columns(["driver_id", "month"]).doNothing())
      .returning("driver_id")
      .executeTakeFirst();
    if (made === undefined) continue; // another copy asked him in the meantime
    const lang = await noticeLanguage(ex, { actor: "driver", id: row.driver_id, language: row.language });
    await notify(ex, { audience: "driver", subjectId: row.driver_id, kind: PAY_MOVERA_NOTICE.kind, ...payMoveraText(lang, owed), deepLink: PAY_MOVERA_NOTICE.deepLink, data: { month: local.month, amountMinor: owed.amountMinor, currency: owed.currency } }, now);
  }
  return rows.rows.length > PAY_REQUEST_BATCH;
}

/** The hourly job: every country in turn; books itself again (5 s while a backlog is left, else an hour). */
export const payRequestScanHandler: TimerHandler = async (trx, timer) => {
  const now = timer.firedAt;
  const countries = await trx.selectFrom("zones").select("country").distinct().orderBy("country").execute();
  let more = false;
  for (const { country } of countries) more = (await askCountry(trx, country, now)) || more;
  await trx
    .insertInto("timers")
    .values({ kind: PAY_REQUEST_SCAN, ref_id: "all", due_at: new Date(now.getTime() + (more ? PAY_REQUEST_BATCH_GAP_MS : HOUR_MS)), payload: "{}" })
    .onConflict((conflict) => conflict.columns(["kind", "ref_id"]).doNothing())
    .execute();
};

/** Books the job if it is not booked yet (every copy calls this at start; one row wins). */
export async function ensurePayRequestTimer(ex: Executor, now: Date = new Date()): Promise<void> {
  await ex
    .insertInto("timers")
    .values({ kind: PAY_REQUEST_SCAN, ref_id: "all", due_at: now })
    .onConflict((conflict) => conflict.columns(["kind", "ref_id"]).doNothing())
    .execute();
}

export const payRequestHandlers: Record<string, TimerHandler> = { [PAY_REQUEST_SCAN]: payRequestScanHandler };
