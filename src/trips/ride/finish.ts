import { blockPair, dontMatchSettings } from "../../blockedPairs/service.js";
import { applyPersonRules, hasBadWord, ratingRules } from "../../admin/reviewRules.js";
import { checkTags } from "../../admin/ratings.js";
import { askUnexpectedEnd } from "../../safety/rideCheckServer.js";
import { sql } from "kysely";
import { contract } from "../../contract/contract.js";
import { schemaProblem } from "../../contract/schemas.js";
import type { Executor, Trx } from "../../db/db.js";
import { appendTripEvent, type TripRow } from "../../db/tripLog.js";
import { ApiError, badRequest } from "../../http/errors.js";
import { newId } from "../../ids.js";
import type { FareLine } from "../../rules/fare.js";
import { applyCommand, expectVersion, lockOwnTrip, readOwnTrip } from "../commands.js";
import { driverTotalOf, earningsLinesOf, tripProjection, type EndInfo } from "../projection.js";
import { type Money, REASONS, ONBOARD } from "./shared.js";
import { outstandingLine, drivenFare, driven, drivenColumns, earlyEndOf, endedBeforeDropoff, scaledFare, withStopWaiting } from "./settings.js";
import { releaseDriver, credit, settleCarriedFees, walletPart, spendWallet } from "./money.js";
import { walletBalance } from "../../riders/wallet.js";

/* ---------------------------------------------------------------- the rider ends early */

export async function endEarly(trx: Trx, riderId: string, tripId: string, body: { expectedVersion: number; reasonCode?: string; note?: string }, now: Date): Promise<TripRow> {
  const problem = schemaProblem("EndEarlyCommand", body);
  if (problem !== null) throw badRequest(`The request is not valid: ${problem}.`, "invalid_body");
  if (body.reasonCode !== undefined && !REASONS["rider"]!.includes(body.reasonCode)) throw badRequest(`${body.reasonCode} is not a rider reason.`, "invalid_reason_code");
  const trip = await lockOwnTrip(trx, tripId, { actor: "rider", subjectId: riderId });
  expectVersion(trip, body.expectedVersion, "rider");
  if (!ONBOARD.includes(trip.status)) {
    throw new ApiError("invalid_transition", `A rider cannot end_early a trip that is ${trip.status}.`, { projection: tripProjection(trip, "rider") });
  }
  // v0.18.10 (owner G8 Q1/Q2): what was driven plus the paid waiting at the stops.
  const money = await drivenColumns(trx, trip, await drivenFare(trx, trip, now), now);
  const wallet = await spendWallet(trx, trip, money.fare_minor, now);
  const reasonCode = body.reasonCode ?? "something_else";
  const cancellation = { actor: "rider", reasonCode, at: now.toISOString(), fee: null, ...(body.note ? { note: body.note } : {}) };
  const info: EndInfo = { endedEarly: true, endedBy: "rider", reasonCode };
  const ended = await applyCommand(trx, trip, {
    command: "end_early",
    actor: "rider",
    now,
    // An owed fee the trip carried stays owed: the trip did not complete (§3.7). v0.18.10 (owner G8 Q1): the driver gets
    // the normal finish (TripProjection.finish) and rates the rider.
    set: { ...money, cancellation: JSON.stringify(cancellation), end_info: JSON.stringify(info), ended_by_command: "end_early", ended_at: now, payment_status: "captured", cash_collected_minor: money.fare_minor - wallet, wallet_applied_minor: wallet, rating_status: "pending", driver_rating_status: "pending" },
  });
  await creditTrip(trx, ended, now);
  await releaseDriver(trx, trip.driver_id, now);
  return ended;
}

/* ---------------------------------------------------------------- completion */

export async function creditTrip(trx: Trx, trip: TripRow, now: Date) {
  if (trip.driver_id === null) return;
  const fare = Number(trip.fare_minor);
  const earnings = Number(trip.driver_earnings_minor ?? 0);
  const owed = outstandingLine(trip);
  const owedMinor = trip.status === "completed" && owed ? owed.amount.amountMinor : 0;
  await credit(trx, { driverId: trip.driver_id, tripId: trip.trip_id, kind: "trip", currency: trip.currency, amount: earnings, gross: fare - owedMinor, commission: fare - owedMinor - earnings, cash: Number(trip.cash_collected_minor ?? 0) }, now);
  await credit(trx, { driverId: trip.driver_id, tripId: trip.trip_id, kind: "pickup_pay", currency: trip.currency, amount: Number(trip.pickup_pay_minor ?? 0) }, now);
  // A Movera bonus on the trip is paid when the trip ends with this driver.
  await credit(trx, { driverId: trip.driver_id, tripId: trip.trip_id, kind: "bonus", currency: trip.currency, amount: Number(trip.driver_bonus_minor ?? 0) }, now);
}

/**
 * The fare complete sets (one code path for complete and its preview, contract v0.18.1 §26). Finished before the
 * destination (owner decision 28, like the rider's early end): the rider pays for what was driven, never more than
 * booked. An admin's fare is taken as given; at the drop-off the booked fare stands.
 */
async function finalPrice(ex: Executor, trip: TripRow, actor: "driver" | "admin", adminFare: Money | undefined, now: Date) {
  const early = adminFare === undefined && actor === "driver" && (await endedBeforeDropoff(ex, trip));
  // v0.7.1 (§3.8): the waiting at the middle stops is added, from each arrival to leaving. v0.18.10 (owner G8 Q2): also
  // when the driver ends early.
  const stopped = adminFare === undefined ? await withStopWaiting(ex, trip, now) : null;
  let info: EndInfo = { endedEarly: false };
  let money: FrozenMoney = adminFare ? scaledFare(trip, adminFare.amountMinor) : (stopped ?? {});
  if (early) {
    ({ money, info } = await earlyEndPrice(ex, trip, now, stopped));
  }
  const fare = money.fare_minor ?? Number(trip.fare_minor);
  return { early, fare, money: { ...money, end_info: JSON.stringify(info) } as FrozenMoney, info };
}

/** v0.18.10 (owner G8 Q2): the driver ended before the drop-off — driven price only over the admin's km / minutes, stop waiting kept. */
export async function earlyEndPrice(ex: Executor, trip: TripRow, now: Date, stoppedIn?: Awaited<ReturnType<typeof withStopWaiting>>): Promise<{ money: FrozenMoney; info: EndInfo }> {
  const stopped = stoppedIn !== undefined ? stoppedIn : await withStopWaiting(ex, trip, now);
  let money: FrozenMoney = stopped ?? {};
  {
    const measured = await driven(ex, trip, now);
    const limits = await earlyEndOf(ex, trip);
    // How much shorter than booked (never negative): the booked road km and minutes against what was driven on board.
    const shortKm = Math.round(Math.max(0, (trip.distance_meters ?? 0) / 1000 - measured.km) * 100) / 100;
    const shortMin = Math.round(Math.max(0, (trip.duration_seconds ?? 0) / 60 - measured.minutes) * 100) / 100;
    // A new price only when more than repriceOverKm AND more than repriceOverMin shorter (v0.18.33, owner fix-plan Q1:
    // BOTH; contract.json#afterTestRules.earlyEnd), and only when it is less than booked
    // (at the cap the booked fare and its lines stand as they are).
    const repriced = (shortKm > limits.repriceOverKm && shortMin > limits.repriceOverMin) && measured.fare.total.amountMinor < Number(trip.fare_minor);
    if (repriced) money = await drivenColumns(ex, trip, measured.fare, now);
    return { money, info: { endedEarly: true, endedBy: "driver", reasonCode: "ended_before_dropoff", repriced, shortKm, shortMin } };
  }
}

/** contract v0.18.1 §26: how long a preview's price holds. */
export const PREVIEW_FREEZE_SECONDS = (contract as unknown as { completePreview: { freezeSeconds: number } }).completePreview.freezeSeconds;

export type FrozenMoney = { fare_minor?: number; fare_lines?: string; driver_earnings_minor?: number; commission_minor?: number; end_info?: string };

/** The CompletePreview body of a frozen price. */
function previewBody(trip: TripRow, row: { previewId: string; expiresAt: Date; early: boolean; fare: number; wallet: number; money: FrozenMoney }) {
  const lines = row.money.fare_lines !== undefined ? (JSON.parse(row.money.fare_lines) as FareLine[]) : ((trip.fare_lines as FareLine[]) ?? []);
  const sum = (amountMinor: number): Money => ({ amountMinor, currency: trip.currency });
  const earnings = row.money.driver_earnings_minor ?? Number(trip.driver_earnings_minor ?? 0);
  const info = row.money.end_info !== undefined ? (JSON.parse(row.money.end_info) as EndInfo) : null;
  // v0.18.10 (owner G8 Q3): the same one number the finished screen shows (incl. pickup pay, bonus, Movera's changes).
  const asEnded = { ...trip, driver_earnings_minor: String(earnings) };
  return {
    previewId: row.previewId,
    expiresAt: row.expiresAt.toISOString(),
    tripId: trip.trip_id,
    total: sum(row.fare),
    cashDue: sum(row.fare - row.wallet),
    driverEarnings: sum(earnings),
    driverTotal: sum(driverTotalOf(asEnded)),
    earningsBreakdown: earningsLinesOf(asEnded).map((l) => ({ code: l.code, amount: sum(l.amountMinor) })),
    earlyEnd: row.early,
    ...(info?.endedEarly ? { repriced: info.repriced === true, shortKm: info.shortKm ?? 0, shortMin: info.shortMin ?? 0 } : {}),
    fareLines: lines,
  };
}

/**
 * GET /driver/trips/{tripId}/complete-preview (contract v0.18.1 §26): what complete would set now (the same
 * finalPrice), frozen for PREVIEW_FREEZE_SECONDS under a new previewId that replaces the trip's earlier one. The trip
 * and the wallet are not changed.
 */
export async function completePreview(ex: Executor, driverId: string, tripId: string, now: Date) {
  const trip = await readOwnTrip(ex, tripId, { actor: "driver", subjectId: driverId });
  if (!ONBOARD.includes(trip.status)) {
    throw new ApiError("invalid_transition", "The rider is not on board.", { reason: "trip_not_on_board", projection: tripProjection(trip, "driver") });
  }
  const { early, fare, money } = await finalPrice(ex, trip, "driver", undefined, now);
  // v0.18.28 (owner Q4): the balance in the trip's currency.
  const wallet = walletPart(await walletBalance(ex, trip.rider_id, trip.currency), trip, fare);
  const previewId = newId("cpv", now.getTime());
  const expiresAt = new Date(now.getTime() + PREVIEW_FREEZE_SECONDS * 1000);
  const row = { preview_id: previewId, driver_id: driverId, expires_at: expiresAt, early_end: early, fare_minor: fare, wallet_minor: wallet, money: JSON.stringify(money), created_at: now };
  await ex.insertInto("complete_previews").values({ trip_id: tripId, ...row }).onConflict((c) => c.column("trip_id").doUpdateSet(row)).execute();
  return previewBody(trip, { previewId, expiresAt, early, fare, wallet, money });
}

/** Thrown inside complete's transaction; the route answers 409 price_changed with a fresh preview made after it. */
export class PriceChanged extends Error {
  constructor(readonly tripId: string) {
    super("The price changed.");
  }
}

export async function completeTrip(trx: Trx, who: { actor: "driver" | "admin"; subjectId: string }, tripId: string, body: { expectedVersion: number; cashCollected?: Money; fare?: Money; previewId?: string }, now: Date): Promise<TripRow> {
  const trip = await lockOwnTrip(trx, tripId, who);
  if (body.fare && body.fare.currency !== trip.currency) throw badRequest(`The fare is in ${trip.currency}.`, "currency_mismatch");
  expectVersion(trip, body.expectedVersion, who.actor);
  if (body.cashCollected && body.cashCollected.currency !== trip.currency) throw badRequest(`Cash is counted in ${trip.currency}.`, "currency_mismatch");
  // contract v0.18.1 §26: the driver's latest unexpired preview is the price, exactly (no early-end flip, no extra
  // minutes); otherwise the trip is priced as now.
  const previewed = who.actor === "driver" && body.fare === undefined && body.previewId !== undefined;
  const frozen = previewed
    ? await trx.selectFrom("complete_previews").selectAll().where("trip_id", "=", trip.trip_id).where("preview_id", "=", body.previewId!).where("driver_id", "=", who.subjectId).where("expires_at", ">", now).executeTakeFirst()
    : undefined;
  const { fare, money } = frozen
    ? { fare: Number(frozen.fare_minor), money: frozen.money as FrozenMoney }
    : await finalPrice(trx, trip, who.actor, body.fare, now);
  const wallet = await spendWallet(trx, trip, fare, now);
  // With a previewId the cash shown must be the cash part of this price; if not, nothing is completed and the app
  // gets a fresh price to show (409 price_changed, never a 400 that leaves the driver stuck).
  if (previewed && body.cashCollected && body.cashCollected.amountMinor !== fare - wallet) throw new PriceChanged(trip.trip_id);
  // The rider owes the fare (outstanding fees included) less what the wallet paid; more cash than that is a miscount,
  // and it would raise the driver's cash balance and the trip's refund room above the fare.
  if (body.cashCollected && body.cashCollected.amountMinor > fare - wallet) {
    throw badRequest(`At most ${(fare - wallet) / 100} ${trip.currency} is collected in cash on this trip.`, "cash_above_fare");
  }
  const cash = body.cashCollected?.amountMinor ?? fare - wallet;
  const done = await applyCommand(trx, trip, {
    command: "complete",
    actor: who.actor,
    now,
    set: { ...money, ended_by_command: "complete", ended_at: now, payment_status: "captured", cash_collected_minor: cash, wallet_applied_minor: wallet, rating_status: "pending", driver_rating_status: "pending" },
  });
  await creditTrip(trx, done, now);
  if (done.payment_method === "cash") await settleCarriedFees(trx, done, cash + wallet, now);
  await releaseDriver(trx, done.driver_id, now);
  // v0.18.9 (contract.json#onTrip.rideCheck): the driver ended the trip far from the drop-off → "Is everything OK?" to both.
  if (who.actor === "driver") {
    await askUnexpectedEnd(trx, done, now);
    return trx.selectFrom("trips").selectAll().where("trip_id", "=", tripId).executeTakeFirstOrThrow();
  }
  return done;
}

/* ---------------------------------------------------------------- ratings */

type RatingBody = { stars?: number; tags?: string[]; comment?: string; skip?: boolean; tip?: Money; dontMatchAgain?: boolean };

export async function rateTrip(trx: Trx, who: { actor: "rider" | "driver"; subjectId: string }, tripId: string, body: unknown, now: Date): Promise<{ status: number; body: unknown }> {
  const problem = schemaProblem("RatingRequest", body);
  if (problem !== null) throw badRequest(`The rating is not valid: ${problem}.`, "invalid_body");
  const rating = body as RatingBody;
  if (!rating.skip && rating.stars === undefined) throw badRequest("Give 1 to 5 stars, or skip.", "stars_missing");
  // v0.18.10 (contract.json#finish.tips): the rider's tip is given by the rating route after the rating (giveTip).
  if (rating.tip && who.actor !== "rider") throw badRequest("Only the rider tips.", "tip_not_allowed");
  // contract v0.9.0: tags from the fixed list for this rater (contract.json#ratings.tags).
  if (!rating.skip) checkTags(who.actor, rating.tags ?? []);
  const trip = await lockOwnTrip(trx, tripId, who);
  const allowed =
    trip.status === "completed" ||
    // v0.18.10 (owner G8 Q1): after the rider's early end both sides rate.
    (trip.status === "cancelled_by_rider" && trip.ended_by_command === "end_early");
  const column = who.actor === "rider" ? "rating_status" : "driver_rating_status";
  if (!allowed || trip[column] !== "pending") {
    throw new ApiError("invalid_transition", allowed ? "This trip was already rated." : "This trip cannot be rated.", { reason: allowed ? "already_rated" : "rating_not_allowed", projection: tripProjection(trip, who.actor) });
  }
  // v0.18.40 §64 (fix job 10, contract.json#blockedPairs.rating): "don't match again" only at ≤ atStars while on;
  // the pair is written with the rating and the answer is unchanged (owner "Never told").
  if (rating.dontMatchAgain === true) {
    const dm = await dontMatchSettings(trx, trip.zone_id);
    if (rating.skip || !dm.on || rating.stars === undefined || rating.stars > dm.atStars || !trip.driver_id) {
      throw badRequest(`"Don't match again" needs ${dm.atStars} star(s) or fewer.`, "dont_match_not_allowed");
    }
    await blockPair(trx, { riderId: trip.rider_id, driverId: trip.driver_id, by: who.actor, tripId }, now);
  }
  let answer: Record<string, unknown> | null = null;
  if (rating.skip) {
    await trx.updateTable("trips").set({ [column]: "skipped" }).where("trip_id", "=", tripId).execute();
  } else {
    const stars = rating.stars!;
    const tags = rating.tags ?? [];
    // v0.18.15 (contract.json#reviewRules, owner G14 Q6): a comment with a listed word is hidden at once, like an admin hide.
    const { rules, country } = await ratingRules(trx, trip);
    const badWord = hasBadWord(rating.comment, rules);
    await trx.insertInto("ratings").values({ trip_id: tripId, rater: who.actor, stars, tags, comment: rating.comment ?? null, at: now, ...(badWord ? { hidden: true, hidden_by: "system", hidden_at: now, hide_reason: "bad_word" } : {}) }).execute();
    await trx.updateTable("trips").set({ [column]: "submitted" }).where("trip_id", "=", tripId).execute();
    // The rider rates the driver; the driver rates the rider. A hidden rating does not count.
    if (who.actor === "rider" && trip.driver_id) {
      if (!badWord) await trx.updateTable("drivers").set({ rating_sum: sql`rating_sum + ${stars}`, rating_count: sql`rating_count + 1` }).where("driver_id", "=", trip.driver_id).execute();
      await applyPersonRules(trx, "driver", trip.driver_id, country, rules, now);
    } else if (who.actor === "driver") {
      if (!badWord) await trx.updateTable("riders").set({ rating_sum: sql`rating_sum + ${stars}`, rating_count: sql`rating_count + 1` }).where("rider_id", "=", trip.rider_id).execute();
      await applyPersonRules(trx, "rider", trip.rider_id, country, rules, now);
    }
    answer = { tripId, from: who.actor, stars, tags, ...(rating.comment ? { comment: rating.comment } : {}) };
  }
  // Not a lifecycle change: no new version; rating_updated passes the terminal gate (§4).
  const updated = await trx.selectFrom("trips").selectAll().where("trip_id", "=", tripId).executeTakeFirstOrThrow();
  await appendTripEvent(trx, { tripId, kind: "rating_updated", version: updated.version, occurredAt: now, projection: tripProjection(updated, "admin", { sequence: Number(updated.sequence) + 1 }) });
  return answer === null ? { status: 204, body: null } : { status: 201, body: answer };
}
