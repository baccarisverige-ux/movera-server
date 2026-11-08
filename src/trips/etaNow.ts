import type { Trx } from "../db/db.js";
import { haversineKm } from "../maps/routing.js";
import { ARRIVE_MAX_METERS, COMPLETE_NEAR_DROPOFF_METERS } from "./ride/shared.js";

/**
 * The ETA timer's kind and the events that run its next tick at once (trips/eta.ts has the tick itself). A small
 * module of its own, so the driver's position path and the driver's steps can use it without loading eta.ts (no new
 * import cycle; dispatch/runtime.ts notes the load-order crash such a cycle once caused).
 */
export const TRIP_ETA = "trip_eta";

type Place = { lat: number; lng: number };

const TO_PICKUP = new Set(["accepted", "driver_to_pickup"]);
const ON_BOARD = new Set(["rider_onboard", "in_trip", "approaching_dropoff"]);

/** Where the car goes in this status (null: waiting at the pickup, or not under way). */
export const statusTarget = (status: string): "pickup" | "dropoff" | null => (TO_PICKUP.has(status) ? "pickup" : ON_BOARD.has(status) ? "dropoff" : null);

/**
 * Live 5+5 2026-11-08 (problems 4 and 5): the 30 s tick alone left the rider with "4 min · 1,3 km" for up to 30 s while
 * the driver stood at the pickup, and with the pickup ETA at the trip start. On these events the NEXT tick is moved
 * forward (never back, never a second timer: one timer per trip as before, so no new polling and safe with several
 * server copies): a driver position that enters the arrive radius of where the car goes (pickup or drop-off), moves
 * on inside it (etaMovedInside, live 5+5 run 2) or jumps far from the previous one, and boarding. At most one tick per ETA_NOW_GAP_MS after the stored ETA was computed.
 */
export const ETA_NOW_GAP_MS = 5_000;
/** A position this far from the previous one (a gap in the fixes): the stored ETA was computed somewhere else. */
export const ETA_JUMP_METERS = 1_000;
/**
 * Live 5+5 run 2 (fix 2 not working): inside the arrive radius, a position this far from where the stored ETA was
 * computed runs the tick again. Entering the radius alone was not enough: on staging the fix that entered was 244 m
 * from the pickup (566 m by road, "2 min · 600 m"), the next ones (122 m, 0 m) were already inside, and the rider kept
 * that ETA until the regular tick 25 s later. 50 m: GPS noise of a car standing at the pickup never reaches it.
 */
export const ETA_NEAR_MOVE_METERS = 50;

type EtaTrip = { trip_id: string; status: string; pickup: unknown; dropoff: unknown; eta: unknown };

/** The new position calls for a fresh ETA now: it entered the arrive radius of the target, or jumped far. */
export function etaNeededNow(trip: EtaTrip, previous: Place | null, latest: Place): boolean {
  const target = statusTarget(trip.status);
  if (target === null) return false;
  const to = (target === "pickup" ? trip.pickup : trip.dropoff) as Place;
  const radius = target === "pickup" ? ARRIVE_MAX_METERS : COMPLETE_NEAR_DROPOFF_METERS;
  const inside = (at: Place) => haversineKm(at, to) * 1000 <= radius;
  if (inside(latest) && (previous === null || !inside(previous))) return true;
  return previous !== null && haversineKm(previous, latest) * 1000 > ETA_JUMP_METERS;
}

/** Inside the arrive radius of the target (pickup or drop-off) in this status. */
function insideTarget(trip: EtaTrip, at: Place): boolean {
  const target = statusTarget(trip.status);
  if (target === null) return false;
  const to = (target === "pickup" ? trip.pickup : trip.dropoff) as Place;
  return haversineKm(at, to) * 1000 <= (target === "pickup" ? ARRIVE_MAX_METERS : COMPLETE_NEAR_DROPOFF_METERS);
}

/**
 * Live 5+5 run 2: inside the arrive radius, the stored ETA was computed ETA_NEAR_MOVE_METERS or more from here (or there
 * is none to this target yet). Where it was computed: the trip's last fix measured at or before the stored ETA's time
 * (the tick routes the driver's newest fix); one primary-key lookup, only for a position inside the radius.
 */
export async function etaMovedInside(trx: Trx, trip: EtaTrip, latest: Place): Promise<boolean> {
  if (!insideTarget(trip, latest)) return false;
  const stored = trip.eta as { target?: string; at: string } | null;
  if (!stored || stored.target !== statusTarget(trip.status)) return true;
  const origin = await trx
    .selectFrom("trip_locations")
    .select(["lat", "lng"])
    .where("trip_id", "=", trip.trip_id)
    .where("measured_at", "<=", new Date(stored.at))
    .orderBy("measured_at", "desc")
    .limit(1)
    .executeTakeFirst();
  // None: the stored ETA came from a fix before the trip (at accept): computed elsewhere.
  return !origin || haversineKm(origin, latest) * 1000 >= ETA_NEAR_MOVE_METERS;
}

/** When the moved tick may run: now, or ETA_NOW_GAP_MS after the stored ETA to the same target (the rate limit). */
function etaDue(trip: EtaTrip, now: Date): Date {
  const stored = trip.eta as { target?: string; at: string } | null;
  const target = statusTarget(trip.status);
  const earliest = stored && stored.target === target ? Date.parse(stored.at) + ETA_NOW_GAP_MS : now.getTime();
  return new Date(Math.max(now.getTime(), earliest));
}

/**
 * From a driver position (drivers/service.ts storeFixes): moves the trip's ETA tick forward when etaNeededNow. Call it
 * BEFORE the trip row is locked or written: it may wait for a tick that runs at this moment (that tick holds this timer
 * and then locks the trip), and the moved tick then reads the new position.
 */
export async function etaOnPosition(trx: Trx, trip: EtaTrip, previous: Place | null, latest: Place, now: Date): Promise<boolean> {
  if (!etaNeededNow(trip, previous, latest) && !(await etaMovedInside(trx, trip, latest))) return false;
  const due = etaDue(trip, now);
  await trx
    .insertInto("timers")
    .values({ kind: TRIP_ETA, ref_id: trip.trip_id, due_at: due, payload: "{}" })
    .onConflict((c) => c.columns(["kind", "ref_id"]).doUpdateSet({ due_at: due, attempts: 0, last_error: null }).where("timers.due_at", ">", due))
    .execute();
  return true;
}

/**
 * At boarding (and at start_trip, for a trip that still has no drop-off ETA): the tick runs now, to the drop-off. For a
 * command that holds the trip lock: a tick running at this moment is not waited for (it waits for this trip lock, then
 * sees the rider on board and routes to the drop-off itself), so the two can never deadlock.
 */
export async function etaNowLocked(trx: Trx, tripId: string, now: Date): Promise<void> {
  const moved = await trx
    .updateTable("timers")
    .set({ due_at: now, attempts: 0, last_error: null })
    .where("timer_id", "in", (eb) => eb.selectFrom("timers").select("timer_id").where("kind", "=", TRIP_ETA).where("ref_id", "=", tripId).where("due_at", ">", now).forUpdate().skipLocked())
    .executeTakeFirst();
  if (moved.numUpdatedRows > 0n) return;
  // None moved: due already, running now (then it is still there for a plain read), or none at all (book one).
  const there = await trx.selectFrom("timers").select("timer_id").where("kind", "=", TRIP_ETA).where("ref_id", "=", tripId).executeTakeFirst();
  if (!there) await trx.insertInto("timers").values({ kind: TRIP_ETA, ref_id: tripId, due_at: now, payload: "{}" }).onConflict((c) => c.columns(["kind", "ref_id"]).doNothing()).execute();
}
