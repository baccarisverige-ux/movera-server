import { exclusiveOnly } from "../../reservations/service.js";
import type { Executor, Trx } from "../../db/db.js";
import type { TripRow } from "../../db/tripLog.js";
import { scheduleTimer } from "../../jobs/timers.js";
import { liveDocument } from "../../config/service.js";
import { DISPATCH_FIX_MAX_AGE_SECONDS, STALE_AFTER_SECONDS } from "../../drivers/service.js";
import { busyOf, newSearch, searchEndSec, startOf, waitingSteps, type DispatchDoc, type SearchState } from "../engine.js";
import { ROUND, STEP, END, type Step, localTime, controlOf } from "./shared.js";

/* ---------------------------------------------------------------- start */

/** BL-Q7 (owner): the zone's rules with Exclusive only (widening), never Radar — for a booked ride past its pickup time. */
export function exclusiveOnlyDoc(doc: DispatchDoc): DispatchDoc {
  return { ...doc, exclusive: { ...doc.exclusive, on: true, then: "widen" }, radar: { ...doc.radar, on: false } };
}

/** Called in the transaction that puts a live trip into searching. */
export async function startSearch(trx: Trx, trip: TripRow, now: Date): Promise<void> {
  // v0.18.17 (owner BL-Q7): a booked ride past its pickup time goes out as Exclusive offers only.
  const forced = exclusiveOnly(trip, now) ? ("exclusive" as const) : null;
  const live = await liveDocument<DispatchDoc>(trx, "dispatch", trip.zone_id);
  if (live === null) {
    // No published rules: nothing to dispatch with. The trip waits for an admin (alert) until it expires.
    await trx.insertInto("searches").values({ trip_id: trip.trip_id, started_at: now, start_mode: null, busy: 0, document: JSON.stringify({}), doc_version: 0, state: null, end_at: new Date(now.getTime() + 10 * 60_000), updated_at: now }).onConflict((c) => c.column("trip_id").doNothing()).execute();
    await scheduleTimer(trx, { kind: END, refId: trip.trip_id, dueAt: new Date(now.getTime() + 10 * 60_000), payload: {} });
    return;
  }
  // BL-Q7: Exclusive only (widening), never Radar, for a booked ride past its pickup time.
  const doc: DispatchDoc = forced ? exclusiveOnlyDoc(live.document) : live.document;
  const waiting = await trx.selectFrom("trips").select((eb) => eb.fn.countAll<string>().as("n")).where("zone_id", "=", trip.zone_id).where("status", "in", ["requested", "searching", "offered"]).executeTakeFirstOrThrow();
  const free = await freeDriversInZone(trx, trip.zone_id, now);
  const busy = busyOf(Number(waiting.n), free);
  const control = await controlOf(trx, trip.zone_id);
  const start = forced ? { mode: forced } : startOf(doc, control, busy, localTime(doc.timeZone, now));
  const mode = start?.mode ?? null;
  const steps: Step[] = waitingSteps(doc).map((w) => ({ id: w.id, kind: w.kind, message: w.message, extraMin: w.extraMin ?? null, atSec: w.atSec }));
  const endAt = new Date(now.getTime() + searchEndSec(doc) * 1000);
  const values = {
    trip_id: trip.trip_id,
    started_at: now,
    start_mode: mode,
    busy,
    document: JSON.stringify(doc),
    doc_version: live.version,
    state: start ? JSON.stringify(newSearch(start.mode, start.pending)) : null,
    end_at: endAt,
    steps: JSON.stringify(steps),
    fired: JSON.stringify([]),
    answered: JSON.stringify([]),
    rounds: 0,
    updated_at: now,
  };
  // A trip back in searching after a driver cancel starts a new search; who was asked stays asked (§3.6).
  const previous = await trx.selectFrom("searches").select("state").where("trip_id", "=", trip.trip_id).executeTakeFirst();
  const asked = (previous?.state as SearchState | null)?.asked ?? [];
  if (start && asked.length) values.state = JSON.stringify({ ...newSearch(start.mode, start.pending), asked });
  await trx.insertInto("searches").values(values).onConflict((c) => c.column("trip_id").doUpdateSet(values)).execute();
  for (const step of steps) {
    await scheduleTimer(trx, { kind: STEP, refId: `${trip.trip_id}:${step.id}`, dueAt: new Date(now.getTime() + step.atSec * 1000), payload: { tripId: trip.trip_id, stepId: step.id } });
  }
  await scheduleTimer(trx, { kind: END, refId: trip.trip_id, dueAt: endAt, payload: {} });
  await scheduleTimer(trx, { kind: ROUND, refId: trip.trip_id, dueAt: now, payload: {} });
}

async function freeDriversInZone(ex: Executor, zoneId: string, now: Date): Promise<number> {
  const row = await ex
    .selectFrom("drivers")
    .innerJoin("driver_locations", "driver_locations.driver_id", "drivers.driver_id")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("drivers.online_status", "=", "online")
    .where("driver_locations.zone_id", "=", zoneId)
    .where("driver_locations.received_at", ">", new Date(now.getTime() - STALE_AFTER_SECONDS * 1000))
    .where("driver_locations.measured_at", ">", new Date(now.getTime() - DISPATCH_FIX_MAX_AGE_SECONDS * 1000))
    .executeTakeFirstOrThrow();
  return Number(row.n);
}
