import type { Waiting } from "./shared.js";

/**
 * v0.18.93 (job C9, contract.json#autoArrive.away / back / money): the pickup waiting clock that stands still while the
 * driver is farther than the trip's leaveMeters, pure (no imports but types), so the projection and the fare read it.
 */

const clamp = (t: number, lo: number, hi: number) => Math.min(Math.max(t, lo), hi);

/** clockAt(t) (contract.json#autoArrive.money): away.since while the clock stands still, else t. */
export function clockAt(waiting: Pick<Waiting, "away">, now: Date): Date {
  return waiting.away ? new Date(Math.min(Date.parse(waiting.away.since), now.getTime())) : now;
}

/** The paid waiting seconds at `now` (board, read time): whole seconds after freeUntil on the clock, at least 0. */
export function chargedSecondsAt(waiting: Pick<Waiting, "away" | "freeUntil">, now: Date): number {
  return Math.max(0, Math.floor((clockAt(waiting, now).getTime() - Date.parse(waiting.freeUntil)) / 1000));
}

/** The clock stops: away.since = the fix's moment, never before the arrival nor after now. */
export function awayFrom(waiting: Waiting, measuredAt: Date, now: Date): Waiting {
  if (waiting.away) return waiting;
  const since = clamp(measuredAt.getTime(), Date.parse(waiting.arrivedAt), now.getTime());
  return { ...waiting, away: { since: new Date(since).toISOString() } };
}

/** The new arrival: freeUntil / noShowAt move later by the stopped seconds after waitFrom (contract.json#autoArrive.back). */
export function backAt(waiting: Waiting, measuredAt: Date, now: Date): Waiting {
  if (!waiting.away) return waiting;
  const since = Date.parse(waiting.away.since);
  const resume = clamp(measuredAt.getTime(), since, Math.max(since, now.getTime()));
  const waitFrom = Date.parse(waiting.waitFrom ?? waiting.arrivedAt);
  const stopped = Math.max(0, Math.floor((resume - Math.max(since, waitFrom)) / 1000));
  const moved = (iso: string) => new Date(Date.parse(iso) + stopped * 1000).toISOString();
  const { away: _gone, ...rest } = waiting;
  return { ...rest, freeUntil: moved(waiting.freeUntil), noShowAt: moved(waiting.noShowAt), pausedSeconds: (waiting.pausedSeconds ?? 0) + stopped, pauseCount: (waiting.pauseCount ?? 0) + 1 };
}

