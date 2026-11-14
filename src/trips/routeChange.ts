import { moneyText, type MoneyLike } from "../rules/money.js";
import { schemaProblem } from "../contract/schemas.js";
import { commissionOf } from "../rules/commission.js";
import type { Trx } from "../db/db.js";
import type { TripRow } from "../db/tripLog.js";
import { ApiError, badRequest } from "../http/errors.js";
import { newId } from "../ids.js";
import { cancelTimer, scheduleTimer, type TimerHandler } from "../jobs/timers.js";
import { haversineKm, type LatLng, type Router } from "../maps/routing.js";
import { FareError, priceFare, type Fare, type FareLine } from "../rules/fare.js";
import { extrasOf } from "../rules/priceExtras.js";
import { contract } from "../contract/contract.js";
import { lockTripNow } from "../dispatch/runtime.js";
import { expectVersion, lockOwnTrip, touchTrip } from "./commands.js";
import { checkMaxStops, routeChangeSettings, type RouteChangeSettings } from "./onTripSettings.js";
import { routeChangeDriverTotal, tripProjection } from "./projection.js";
import { pricingOf } from "./ride.js";
import { notify } from "../notifications/service.js";
import { noticeLanguage } from "../notifications/noticeLanguage.js";

/**
 * v0.18.9 (contract.json#onTrip.routeChange, owner G7 decision 3 "Rider changes, driver accepts"): the rider changes
 * the destination or adds / removes stops once a driver has the trip, sees the new price and confirms; the driver gets
 * Accept / Refuse with his new earnings; refused (or no answer in time) → the trip goes on to the old destination.
 * Per-zone admin switches DriverAppConfig.routeChange { on, driverCanRefuse, answerSeconds }, read live.
 */

type Place = { address?: string; lat: number; lng: number };
type Money = { amountMinor: number; currency: string };
export type RouteChange = {
  changeId: string;
  routeQuoteId: string;
  status: "pending" | "accepted" | "refused" | "expired" | "withdrawn";
  dropoff: Place;
  stops: Place[];
  total: Money;
  difference: Money;
  askedAt: string;
  answerBy: string;
  answeredAt?: string;
  answeredBy?: "driver" | "rider" | "system";
  driverEarnings: Money;
  earningsDifference: Money;
};

export const ROUTE_CHANGE_EXPIRE = "route_change_expire";
const RX = (contract as unknown as { onTrip: { routeChange: { statuses: string[]; beforePickupStatuses: string[] } } }).onTrip.routeChange;
const STATUSES: ReadonlySet<string> = new Set(RX.statuses);
const BEFORE_PICKUP: ReadonlySet<string> = new Set(RX.beforePickupStatuses);
const QUOTE_TTL_MS = 5 * 60_000;
const SAME_STOP_KM = 0.05;
type StopVisit = { stopIndex: number; arrivedAt: string; leftAt?: string };

const conflict = (reason: string, message: string, trip?: TripRow, viewer: "rider" | "driver" = "rider") =>
  new ApiError("conflict", message, { reason, ...(trip ? { projection: tripProjection(trip, viewer) } : {}) });

export function pendingChange(trip: Pick<TripRow, "route_change">): RouteChange | null {
  const change = trip.route_change as RouteChange | null;
  return change && change.status === "pending" ? change : null;
}

/** Checks the trip may change its route now; true when it has a fixed price that the change will leave (switch_to_normal). */
function checkOpen(trip: TripRow, settings: RouteChangeSettings): boolean {
  if (!STATUSES.has(trip.status)) {
    throw new ApiError("invalid_transition", `The route cannot be changed while the trip is ${trip.status}.`, { projection: tripProjection(trip, "rider") });
  }
  if (!settings.on) throw conflict("route_change_off", "Changing the route is not available here.", trip);
  // Owner rule 16 (G7 open question 1): admin switch routeChange.beforePickup.
  if (!settings.beforePickup && BEFORE_PICKUP.has(trip.status)) throw conflict("route_change_before_pickup_off", "The route can be changed once you are in the car.", trip);
  if (pendingChange(trip)) throw conflict("route_change_pending", "The driver has not answered your last change yet.", trip);
  const fixed = Boolean(extrasOf(trip.price_extras as Record<string, unknown>).fixedRouteId);
  // Owner rule 16 (G7 open question 4): admin setting routeChange.fixedPriceTrips block | switch_to_normal.
  if (fixed && settings.fixedPriceTrips === "block") throw conflict("route_change_fixed_route", "A fixed-price route cannot be changed.", trip);
  return fixed;
}

/** The fare of a route with the trip's own pricing document, surge, car type and extras (stops without waiting). */
function routeFare(doc: Parameters<typeof priceFare>[0], trip: TripRow, km: number, minutes: number, stops: number, normalPrice = false): Fare {
  const extras = extrasOf(trip.price_extras as Record<string, unknown>);
  if (normalPrice) delete extras.fixedRouteId;
  try {
    return priceFare(doc, { categoryId: trip.category_id, km, minutes, kind: trip.kind, surgeMultiplier: Number(trip.surge_multiplier), stopWaitSeconds: Array.from({ length: stops }, () => 0), ...extras });
  } catch (error) {
    if (error instanceof FareError) throw new ApiError("unavailable", "Prices for this area are not usable right now.", { reason: "pricing_invalid" });
    throw error;
  }
}

/** The trip's lines moved by the difference between two fares, code by code (an extra line before app_fee). */
function movedLines(trip: TripRow, from: Fare, to: Fare, floorAdd: number): FareLine[] {
  const delta = new Map<string, number>();
  for (const l of to.fareLines) delta.set(l.code, (delta.get(l.code) ?? 0) + l.amount.amountMinor);
  for (const l of from.fareLines) delta.set(l.code, (delta.get(l.code) ?? 0) - l.amount.amountMinor);
  if (floorAdd) delta.set("adjustment", (delta.get("adjustment") ?? 0) + floorAdd);
  const lines = ((trip.fare_lines as FareLine[]) ?? []).map((l) => ({ ...l, amount: { ...l.amount } }));
  for (const [code, amount] of delta) {
    if (amount === 0) continue;
    const line = lines.find((l) => l.code === code);
    if (line) line.amount.amountMinor += amount;
    else lines.splice(Math.max(0, lines.findIndex((l) => l.code === "app_fee")), 0, { code, amount: { amountMinor: amount, currency: trip.currency } });
  }
  return lines.filter((l) => l.amount.amountMinor !== 0 || ["base", "distance", "time", "fixed_route"].includes(l.code));
}

const money = (amountMinor: number, currency: string): Money => ({ amountMinor, currency });

/** POST /trips/{tripId}/route-quote (rider): the price of the new route; nothing on the trip changes. */
export async function quoteRouteChange(trx: Trx, router: Router, riderId: string, tripId: string, body: unknown, now: Date) {
  const trip = await lockOwnTrip(trx, tripId, { actor: "rider", subjectId: riderId });
  const problem = schemaProblem("RouteQuoteRequest", body);
  if (problem !== null) throw badRequest(`The request is not valid: ${problem}.`, "invalid_body");
  const req = body as { expectedVersion: number; dropoff?: Place; stops: Place[]; pickup?: Place };
  if (req.pickup !== undefined) throw badRequest("Move the pickup with PATCH /trips/{tripId} { pickup }.", "invalid_body");
  expectVersion(trip, req.expectedVersion, "rider");
  const leavesFixedPrice = checkOpen(trip, await routeChangeSettings(trx, trip.zone_id));
  await checkMaxStops(trx, trip.zone_id, req.stops.length);
  // Stops the driver already reached stay first, in the same order (their waiting is counted by index).
  const oldStops = (trip.stops as Place[]) ?? [];
  for (const visit of (trip.stop_visits as StopVisit[] | null) ?? []) {
    const kept = req.stops[visit.stopIndex];
    const was = oldStops[visit.stopIndex];
    if (!kept || !was || haversineKm(kept, was) > SAME_STOP_KM) throw badRequest("A stop you already reached cannot be changed or removed.", "visited_stop_changed");
  }
  const dropoff = req.dropoff ?? (trip.dropoff as Place);
  const points: LatLng[] = [trip.pickup as Place, ...req.stops, dropoff].map((p) => ({ lat: p.lat, lng: p.lng }));
  const leg = await router.route(points);
  const doc = await pricingOf(trx, trip);
  const current = routeFare(doc, trip, (trip.distance_meters ?? 0) / 1000, (trip.duration_seconds ?? 0) / 60, oldStops.length);
  // switch_to_normal: the new route at the normal price, measured against the fixed price the trip has now.
  const next = routeFare(doc, trip, leg.distanceMeters / 1000, leg.durationSeconds / 60, req.stops.length, leavesFixedPrice);
  // Owner decision 5 (v0.4.3): never below half of (booked fare + the rider's raises); raises stay.
  const raises = ((trip.fare_lines as FareLine[]) ?? []).filter((l) => l.code === "rider_raise").reduce((s, l) => s + l.amount.amountMinor, 0);
  const floor = Math.ceil((Number(trip.booked_fare_minor) + raises) / 2);
  const fare = Number(trip.fare_minor);
  const raw = fare + next.total.amountMinor - current.total.amountMinor;
  const total = Math.max(raw, floor);
  const earnings = Math.max(0, Number(trip.driver_earnings_minor ?? 0) + next.driverEarnings.amountMinor - current.driverEarnings.amountMinor);
  const lines = movedLines(trip, current, next, total - raw).filter((l) => !(leavesFixedPrice && l.code === "fixed_route" && l.amount.amountMinor === 0));
  const routeQuoteId = newId("rtq", now.getTime());
  const expiresAt = new Date(now.getTime() + QUOTE_TTL_MS);
  await trx
    .insertInto("route_quotes")
    .values({
      route_quote_id: routeQuoteId,
      trip_id: tripId,
      trip_version: trip.version,
      base_change_id: (trip.route_change as RouteChange | null)?.changeId ?? null,
      dropoff: JSON.stringify(dropoff),
      stops: JSON.stringify(req.stops),
      distance_meters: leg.distanceMeters,
      duration_seconds: leg.durationSeconds,
      currency: trip.currency,
      total_minor: total,
      difference_minor: total - fare,
      fare_lines: JSON.stringify(lines),
      driver_earnings_minor: earnings,
      leaves_fixed_price: leavesFixedPrice,
      expires_at: expiresAt,
      created_at: now,
    })
    .execute();
  return {
    routeQuoteId,
    tripId,
    total: money(total, trip.currency),
    difference: money(total - fare, trip.currency),
    fareLines: lines.filter((l) => !["pickup_pay", "driver_bonus"].includes(l.code)),
    dropoff,
    stops: req.stops,
    expiresAt: expiresAt.toISOString(),
    ...(leavesFixedPrice ? { leavesFixedPrice: true } : {}),
  };
}

/** The accepted change on the trip: route, fare, lines, the driver's earnings, the route the ride check measures. */
async function applyChange(trx: Trx, trip: TripRow, change: RouteChange, answeredBy: RouteChange["answeredBy"], now: Date): Promise<TripRow> {
  const quote = await trx.selectFrom("route_quotes").selectAll().where("route_quote_id", "=", change.routeQuoteId).executeTakeFirstOrThrow();
  const total = Number(quote.total_minor);
  const earnings = Number(quote.driver_earnings_minor);
  const extras = { ...((trip.price_extras as Record<string, unknown> | null) ?? {}) };
  if (quote.leaves_fixed_price) delete extras["fixedRouteId"];
  return touchTrip(trx, trip, {
    ...(quote.leaves_fixed_price ? { price_extras: JSON.stringify(extras) } : {}),
    dropoff: JSON.stringify(quote.dropoff),
    stops: JSON.stringify(quote.stops),
    fare_minor: total,
    // Deep fix 2026-11-02 (g7-g9 H1): an early end after this change is capped by the new price, not the old booked one.
    route_delta_minor: Number(trip.route_delta_minor ?? 0) + Number(quote.difference_minor),
    fare_lines: JSON.stringify(quote.fare_lines),
    driver_earnings_minor: earnings,
    commission_minor: commissionOf(total, quote.fare_lines, earnings, Number(trip.pickup_pay_minor ?? 0), Number(trip.driver_bonus_minor ?? 0)),
    distance_meters: quote.distance_meters,
    duration_seconds: quote.duration_seconds,
    planned_route: null,
    route_change: JSON.stringify({ ...change, status: "accepted", answeredAt: now.toISOString(), answeredBy }),
  }, now);
}

/** PATCH /trips/{tripId} { expectedVersion, routeQuoteId } (rider): the change goes to the driver (or applies at once). */
export async function requestRouteChange(trx: Trx, riderId: string, tripId: string, body: { expectedVersion: number; routeQuoteId: string }, now: Date): Promise<TripRow> {
  const trip = await lockOwnTrip(trx, tripId, { actor: "rider", subjectId: riderId });
  expectVersion(trip, body.expectedVersion, "rider");
  const quote = await trx.selectFrom("route_quotes").selectAll().where("route_quote_id", "=", body.routeQuoteId).where("trip_id", "=", tripId).forUpdate().executeTakeFirst();
  if (!quote) throw new ApiError("not_found", "No such route price.", { reason: "route_quote_not_found" });
  if (quote.used_at !== null) throw conflict("route_quote_used", "This price was already used.", trip);
  if (quote.expires_at.getTime() <= now.getTime()) throw conflict("route_quote_expired", "This price expired. Ask for a new one.", trip);
  // Stale when the fare moved (waiting added at boarding, an admin adjust) or another change was made since this price.
  // The trip's version alone is not used: the driver's steps (arrive, stops) move it without touching the price.
  const fareThen = Number(quote.total_minor) - Number(quote.difference_minor);
  const changeNow = (trip.route_change as RouteChange | null)?.changeId ?? null;
  if (fareThen !== Number(trip.fare_minor) || changeNow !== quote.base_change_id) {
    throw new ApiError("version_mismatch", "The trip changed since this price. Ask for a new one.", { projection: tripProjection(trip, "rider") });
  }
  const settings = await routeChangeSettings(trx, trip.zone_id);
  const fixedNow = checkOpen(trip, settings);
  if (Boolean(quote.leaves_fixed_price) !== fixedNow) throw new ApiError("version_mismatch", "The trip changed since this price. Ask for a new one.", { projection: tripProjection(trip, "rider") });
  await trx.updateTable("route_quotes").set({ used_at: now }).where("route_quote_id", "=", quote.route_quote_id).execute();
  const currency = trip.currency;
  const change: RouteChange = {
    changeId: newId("rtc", now.getTime()),
    routeQuoteId: quote.route_quote_id,
    status: "pending",
    dropoff: quote.dropoff as Place,
    stops: quote.stops as Place[],
    total: money(Number(quote.total_minor), currency),
    difference: money(Number(quote.difference_minor), currency),
    askedAt: now.toISOString(),
    answerBy: new Date(now.getTime() + settings.answerSeconds * 1000).toISOString(),
    driverEarnings: money(Number(quote.driver_earnings_minor), currency),
    earningsDifference: money(Number(quote.driver_earnings_minor) - Number(trip.driver_earnings_minor ?? 0), currency),
  };
  // Admin "Driver can refuse" off: the change applies now and the driver is told.
  if (!settings.driverCanRefuse) return applyChange(trx, trip, { ...change, answerBy: change.askedAt }, "system", now);
  await scheduleTimer(trx, { kind: ROUTE_CHANGE_EXPIRE, refId: `${tripId}|${change.changeId}`, dueAt: new Date(change.answerBy) });
  const updated = await touchTrip(trx, trip, { route_change: JSON.stringify(change) }, now);
  await pushRouteChange(trx, trip, change, settings.answerSeconds, now);
  return updated;
}

/** POST /trips/{tripId}/route-change/accept | refuse (driver) | withdraw (rider). */
export async function answerRouteChange(trx: Trx, who: { actor: "driver" | "rider"; subjectId: string }, tripId: string, verb: "accept" | "refuse" | "withdraw", body: { expectedVersion: number; changeId: string }, now: Date): Promise<TripRow> {
  const trip = await lockOwnTrip(trx, tripId, who);
  expectVersion(trip, body.expectedVersion, who.actor);
  const change = pendingChange(trip);
  if (!change || change.changeId !== body.changeId) throw conflict("route_change_not_pending", "This route change is no longer waiting for an answer.", trip, who.actor);
  // Checker HIGH: never after the trip left the route-change statuses or after answerBy (the timer may be late).
  if (!STATUSES.has(trip.status) || now.getTime() > Date.parse(change.answerBy)) {
    if (verb !== "withdraw" || !STATUSES.has(trip.status)) throw conflict("route_change_not_pending", "This route change is no longer waiting for an answer.", trip, who.actor);
  }
  // Checker LOW (decision: expire for safety): the admin switched route change off while it waited → it cannot be
  // accepted (409 route_change_off); refuse / withdraw still work, and the timer marks it expired at answerBy.
  if (verb === "accept" && !(await routeChangeSettings(trx, trip.zone_id)).on) throw conflict("route_change_off", "Changing the route was switched off.", trip, who.actor);
  await cancelTimer(trx, ROUTE_CHANGE_EXPIRE, `${tripId}|${change.changeId}`);
  if (verb === "accept") return applyChange(trx, trip, change, "driver", now);
  const status = verb === "refuse" ? "refused" : "withdrawn";
  return touchTrip(trx, trip, { route_change: JSON.stringify({ ...change, status, answeredAt: now.toISOString(), answeredBy: who.actor }) }, now);
}

/** No answer in answerSeconds: refused (status expired), the old route stays. */
export const routeChangeExpireHandler: TimerHandler = async (trx, timer) => {
  const [tripId, changeId] = timer.refId.split("|") as [string, string];
  const trip = await lockTripNow(trx, tripId);
  if (!trip) return;
  const change = pendingChange(trip);
  if (!change || change.changeId !== changeId) return;
  await touchTrip(trx, trip, { route_change: JSON.stringify({ ...change, status: "expired", answeredAt: timer.firedAt.toISOString(), answeredBy: "system" }) }, timer.firedAt);
};

type Lang = "sv" | "fr" | "en";
type DriverPush = { kind: string; deepLink: string; title: Record<Lang, string>; body: Record<Lang, string> };
const DRIVER_PUSH = (contract as unknown as { onTrip: { routeChange: { driverPush: DriverPush } } }).onTrip.routeChange.driverPush;

/**
 * v0.18.14 (live sweep H-1, contract.json#onTrip.routeChange.driverPush): the pending change is pushed to the driver too
 * (push only, not after answerBy), in his language, with his new earnings, so it reaches him with the app in the
 * background; the trip stream still carries it (trip_projection, version + 1).
 */
/** Price format (owner 2026-11-14; audit price-display gap 14): the driver's new earnings in the shared money text. */
export const routeChangePushBody = (lang: Lang, seconds: number, earnings: MoneyLike): string =>
  DRIVER_PUSH.body[lang].replace("{seconds}", String(seconds)).replace("{earnings}", moneyText(earnings));

/**
 * v0.18.89 §90 (owner 2026-11-14 "correct prices every where", s06:1275; the driver sees only what he gets, s06:1164): the push
 * says the same number as the route-change card, TripRouteChange.driverTotal (what he gets for the whole trip with the new
 * route), in the currency's format (moneyDisplay.wholeAmounts); the change's driverEarnings only when no total can be made.
 */
export const routeChangePushText = (lang: Lang, seconds: number, trip: Pick<TripRow, "pickup_pay_minor" | "driver_bonus_minor">, change: RouteChange): string =>
  routeChangePushBody(lang, seconds, routeChangeDriverTotal(trip, change) ?? change.driverEarnings);

async function pushRouteChange(trx: Trx, trip: TripRow, change: RouteChange, seconds: number, now: Date): Promise<void> {
  if (!trip.driver_id) return;
  // v0.18.66 §87: the one notice-language rule (his language, else the trip country's, TN fr, else en).
  const lang: Lang = await noticeLanguage(trx, { actor: "driver", id: trip.driver_id }, trip.zone_id);
  await notify(trx, {
    audience: "driver",
    subjectId: trip.driver_id,
    kind: DRIVER_PUSH.kind,
    title: DRIVER_PUSH.title[lang],
    body: routeChangePushText(lang, seconds, trip, change),
    deepLink: DRIVER_PUSH.deepLink.replace("{tripId}", trip.trip_id),
    tripId: trip.trip_id,
    data: { tripId: trip.trip_id, changeId: change.changeId, answerBy: change.answerBy },
    bell: false,
    pushUntil: new Date(change.answerBy),
  }, now);
}
