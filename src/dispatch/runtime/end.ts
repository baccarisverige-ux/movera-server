import { searchesAgain } from "../../reservations/service.js";
import type { Trx } from "../../db/db.js";
import { appendTripEvent, lockTrip, type TripRow } from "../../db/tripLog.js";
import { ApiError } from "../../http/errors.js";
import { cancelTimer, scheduleTimer, type TimerHandler } from "../../jobs/timers.js";
import { endTripSends } from "../radarSends.js";
import { applyCommand } from "../../trips/commands.js";
import { tripProjection } from "../../trips/projection.js";
import { ROUND, STEP, END, type Step, OPEN_STATUSES, lockTripNow } from "./shared.js";
import { startSearch } from "./start.js";
import { offerView, FeedQueue, closeOpenOffers } from "./offers.js";
import { loadSearch } from "./rounds.js";

/* ---------------------------------------------------------------- rider-waiting steps and the end */

export async function endSearchTimers(trx: Trx, tripId: string) {
  await cancelTimer(trx, ROUND, tripId);
  await cancelTimer(trx, END, tripId);
  await trx.deleteFrom("timers").where("kind", "=", STEP).where("ref_id", "like", `${tripId}:%`).execute();
}

/** A trip that leaves the search some other way (rider cancel, admin cancel): offers withdrawn, timers gone. */
export async function stopSearch(trx: Trx, trip: TripRow, now: Date): Promise<void> {
  const queue = new FeedQueue();
  await closeOpenOffers(trx, trip, "withdrawn", now, queue);
  await queue.flush(trx, now);
  await endSearchTimers(trx, trip.trip_id);
  await endTripSends(trx, trip.trip_id, "trip_over", null, now);
}

/** Puts the step on the rider's projection without a version change (contract.json#dispatch.searchStep). */
async function showStep(trx: Trx, trip: TripRow, step: Step, now: Date) {
  const searchStep = { id: step.id, kind: step.kind, message: step.message, extraMin: step.extraMin ?? null, at: now.toISOString() };
  await trx.updateTable("trips").set({ search_step: JSON.stringify(searchStep) }).where("trip_id", "=", trip.trip_id).execute();
  const updated = await trx.selectFrom("trips").selectAll().where("trip_id", "=", trip.trip_id).executeTakeFirstOrThrow();
  const sequence = Number(updated.sequence) + 1;
  await appendTripEvent(trx, { tripId: trip.trip_id, kind: "trip_projection", version: updated.version, occurredAt: now, projection: { ...tripProjection(updated, "admin", { sequence }), searchStep } });
}

export const stepHandler: TimerHandler = async (trx, timer) => {
  const now = timer.firedAt;
  const { tripId, stepId } = timer.payload as { tripId: string; stepId: string };
  const trip = await lockTripNow(trx, tripId);
  if (!trip) return;
  const search = await loadSearch(trx, tripId);
  if (!search || !OPEN_STATUSES.includes(trip.status)) return;
  const step = (search.steps as Step[]).find((s) => s.id === stepId);
  if (!step || (search.fired as string[]).includes(stepId)) return;
  // Only busy ends the search at its own time; any other step at or after the end never shows.
  if (step.kind !== "busy" && now.getTime() >= search.end_at.getTime()) return;
  await trx.updateTable("searches").set({ fired: JSON.stringify([...(search.fired as string[]), stepId]), updated_at: now }).where("trip_id", "=", tripId).execute();
  if (step.kind === "busy") {
    await showStep(trx, trip, step, now);
    await expireSearch(trx, tripId, now);
    return;
  }
  await showStep(trx, trip, step, now);
};

export const endHandler: TimerHandler = async (trx, timer) => {
  await expireSearch(trx, timer.refId, timer.firedAt);
};

async function expireSearch(trx: Trx, tripId: string, now: Date) {
  const locked = await lockTripNow(trx, tripId);
  if (!locked || !OPEN_STATUSES.includes(locked.status)) return;
  let trip = locked;
  const queue = new FeedQueue();
  // v0.18.17 (contract.json#bookLater.plan, owner Q3 "keep searching"): a booked ride's search that ends before the
  // pickup time starts again; after the pickup time it ends like a live ride's.
  if (searchesAgain(trip, now)) {
    await closeOpenOffers(trx, trip, "withdrawn", now, queue);
    await queue.flush(trx, now);
    await endSearchTimers(trx, tripId);
    if (trip.status === "offered") trip = await applyCommand(trx, trip, { command: "offer_lapsed", actor: "system", now });
    // A new round asks everyone again (a driver who said no an hour ago may say yes now).
    await trx.updateTable("searches").set({ state: null }).where("trip_id", "=", tripId).execute();
    await startSearch(trx, trip, now);
    return;
  }
  // Deep fix 2026-11-02 (MED "search end counts as miss"): the search ending takes the offers back (withdrawn) — the
  // driver did not let them run out, so they never count as missed offers for auto offline.
  await closeOpenOffers(trx, trip, "withdrawn", now, queue);
  await queue.flush(trx, now);
  trip = await trx.selectFrom("trips").selectAll().where("trip_id", "=", tripId).executeTakeFirstOrThrow();
  await applyCommand(trx, trip, { command: "expire", actor: "system", now, set: { ended_by_command: "expire" } });
  await endSearchTimers(trx, tripId);
  await endTripSends(trx, tripId, "search_ended", null, now);
}

/** POST /trips/{tripId}/keep-waiting (owner decision 24). */
export async function keepWaiting(trx: Trx, riderId: string, tripId: string, answer: "wait" | "stop", now: Date, cancel: (trip: TripRow) => Promise<TripRow>, expectedVersion?: number): Promise<TripRow> {
  const trip = await lockTrip(trx, tripId);
  if (trip.rider_id !== riderId) throw new ApiError("not_found", "No such trip.", { reason: "trip_not_found" });
  if (expectedVersion !== undefined && expectedVersion !== trip.version) {
    throw new ApiError("version_mismatch", "The trip changed since you last saw it.", { projection: tripProjection(trip, "rider") });
  }
  const search = await loadSearch(trx, tripId);
  const step = trip.search_step as { id: string; kind: string; extraMin: number | null } | null;
  const answered = (search?.answered as string[] | undefined) ?? [];
  if (!search || !OPEN_STATUSES.includes(trip.status) || step?.kind !== "keep_waiting" || answered.includes(step.id)) {
    throw new ApiError("invalid_transition", "There is no question to answer now.", { projection: tripProjection(trip, "rider") });
  }
  await trx.updateTable("searches").set({ answered: JSON.stringify([...answered, step.id]), updated_at: now }).where("trip_id", "=", tripId).execute();
  if (answer === "stop") return cancel(trip);
  const endAt = new Date(search.end_at.getTime() + (step.extraMin ?? 0) * 60_000);
  const steps = (search.steps as Step[]).map((s) => (s.kind === "busy" && !(search.fired as string[]).includes(s.id) ? { ...s, atSec: Math.max(s.atSec, (endAt.getTime() - search.started_at.getTime()) / 1000) } : s));
  await trx.updateTable("searches").set({ end_at: endAt, steps: JSON.stringify(steps), updated_at: now }).where("trip_id", "=", tripId).execute();
  await scheduleTimer(trx, { kind: END, refId: tripId, dueAt: endAt, payload: {} });
  for (const s of steps.filter((s) => s.kind === "busy" && !(search.fired as string[]).includes(s.id))) {
    await scheduleTimer(trx, { kind: STEP, refId: `${tripId}:${s.id}`, dueAt: new Date(search.started_at.getTime() + s.atSec * 1000), payload: { tripId, stepId: s.id } });
  }
  return trx.selectFrom("trips").selectAll().where("trip_id", "=", tripId).executeTakeFirstOrThrow();
}

/** Closes a driver's open offers on other trips, one trip at a time (trip → offer → driver). */
export const withdrawHandler: TimerHandler = async (trx, timer) => {
  const driverId = timer.refId;
  const now = timer.firedAt;
  const open = await trx.selectFrom("offers").select(["offer_id", "trip_id"]).where("driver_id", "=", driverId).where("status", "=", "open").orderBy("trip_id").execute();
  const queue = new FeedQueue();
  for (const { trip_id } of open) {
    const trip = await lockTripNow(trx, trip_id);
    if (!trip) continue;
    const offers = await trx.selectFrom("offers").selectAll().where("trip_id", "=", trip_id).where("driver_id", "=", driverId).where("status", "=", "open").forUpdate().execute();
    for (const offer of offers) {
      await trx.updateTable("offers").set({ status: "withdrawn", version: offer.version + 1, answered_at: now }).where("offer_id", "=", offer.offer_id).execute();
      queue.push(driverId, "offer_withdrawn", offerView({ ...offer, status: "withdrawn", version: offer.version + 1 }, trip));
    }
    const left = await trx.selectFrom("offers").select((eb) => eb.fn.countAll<string>().as("n")).where("trip_id", "=", trip_id).where("status", "=", "open").executeTakeFirstOrThrow();
    if (Number(left.n) === 0 && trip.status === "offered") await scheduleTimer(trx, { kind: ROUND, refId: trip_id, dueAt: now, payload: {} });
  }
  await queue.flush(trx, now);
};
