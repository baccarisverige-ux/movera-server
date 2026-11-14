import { contract } from "../contract/contract.js";
import type { Executor, Trx } from "../db/db.js";
import type { TripsTable } from "../db/schema.js";
import { appendTripEvent, lockTrip, type TripRow } from "../db/tripLog.js";
import { ApiError } from "../http/errors.js";
import { nextStatus, isTripStatus, TERMINAL, type Actor } from "../rules/transitions.js";
import { tripProjection, type Viewer } from "./projection.js";
import type { Updateable } from "kysely";
import { momentOf, pushTripMoment } from "../notifications/tripPush.js";
import { driverMomentOf, pushDriverTripMoment } from "../notifications/driverTripPush.js";
import { FREE_END_COLUMNS } from "./ride/money.js";

/**
 * Every lifecycle change goes through here (contract §3): the transition table decides (else 409
 * invalid_transition with the projection), the version goes up by one, and one trip_projection event with the
 * new projection is appended (§4). The caller holds the trip lock (lockTrip) and checked expectedVersion.
 */

const viewerOf = (actor: Actor): Viewer => (actor === "system" ? "admin" : actor);

/**
 * v0.18.51 §73 (contract.json#driverReservationsLive.when): the statuses of the drivers' booked-ride lists (GET
 * /driver/reservations: open = requested, accepted = held). A change into or out of them, or a change of a ride in
 * them, is the list change the drivers' streams hear about (created, accepted, released, cancelled, rescheduled, started).
 */
const LISTED: ReadonlySet<string> = new Set(["requested", "accepted"]);
/** Before the driver drives: a booked ride being searched (searching, offered) that ends is "cancelled" too. */
const BEFORE_START: ReadonlySet<string> = new Set(["requested", "searching", "offered", "accepted"]);
/**
 * BQ-M27 (M24 supervisor N2; contract.json#moneyBase.commissionRow.admin): the system ends with no paid ride — a search
 * that runs out or a booked ride with no driver (expired; also after a driver gave the trip back before pickup) and a
 * system cancel (cancelled_by_system) — pay nobody: the quote's driver pay, pickup pay, bonus and commission are not kept
 * on the trip (FREE_END_COLUMNS, as the free rider cancel and the admin cancel since v0.18.92 G1). A caller's own `set`
 * still wins (a future system end that carries money says so itself).
 */
const FREE_SYSTEM_ENDS: ReadonlySet<string> = new Set(["expired", "cancelled_by_system"]);

const listChange = (from: string, to: string) => LISTED.has(from) || LISTED.has(to) || (BEFORE_START.has(from) && isTripStatus(to) && TERMINAL.has(to));

export async function applyCommand(
  trx: Trx,
  trip: TripRow,
  input: { command: string; actor: Actor; now: Date; set?: Updateable<TripsTable> },
): Promise<TripRow> {
  if (!isTripStatus(trip.status)) throw new Error(`Trip ${trip.trip_id} has an unknown status ${trip.status}`);
  const to = nextStatus(trip.status, input.command, input.actor, trip.kind);
  if (to === null) {
    throw new ApiError("invalid_transition", `A ${input.actor} cannot ${input.command} a trip that is ${trip.status}.`, {
      projection: tripProjection(trip, viewerOf(input.actor)),
    });
  }
  const version = trip.version + 1;
  await trx
    .updateTable("trips")
    .set({ ...(FREE_SYSTEM_ENDS.has(to) ? FREE_END_COLUMNS : {}), ...(input.set ?? {}), status: to, version, updated_at: input.now })
    .where("trip_id", "=", trip.trip_id)
    .execute();
  await expireStaleRouteChange(trx, trip, input.now);
  const updated = await trx.selectFrom("trips").selectAll().where("trip_id", "=", trip.trip_id).executeTakeFirstOrThrow();
  // The stored event carries the full projection; each stream redacts it for its viewer (§4).
  const sequence = Number(updated.sequence) + 1;
  // v0.18.50 §72 (L7, contract.json#lifecycle0_18_50.l7): a driver's give-back before boarding (his cancel and the
  // take-backs counted as his cancel) is told as driver_cancelled, so the rider can tell it from an admin reassign.
  const driverGaveBack = input.actor === "driver" && input.command === "cancel" && trip.driver_id !== null && (to === "searching" || to === "requested");
  await appendTripEvent(trx, { tripId: trip.trip_id, kind: driverGaveBack ? "driver_cancelled" : "trip_projection", version, occurredAt: input.now, projection: tripProjection(updated, "admin", { sequence }), reservations: listChange(trip.status, to) });
  // v0.18.13 (contract.json#riderTripPush): the rider's push for the key moments (never for his own cancel).
  const moment = momentOf(trip, updated);
  if (moment !== null) await pushTripMoment(trx, moment === "driver_changed" ? trip : updated, moment, input.now);
  // v0.18.50 §72 (owner L1, contract.json#driverTripPush): the driver hears when someone else ends or takes his trip.
  const driverMoment = driverMomentOf(trip, input.command, input.actor);
  if (driverMoment !== null) await pushDriverTripMoment(trx, trip.driver_id!, updated, driverMoment, input.now);
  return { ...updated, sequence: String(sequence) };
}

/** Is this trip the caller's own? The rider who booked it, the driver on it now; admins and the server see every trip. */
export function ownsTrip(trip: Pick<TripRow, "rider_id" | "driver_id">, who: { actor: Actor; subjectId: string }): boolean {
  return (
    who.actor === "admin" || who.actor === "system" ||
    (who.actor === "rider" && trip.rider_id === who.subjectId) ||
    (who.actor === "driver" && trip.driver_id === who.subjectId)
  );
}

/** Lock a trip the caller may act on. Another rider's or driver's trip is 404, as if it did not exist (§3). */
export async function lockOwnTrip(trx: Trx, tripId: string, who: { actor: Actor; subjectId: string }): Promise<TripRow> {
  const trip = await lockTrip(trx, tripId);
  if (!ownsTrip(trip, who)) throw new ApiError("not_found", "No such trip.", { reason: "trip_not_found" });
  return trip;
}

/** The same for a read, without the lock. */
export async function readOwnTrip(ex: Executor, tripId: string, who: { actor: Actor; subjectId: string }): Promise<TripRow> {
  const trip = await ex.selectFrom("trips").selectAll().where("trip_id", "=", tripId).executeTakeFirst();
  if (trip === undefined || !ownsTrip(trip, who)) throw new ApiError("not_found", "No such trip.", { reason: "trip_not_found" });
  return trip;
}

/** The optimistic-concurrency check with the caller's own view as the projection. */
export function expectVersion(trip: TripRow, expectedVersion: number, viewer: Viewer): void {
  if (trip.version !== expectedVersion) {
    throw new ApiError("version_mismatch", "The trip changed since you last saw it.", { projection: tripProjection(trip, viewer) });
  }
}


/**
 * A change that is not a lifecycle step (an admin's bonus, fare correction, refund): new version, one event.
 * After a terminal status only afterTerminal kinds pass the apps' gate (§4), so money changes then go out as
 * payment_updated.
 */
const ROUTE_CHANGE_STATUSES: ReadonlySet<string> = new Set((contract as unknown as { onTrip: { routeChange: { statuses: string[] } } }).onTrip.routeChange.statuses);

/**
 * v0.18.9 checker HIGH: a route change still waiting when the trip leaves the route-change statuses (complete, cancel,
 * no-show) or changes driver (reassign) can never be answered any more: it expires in the same write.
 */
async function expireStaleRouteChange(trx: Trx, before: TripRow, now: Date): Promise<void> {
  const after = await trx.selectFrom("trips").select(["status", "driver_id", "route_change"]).where("trip_id", "=", before.trip_id).executeTakeFirstOrThrow();
  const change = after.route_change as { status?: string } | null;
  if (change?.status !== "pending") return;
  if (ROUTE_CHANGE_STATUSES.has(after.status) && after.driver_id === before.driver_id) return;
  await trx.updateTable("trips").set({ route_change: JSON.stringify({ ...change, status: "expired", answeredAt: now.toISOString(), answeredBy: "system" }) }).where("trip_id", "=", before.trip_id).execute();
}

export async function touchTrip(trx: Trx, trip: TripRow, set: Updateable<TripsTable>, now: Date): Promise<TripRow> {
  const version = trip.version + 1;
  await trx.updateTable("trips").set({ ...set, version, updated_at: now }).where("trip_id", "=", trip.trip_id).execute();
  if (set.status !== undefined || set.driver_id !== undefined) await expireStaleRouteChange(trx, trip, now);
  const updated = await trx.selectFrom("trips").selectAll().where("trip_id", "=", trip.trip_id).executeTakeFirstOrThrow();
  const sequence = Number(updated.sequence) + 1;
  const kind = isTripStatus(updated.status) && TERMINAL.has(updated.status) ? "payment_updated" : "trip_projection";
  await appendTripEvent(trx, { tripId: trip.trip_id, kind, version, occurredAt: now, projection: tripProjection(updated, "admin", { sequence }), reservations: listChange(trip.status, updated.status) });
  return { ...updated, sequence: String(sequence) };
}
