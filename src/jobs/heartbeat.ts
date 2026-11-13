import { sql } from "kysely";
import type { Executor } from "../db/db.js";
import { ALERT_SWEEP } from "../alerts/detector.js";
import { SWEEP_MS } from "../alerts/kinds.js";
import { DRIVER_HOME, NO_FIX_OFFLINE } from "../drivers/presence.js";
import { SMART_SURGE_CHECK } from "../pricing/surge.js";
import { HOUSEKEEPING_KINDS } from "./housekeeping.js";
import { NIGHTLY, SWEEP_IDEMPOTENCY_KEYS } from "./maintenance.js";
import { PAYOUT_CLOSE } from "./payouts.js";

/**
 * S4 B1.28 (owner W1 Q88 "An outside check that wakes you when background jobs stop? — A) Yes"): the recurring server
 * jobs (one timer row each, ref_id 'all', booked again by its own handler) and how often each runs. GET /healthz/jobs
 * answers 503 when one is parked (due 'infinity' after repeated failures), missing (no row), or more than
 * LATE_FACTOR × its period past its due time. Watched by the outside monitor (U9), never by the hosting health check
 * (render.yaml keeps /readyz: a parked job must not make the host restart copies).
 * no_fix_sweep is booked per no_fix_offline run and deleted when done (not recurring); alert_sweep 'poke' rows are
 * one-off; payout_driver (S4 0.14a) is one row per driver (ref_id = driver id), booked by payout_close. None is checked
 * here (a parked payout_driver step raises the system_health alert naming the driver).
 */

const HOUR_MS = 60 * 60 * 1000;

export const RECURRING_JOBS: ReadonlyArray<{ kind: string; everyMs: number }> = [
  // contract.json#alertDesk.serverDetection.sweepSeconds (30 s).
  { kind: ALERT_SWEEP, everyMs: SWEEP_MS },
  // contract.json#driverHome.setOffline.jobEverySeconds (30 s).
  { kind: NO_FIX_OFFLINE, everyMs: DRIVER_HOME.setOffline.jobEverySeconds * 1000 },
  { kind: SMART_SURGE_CHECK, everyMs: 60_000 },
  // The hourly sweep (S4 0.14a: it only books itself again; kept so the rollback of 0.14a finds its row).
  { kind: SWEEP_IDEMPOTENCY_KEYS, everyMs: HOUR_MS },
  // S4 0.14a: the one payout job, hourly (5 s between batches while a backlog is listed).
  { kind: PAYOUT_CLOSE, everyMs: HOUR_MS },
  // Every housekeeping job is hourly (5 s while a backlog is left).
  ...HOUSEKEEPING_KINDS.map((kind) => ({ kind, everyMs: HOUR_MS })),
  // Daily at 01:00 UTC: late after 3 days (3 × its period, like every job).
  { kind: NIGHTLY, everyMs: 24 * HOUR_MS },
];

/** A job is late when it is more than this many periods past its due time. */
export const LATE_FACTOR = 3;

export type JobState = { kind: string; state: "parked" | "missing" | "late"; lateSeconds?: number };
export type JobsHeartbeat = { status: "ok" | "late"; checkedAt: string; jobs: JobState[] };

/**
 * One indexed read of the recurring rows (unique (kind, ref_id)), computed per request against `now` (the app clock):
 * nothing kept in memory, so every copy answers the same (Rule 33). Only kind, state and lateness: never last_error,
 * ids or payloads (the route needs no token).
 */
export async function jobsHeartbeat(ex: Executor, now: Date): Promise<JobsHeartbeat> {
  const kinds = RECURRING_JOBS.map((job) => job.kind);
  const { rows } = await sql<{ kind: string; parked: boolean; due_ms: number | null }>`
    SELECT kind, due_at = 'infinity' AS parked,
           CASE WHEN due_at = 'infinity' THEN NULL ELSE (extract(epoch FROM due_at) * 1000)::float8 END AS due_ms
    FROM timers WHERE ref_id = 'all' AND kind IN (${sql.join(kinds)})`.execute(ex);
  const byKind = new Map(rows.map((row) => [row.kind, row]));
  const jobs: JobState[] = [];
  for (const { kind, everyMs } of RECURRING_JOBS) {
    const row = byKind.get(kind);
    if (row === undefined) jobs.push({ kind, state: "missing" });
    else if (row.parked || row.due_ms === null) jobs.push({ kind, state: "parked" });
    else {
      const lateMs = now.getTime() - Number(row.due_ms);
      if (lateMs > LATE_FACTOR * everyMs) jobs.push({ kind, state: "late", lateSeconds: Math.floor(lateMs / 1000) });
    }
  }
  return { status: jobs.length === 0 ? "ok" : "late", checkedAt: now.toISOString(), jobs };
}
