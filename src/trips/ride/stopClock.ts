/**
 * v0.18.108 (job C9b, contract.json#autoArrive.stops.away / back / money, #stopWaits.charge; owner 2026-11-02 "At the
 * pickup AND at stops", Rules decisions/driver-g7.md:84): the wait at a middle stop stands still while the driver is
 * farther than the trip's leaveMeters and goes on at a new arrival. Pure (no imports but types), beside the pickup's
 * waitingClock.ts, so the fare, the projection and the job read the same numbers.
 */

/** One stop the driver arrived at (trips.stop_visits, jsonb; the new fields are absent on a visit before v0.18.108). */
export type StopVisit = {
  stopIndex: number;
  arrivedAt: string;
  leftAt?: string;
  /** v0.18.108: how the stop was arrived ("auto": the server's geofence job; "tap": the driver). */
  arrivedBy?: "auto" | "tap";
  /** v0.18.108: the stop wait stands still from `since` (kept on a stop left while away, as a record). */
  away?: { since: string };
  /** v0.18.108: seconds of finished away spells at this stop. */
  pausedSeconds?: number;
  /** v0.18.108: finished away spells at this stop. */
  pauseCount?: number;
};

const clamp = (t: number, lo: number, hi: number) => Math.min(Math.max(t, lo), hi);

/** The wait stops: away.since = the fix's moment, never before arrivedAt nor after now. Already away or left: unchanged. */
export function stopAwayFrom(visit: StopVisit, measuredAt: Date, now: Date): StopVisit {
  if (visit.away || visit.leftAt) return visit;
  const since = clamp(measuredAt.getTime(), Date.parse(visit.arrivedAt), now.getTime());
  return { ...visit, away: { since: new Date(since).toISOString() } };
}

/** The new arrival: pausedSeconds += resumeAt − away.since (resumeAt never before since nor after now), pauseCount + 1. */
export function stopBackAt(visit: StopVisit, measuredAt: Date, now: Date): StopVisit {
  if (!visit.away) return visit;
  const since = Date.parse(visit.away.since);
  const resume = clamp(measuredAt.getTime(), since, Math.max(since, now.getTime()));
  const stopped = Math.max(0, Math.floor((resume - since) / 1000));
  const { away: _gone, ...rest } = visit;
  return { ...rest, pausedSeconds: (visit.pausedSeconds ?? 0) + stopped, pauseCount: (visit.pauseCount ?? 0) + 1 };
}

/** Waited seconds (before the free minutes): (min(until, away.since) − arrivedAt) − pausedSeconds, at least 0; until = leftAt, else `end`. */
export function stopWaitedSeconds(visit: StopVisit, end: Date): number {
  let until = visit.leftAt ? Date.parse(visit.leftAt) : end.getTime();
  if (visit.away) until = Math.min(until, Date.parse(visit.away.since));
  return Math.max(0, Math.floor((until - Date.parse(visit.arrivedAt)) / 1000) - (visit.pausedSeconds ?? 0));
}

/** trips.stop_visits sorted by stop index (null / absent = none). */
export const visitsOf = (trip: { stop_visits: unknown }): StopVisit[] => ((trip.stop_visits as StopVisit[] | null) ?? []).slice().sort((a, b) => a.stopIndex - b.stopIndex);

/** The stop the driver goes to next: every earlier stop has an arrival, this one has none (null: all arrived / no stops). */
export function nextStopIndex(stopCount: number, visits: StopVisit[]): number | null {
  for (let i = 0; i < stopCount; i++) if (!visits.some((v) => v.stopIndex === i)) return visits.some((v) => v.stopIndex > i) ? null : i;
  return null;
}

/** The stop the driver is at: arrived, not left (at most one: an arrival closes the earlier ones). */
export const openVisitOf = (visits: StopVisit[]): StopVisit | undefined => visits.find((v) => !v.leftAt);

/** Arriving at stop i (tap or auto): an earlier stop still open gets leftAt = now (its away stays, as a record). */
export function arriveAtStop(visits: StopVisit[], stopIndex: number, now: Date, by: "auto" | "tap"): StopVisit[] {
  const at = now.toISOString();
  return [...visits.map((v) => (v.leftAt ? v : { ...v, leftAt: at })), { stopIndex, arrivedAt: at, arrivedBy: by }];
}

/**
 * v0.18.108 round 2 (supervisor M1, contract.json#autoArrive.stops.auto): one fix counts toward the auto arrival at the
 * next stop when it is within arriveMeters of it and, while an earlier stop is open and not away, farther than
 * arriveMeters from that open stop (two stops close together: he is still waiting at the open one).
 */
export function countsForNextStop(arriveMeters: number, toNext: number, open: { away: boolean; meters: number } | null): boolean {
  return toNext <= arriveMeters && (open === null || open.away || open.meters > arriveMeters);
}
