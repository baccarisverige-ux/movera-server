import { contract } from "../contract/contract.js";
import { schemaProblem } from "../contract/schemas.js";
import { liveDocument } from "../config/service.js";
import type { Executor, Trx } from "../db/db.js";
import { appendTripEvent, lockTrip, type TripRow } from "../db/tripLog.js";
import { ApiError, badRequest } from "../http/errors.js";
import { adminCoversZone, type Principal } from "../auth/guard.js";
import { audit } from "../admin/audit.js";
import { notify } from "../notifications/service.js";
import { debtOf } from "../rules/commission.js";
import { lockOwnTrip, readOwnTrip, touchTrip } from "./commands.js";
import { driverTotalOf, endInfoOf, tripProjection } from "./projection.js";
import { credit } from "./ride.js";

/**
 * v0.18.10 (driver group 8 "Finish & cash", contract.json#finish, CONTRACT.md §36): which payment methods a zone offers
 * and the server takes, the rider's tip (100 % to the driver), receipts and their resend, the admin's change of the
 * driver's pay on a trip.
 */

type Money = { amountMinor: number; currency: string };

const C = contract as unknown as {
  zonePaymentMethods: { values: string[] };
  configDefaults: { driverPayChangeMax: Record<string, Money>; countries: Record<string, { tips?: Money[] }>; tipRules: { cashAfterTrip: boolean; cashInCarMinutes: number; customAmount: boolean; customMax: Record<string, Money> } };
  finish: { receipt: { texts: Record<string, Record<string, string>> }; driverMoney: { texts: Record<string, Record<string, string>> } };
};
/** The methods a country may offer at all (cash, card, apple_pay; no google_pay). */
export const ZONE_METHODS: readonly string[] = C.zonePaymentMethods.values;
const TEXTS_RECEIPT = C.finish.receipt.texts;
const TEXTS_MONEY = C.finish.driverMoney.texts;

/* ---------------------------------------------------------------- payment methods */

/**
 * v0.18.13 (audit M5): the methods this server has a payment company for. It grows when Movera connects one (card,
 * Apple Pay); it is not a deployment setting, so an admin switch is never silently overruled by the host's env.
 */
export const SERVER_PAYMENT_METHODS: readonly string[] = ["cash"];

/** What the server takes now: its own methods less the ones paused by the PAYMENT_METHODS_PAUSED kill-switch. */
export function supportedPaymentMethods(paused: readonly string[], warn: (message: string) => void = (m) => console.warn(m)): string[] {
  // Checker 2: cash ("Pay in car") can never be paused — riders would have no way to pay at all.
  if (paused.includes("cash")) warn("PAYMENT_METHODS_PAUSED lists cash; ignored (cash can never be paused).");
  return SERVER_PAYMENT_METHODS.filter((m) => m === "cash" || !paused.includes(m));
}

/** The admin's on list of a rider document (default: every method), in the admin's order, known methods only. */
export function adminMethodsOf(doc: unknown): string[] {
  const listed = (doc as { paymentMethods?: unknown } | null | undefined)?.paymentMethods;
  if (!Array.isArray(listed)) return [...ZONE_METHODS];
  return listed.filter((m): m is string => typeof m === "string" && ZONE_METHODS.includes(m)).filter((m, i, all) => all.indexOf(m) === i);
}

/** contract.json#finish.paymentMethods.served: { method, status } per method the admin turned on. */
export function paymentOptionsOf(doc: unknown, supported: readonly string[]) {
  return adminMethodsOf(doc).map((method) => ({ method, status: supported.includes(method) ? ("available" as const) : ("coming_soon" as const) }));
}

/** GET /rider/config, GET /driver/config: the served document with paymentOptions (without google_pay). */
export function withPaymentOptions(document: Record<string, unknown>, supported: readonly string[]): Record<string, unknown> {
  return { ...document, paymentMethods: adminMethodsOf(document), paymentOptions: paymentOptionsOf(document, supported) };
}

/**
 * contract.json#finish.paymentMethods.booking: the reason a method cannot be used in a zone now, or null. Off in admin →
 * payment_method_off; on but not taken by the server → payment_method_coming_soon; anything else → not_available.
 */
export async function paymentMethodProblem(ex: Executor, zoneId: string, method: string, supported: readonly string[]): Promise<string | null> {
  if (!ZONE_METHODS.includes(method)) return "payment_method_not_available";
  const doc = await liveDocument(ex, "rider_app_config", zoneId);
  if (!adminMethodsOf(doc?.document).includes(method)) return "payment_method_off";
  if (!supported.includes(method)) return "payment_method_coming_soon";
  return null;
}

const METHOD_MESSAGES: Record<string, string> = {
  payment_method_off: "This payment method is not offered here. Choose another one.",
  payment_method_coming_soon: "This payment method is coming soon. Choose Pay in car.",
  payment_method_not_available: "This payment method cannot be used. Choose another one.",
};

export async function checkPaymentMethod(ex: Executor, zoneId: string, method: string, supported: readonly string[]): Promise<void> {
  const problem = await paymentMethodProblem(ex, zoneId, method, supported);
  if (problem !== null) throw badRequest(METHOD_MESSAGES[problem]!, problem);
}

/* ---------------------------------------------------------------- tips */

/** The zone's enabled tip amounts in the trip currency (RiderAppConfig.tips), else the country default. */
export async function tipAmountsFor(ex: Executor, zoneId: string, currency: string): Promise<number[]> {
  const doc = await liveDocument<{ tips?: Array<{ amount?: Money; enabled?: boolean }> }>(ex, "rider_app_config", zoneId);
  const tips = doc?.document.tips;
  if (Array.isArray(tips)) return tips.filter((t) => t.enabled !== false && t.amount?.currency === currency).map((t) => Number(t.amount!.amountMinor));
  const zone = await ex.selectFrom("zones").select("country").where("zone_id", "=", zoneId).executeTakeFirst();
  return (C.configDefaults.countries[zone?.country ?? ""]?.tips ?? []).filter((t) => t.currency === currency).map((t) => t.amountMinor);
}

export type TipRules = { cashAfterTrip: boolean; cashInCarMinutes: number; customAmount: boolean; customMax: Money };
/** RiderAppConfig.tipRules with the defaults (cash only in the car within 5 min, presets only, max SE 200 kr / FR 20 €). */
export function tipRulesOf(doc: unknown, country: string, currency: string, presets: readonly number[] = []): TipRules {
  const d = C.configDefaults.tipRules;
  const r = (doc as { tipRules?: Record<string, unknown> } | null | undefined)?.tipRules ?? {};
  const max = r["customMax"] as Money | undefined;
  const fallback = d.customMax[country];
  return {
    cashAfterTrip: typeof r["cashAfterTrip"] === "boolean" ? r["cashAfterTrip"] : d.cashAfterTrip,
    cashInCarMinutes: typeof r["cashInCarMinutes"] === "number" && Number.isInteger(r["cashInCarMinutes"]) && r["cashInCarMinutes"] >= 0 && r["cashInCarMinutes"] <= 60 ? r["cashInCarMinutes"] : d.cashInCarMinutes,
    customAmount: typeof r["customAmount"] === "boolean" ? r["customAmount"] : d.customAmount,
    // Checker (3): never unlimited — the document's, else the country default, else 20 × the highest preset (at least 1).
    customMax: max && max.currency === currency && Number.isInteger(max.amountMinor) && max.amountMinor > 0 ? max : fallback && fallback.currency === currency ? fallback : { amountMinor: Math.max(1, 20 * Math.max(0, ...presets)), currency },
  };
}

const TIP_STATUSES = (trip: TripRow) => trip.status === "completed" || (trip.status === "cancelled_by_rider" && trip.ended_by_command === "end_early");

/**
 * POST /trips/{tripId}/tip, RatingRequest.tip (contract.json#finish.tips): once per trip after the end; one of the zone's
 * amounts; 100 % to the driver (an earnings entry kind tip; a cash tip is cash he already holds).
 */
export async function giveTip(trx: Trx, riderId: string, tripId: string, body: unknown, supported: readonly string[], now: Date) {
  // Another rider's trip is 404 before the body is looked at.
  const trip = await lockOwnTrip(trx, tripId, { actor: "rider", subjectId: riderId });
  const problem = schemaProblem("TipRequest", body);
  if (problem !== null) throw badRequest(`The tip is not valid: ${problem}.`, "invalid_body");
  const tip = body as { amount: Money; method: string };
  if (!TIP_STATUSES(trip) || trip.driver_id === null) {
    throw new ApiError("invalid_transition", "A tip is only possible after a finished trip.", { reason: "tip_not_allowed", projection: tripProjection(trip, "rider") });
  }
  if (trip.tip) throw new ApiError("conflict", "You already tipped for this trip.", { reason: "tip_already_given", projection: tripProjection(trip, "rider") });
  if (tip.amount.currency !== trip.currency) throw badRequest(`The tip is in ${trip.currency}.`, "currency_mismatch");
  const amounts = await tipAmountsFor(trx, trip.zone_id, trip.currency);
  if (amounts.length === 0) throw badRequest("Tips are not on here.", "tips_not_available");
  const zone = await trx.selectFrom("zones").select("country").where("zone_id", "=", trip.zone_id).executeTakeFirst();
  const rules = tipRulesOf((await liveDocument(trx, "rider_app_config", trip.zone_id))?.document, zone?.country ?? "", trip.currency, amounts);
  if (!amounts.includes(tip.amount.amountMinor)) {
    // Builder question 2 (admin tipRules.customAmount): any whole amount from 1 up to customMax, when on.
    if (!rules.customAmount || tip.amount.amountMinor < 1) throw badRequest(`Choose one of the amounts: ${amounts.map((a) => a / 100).join(", ")} ${trip.currency}.`, "tip_amount_not_allowed");
    if (tip.amount.amountMinor > rules.customMax.amountMinor) throw badRequest(`At most ${rules.customMax.amountMinor / 100} ${trip.currency}.`, "tip_above_max");
  }
  // Builder question 1 (admin tipRules.cashAfterTrip, default off): a cash tip only while the rider is in the car.
  if (tip.method === "cash" && !rules.cashAfterTrip && trip.ended_at && now.getTime() > trip.ended_at.getTime() + rules.cashInCarMinutes * 60_000) {
    throw new ApiError("conflict", "A cash tip can only be given in the car.", { reason: "tip_cash_after_trip_off", projection: tripProjection(trip, "rider") });
  }
  await checkPaymentMethod(trx, trip.zone_id, tip.method, supported);
  const value = { amount: { amountMinor: tip.amount.amountMinor, currency: trip.currency }, method: tip.method, driverShare: { amountMinor: tip.amount.amountMinor, currency: trip.currency }, at: now.toISOString() };
  await trx.updateTable("trips").set({ tip: JSON.stringify(value) }).where("trip_id", "=", tripId).execute();
  await credit(trx, { driverId: trip.driver_id, tripId, kind: "tip", currency: trip.currency, amount: tip.amount.amountMinor, cash: tip.method === "cash" ? tip.amount.amountMinor : 0 }, now);
  // No version change (the trip ended): a payment_updated event, so both apps see the tip at once.
  const updated = await trx.selectFrom("trips").selectAll().where("trip_id", "=", tripId).executeTakeFirstOrThrow();
  await appendTripEvent(trx, { tripId, kind: "payment_updated", version: updated.version, occurredAt: now, projection: tripProjection(updated, "admin", { sequence: Number(updated.sequence) + 1 }) });
  return value;
}

/* ---------------------------------------------------------------- receipts */

const PAID = new Set(["captured", "partially_refunded", "refunded"]);
const FEE_LINES = new Set(["cancel_fee"]);

export type ReceiptViewer = "rider" | "driver" | "admin";

/** Receipt (contract.json#finish.receipt) of an ended trip, from the trips row and its refunds. */
export async function receiptOf(ex: Executor, trip: TripRow, viewer: ReceiptViewer) {
  const lines = ((trip.fare_lines as Array<{ code: string; amount: Money }>) ?? []).filter((l) => !["pickup_pay", "driver_bonus"].includes(l.code));
  const feeTrip = lines.some((l) => FEE_LINES.has(l.code));
  if (trip.ended_at === null || (!PAID.has(trip.payment_status ?? "") && !feeTrip)) {
    throw new ApiError("invalid_transition", "There is no receipt for this trip yet.", { reason: "receipt_not_ready" });
  }
  const zone = await ex.selectFrom("zones").select("country").where("zone_id", "=", trip.zone_id).executeTakeFirst();
  const refunds = await ex.selectFrom("refunds").select(["refund_id", "amount_minor", "created_at"]).where("trip_id", "=", trip.trip_id).where("status", "=", "done").orderBy("created_at").execute();
  const m = (amountMinor: number): Money => ({ amountMinor, currency: trip.currency });
  const wallet = Number(trip.wallet_applied_minor ?? 0);
  const fare = Number(trip.fare_minor);
  const cash = trip.cash_collected_minor === null ? Math.max(0, fare - wallet) : Number(trip.cash_collected_minor);
  const debt = trip.status === "completed" ? debtOf(trip.fare_lines) : 0;
  const tip = trip.tip as { amount: Money; method: string } | null;
  const end = endInfoOf(trip);
  const refunded = refunds.reduce((sum, r) => sum + Number(r.amount_minor), 0);
  return {
    tripId: trip.trip_id,
    issuedAt: trip.ended_at.toISOString(),
    zoneId: trip.zone_id,
    country: zone?.country ?? "SE",
    currency: trip.currency,
    categoryId: trip.category_id,
    pickup: trip.pickup,
    dropoff: trip.dropoff,
    stops: trip.stops ?? [],
    paymentMethod: trip.payment_method,
    fareLines: lines,
    total: m(fare),
    // The driver's copy leaves out what the rider's wallet paid (contract §2: the rider's money is not the driver's).
    ...(viewer === "driver" ? {} : { walletPaid: m(wallet) }),
    cashPaid: m(cash),
    ...(debt > 0 ? { debtIncluded: m(debt) } : {}),
    ...(tip ? { tip: { amount: tip.amount, method: tip.method } } : {}),
    refunds: refunds.map((r) => ({ refundId: r.refund_id, amount: m(Number(r.amount_minor)), at: r.created_at.toISOString() })),
    refunded: m(refunded),
    endedEarly: end.endedEarly,
    ...(end.endedBy ? { endedBy: end.endedBy } : {}),
    ...(end.reasonCode ? { endedEarlyReason: end.reasonCode } : {}),
    ...(trip.distance_meters !== null ? { distanceMeters: trip.distance_meters } : {}),
  };
}

export async function riderReceipt(ex: Executor, riderId: string, tripId: string) {
  return receiptOf(ex, await readOwnTrip(ex, tripId, { actor: "rider", subjectId: riderId }), "rider");
}
export async function driverReceipt(ex: Executor, driverId: string, tripId: string) {
  return receiptOf(ex, await readOwnTrip(ex, tripId, { actor: "driver", subjectId: driverId }), "driver");
}

async function adminTripRow(ex: Executor, who: Principal, tripId: string): Promise<TripRow> {
  const trip = await ex.selectFrom("trips").selectAll().where("trip_id", "=", tripId).executeTakeFirst();
  if (!trip) throw new ApiError("not_found", "No such trip.", { reason: "trip_not_found" });
  if (!adminCoversZone(who, trip.zone_id)) throw new ApiError("forbidden", "This trip is outside your zones.", { reason: "zone_out_of_scope" });
  return trip;
}

export async function adminReceipt(ex: Executor, who: Principal, tripId: string) {
  return receiptOf(ex, await adminTripRow(ex, who, tripId), "admin");
}

const fill = (text: string, values: Record<string, string>) => text.replace(/\{(\w+)\}/g, (all, key: string) => values[key] ?? all);
const amountText = (m: Money, lang: string) => {
  const value = (m.amountMinor / 100).toLocaleString(lang === "en" ? "en-GB" : lang === "fr" ? "fr-FR" : "sv-SE", { minimumFractionDigits: m.amountMinor % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 });
  return m.currency === "SEK" ? `${value} kr` : m.currency === "EUR" ? `${value} €` : `${value} ${m.currency}`;
};
async function languageOf(ex: Executor, table: "riders" | "drivers", id: string): Promise<string> {
  const row = table === "riders"
    ? await ex.selectFrom("riders").select("language").where("rider_id", "=", id).executeTakeFirst()
    : await ex.selectFrom("drivers").select("language").where("driver_id", "=", id).executeTakeFirst();
  const lang = (row?.language ?? "sv").slice(0, 2);
  return ["sv", "fr", "en"].includes(lang) ? lang : "sv";
}

/** POST /admin/trips/{tripId}/receipt/resend { reason }: a bell + push kind receipt to the rider, audited. */
export async function resendReceipt(trx: Trx, who: Principal, tripId: string, body: { reason: string }, now: Date) {
  const trip = await adminTripRow(trx, who, tripId);
  const receipt = await receiptOf(trx, trip, "admin");
  const lang = await languageOf(trx, "riders", trip.rider_id);
  const date = trip.ended_at!.toISOString().slice(0, 10);
  const notificationId = await notify(trx, {
    audience: "rider",
    subjectId: trip.rider_id,
    kind: "receipt",
    title: TEXTS_RECEIPT["resendTitle"]![lang]!,
    body: fill(TEXTS_RECEIPT["resendBody"]![lang]!, { date, amount: amountText(receipt.total, lang) }),
    deepLink: `movera-rider://trip/${tripId}/receipt`,
    tripId,
    data: { tripId },
  }, now);
  await audit(trx, { adminId: who.subjectId, action: "trip.receipt_resend", targetType: "trip", targetId: tripId, zoneId: trip.zone_id, detail: { reason: body.reason, notificationId }, at: now });
  return { tripId, notificationId, sentAt: now.toISOString() };
}

/* ---------------------------------------------------------------- the admin changes the driver's pay */

/** CountryRules.driverPayChangeMax of the zone (its own, else its country's Standard), else the country default. */
export async function payChangeMaxOf(ex: Executor, zoneId: string, currency: string): Promise<number> {
  const rules = await liveDocument<{ driverPayChangeMax?: Money }>(ex, "country_rules", zoneId);
  const own = rules?.document.driverPayChangeMax;
  if (own && own.currency === currency && Number.isInteger(own.amountMinor) && own.amountMinor > 0) return own.amountMinor;
  const zone = await ex.selectFrom("zones").select("country").where("zone_id", "=", zoneId).executeTakeFirst();
  const fallback = C.configDefaults.driverPayChangeMax[zone?.country ?? ""];
  return fallback && fallback.currency === currency ? fallback.amountMinor : 100_000;
}

/**
 * POST /admin/trips/{tripId}/driver-pay { change, reason } (contract.json#finish.driverMoney.payChange): an earnings
 * adjustment on an ended trip, paid with the next payout; the driver's total never below 0; audited; a bell to the driver.
 */
export async function adminDriverPay(trx: Trx, who: Principal, tripId: string, body: { change: Money; reason: string }, now: Date): Promise<TripRow> {
  const trip = await lockTrip(trx, tripId);
  if (!adminCoversZone(who, trip.zone_id)) throw new ApiError("forbidden", "This trip is outside your zones.", { reason: "zone_out_of_scope" });
  if (trip.driver_id === null) throw new ApiError("invalid_transition", "This trip has no driver.", { reason: "driver_pay_no_driver", projection: tripProjection(trip, "admin") });
  if (trip.ended_at === null) throw new ApiError("invalid_transition", "Change the pay after the trip ended.", { reason: "driver_pay_not_ended", projection: tripProjection(trip, "admin") });
  if (body.change.currency !== trip.currency) throw badRequest(`The pay is in ${trip.currency}.`, "currency_mismatch");
  if (body.change.amountMinor === 0) throw badRequest("The change cannot be 0.", "invalid_amount");
  // Checker (2): one change is at most the country's (or zone's) driverPayChangeMax (Admin › Tips & limits).
  const max = await payChangeMaxOf(trx, trip.zone_id, trip.currency);
  if (Math.abs(body.change.amountMinor) > max) throw badRequest(`One change is at most ${max / 100} ${trip.currency}.`, "driver_pay_above_max");
  const before = driverTotalOf(trip);
  const after = before + body.change.amountMinor;
  if (after < 0) throw badRequest(`The driver's pay on this trip is ${before / 100} ${trip.currency}; it cannot go below 0.`, "driver_pay_below_zero");
  await credit(trx, { driverId: trip.driver_id, tripId, kind: "adjustment", currency: trip.currency, amount: body.change.amountMinor }, now);
  const updated = await touchTrip(trx, trip, { driver_adjustments_minor: Number(trip.driver_adjustments_minor ?? 0) + body.change.amountMinor }, now);
  await audit(trx, { adminId: who.subjectId, action: "trip.driver_pay", targetType: "trip", targetId: tripId, zoneId: trip.zone_id, detail: { reason: body.reason, change: body.change, before: { amountMinor: before, currency: trip.currency }, after: { amountMinor: after, currency: trip.currency } }, at: now });
  const lang = await languageOf(trx, "drivers", trip.driver_id);
  const sign = body.change.amountMinor > 0 ? "+" : "−";
  await notify(trx, {
    audience: "driver",
    subjectId: trip.driver_id,
    kind: "driver_pay_changed",
    title: TEXTS_MONEY["yourShare"]![lang]!,
    body: fill(TEXTS_MONEY["payChanged"]![lang]!, { change: sign + amountText({ amountMinor: Math.abs(body.change.amountMinor), currency: trip.currency }, lang), reason: body.reason }),
    deepLink: `movera-driver://trip/${tripId}`,
    tripId,
    data: { tripId },
  }, now);
  return updated;
}
