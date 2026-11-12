import { AsyncLocalStorage } from "node:async_hooks";
import { monitorEventLoopDelay } from "node:perf_hooks";
import type { FastifyInstance } from "fastify";

/**
 * Global plan step 63 (T6, T6b): cheap in-process load numbers for the private stress test (T-A, step 68).
 * Everything here is counted in memory by THIS server copy (Rule 33: with several copies each reports its own);
 * no extra database work on the request path. No ids, addresses or secrets are ever kept, only counts and times.
 */

/** Per request: the time spent in database statements, summed by the Kysely log hook (db.ts). */
type RequestTiming = { dbMs: number; dbCount: number };
const requestTiming = new AsyncLocalStorage<RequestTiming>();

/** Called for every finished statement; adds its time to the request it ran for (if any). */
export function recordQuery(ms: number): void {
  const store = requestTiming.getStore();
  if (store === undefined) return;
  store.dbMs += ms;
  store.dbCount += 1;
}

type Lag = { runs: number; lastMs: number; maxMs: number; sumMs: number };
const lanes = new Map<string, Lag>();
let parkedByThisCopy = 0;
const parkedKinds = new Map<string, number>();
let notifyTotal = 0;
/** B1.25: no-token telemetry lines this copy answered 202 but did not store (over its per-minute total). */
const telemetryDropped = { rows: 0, bytes: 0, byKind: new Map<string, number>() };
let openStreams = 0;
let streamsOpened = 0;
/** NOTIFY messages received in each of the last 60 one-second buckets (per-second rate without a timer). */
const notifyBuckets = new Array<number>(60).fill(0);
let notifyBucketSecond = 0;
const startedAt = Date.now();
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();

/** The lane name of a timer lane (kinds it takes, or "general"/"any"). Kinds are code names, never data. */
export function laneName(lane: { kinds?: string[]; exclude?: string[]; name?: string }): string {
  if (lane.name !== undefined) return lane.name;
  if (lane.kinds !== undefined) return lane.kinds.join("+");
  return lane.exclude !== undefined && lane.exclude.length > 0 ? "general" : "any";
}

/** A timer was taken late: `lagMs` = taken − due (never below 0). */
export function recordTimerLag(lane: string, lagMs: number): void {
  const ms = Math.max(0, lagMs);
  let entry = lanes.get(lane);
  if (entry === undefined) lanes.set(lane, (entry = { runs: 0, lastMs: 0, maxMs: 0, sumMs: 0 }));
  entry.runs += 1;
  entry.lastMs = ms;
  entry.sumMs += ms;
  if (ms > entry.maxMs) entry.maxMs = ms;
}

export function recordTimerParked(kind: string): void {
  parkedByThisCopy += 1;
  parkedKinds.set(kind, (parkedKinds.get(kind) ?? 0) + 1);
}

/** B1.25: a no-token telemetry line over this copy's total was not stored. `kind` is a code name (log/analytics/crash). */
export function recordTelemetryNotStored(kind: string, bytes: number): void {
  telemetryDropped.rows += 1;
  telemetryDropped.bytes += bytes;
  telemetryDropped.byKind.set(kind, (telemetryDropped.byKind.get(kind) ?? 0) + 1);
}

function rollNotify(nowSecond: number): void {
  if (nowSecond - notifyBucketSecond >= 60) notifyBuckets.fill(0);
  else for (let s = notifyBucketSecond + 1; s <= nowSecond; s++) notifyBuckets[s % 60] = 0;
  notifyBucketSecond = Math.max(notifyBucketSecond, nowSecond);
}

export function recordNotify(now = Date.now()): void {
  const second = Math.floor(now / 1000);
  rollNotify(second);
  notifyBuckets[second % 60]! += 1;
  notifyTotal += 1;
}

export function streamOpened(): void {
  openStreams += 1;
  streamsOpened += 1;
}
export function streamClosed(): void {
  openStreams = Math.max(0, openStreams - 1);
}

const round = (ms: number) => Math.round(ms * 10) / 10;

/** The numbers, as served by GET /internal/load. */
export function loadSnapshot(now = Date.now()): Record<string, unknown> {
  const second = Math.floor(now / 1000);
  rollNotify(second);
  // The last 10 full seconds (not the current, still filling one).
  let last10 = 0;
  for (let s = second - 10; s < second; s++) last10 += notifyBuckets[((s % 60) + 60) % 60]!;
  const memory = process.memoryUsage();
  return {
    uptimeSeconds: Math.round((now - startedAt) / 1000),
    timerLanes: Object.fromEntries([...lanes].map(([name, l]) => [name, { runs: l.runs, lagLastMs: round(l.lastMs), lagMaxMs: round(l.maxMs), lagAvgMs: round(l.runs > 0 ? l.sumMs / l.runs : 0) }])),
    timersParkedByThisCopy: { total: parkedByThisCopy, byKind: Object.fromEntries(parkedKinds) },
    notify: { total: notifyTotal, perSecondLast10s: last10 / 10 },
    streams: { open: openStreams, openedTotal: streamsOpened },
    telemetryNotStored: { rows: telemetryDropped.rows, bytes: telemetryDropped.bytes, byKind: Object.fromEntries(telemetryDropped.byKind) },
    eventLoop: { p99Ms: round(loopDelay.percentile(99) / 1e6), maxMs: round(loopDelay.max / 1e6) },
    memoryMb: { rss: Math.round(memory.rss / 1048576), heapUsed: Math.round(memory.heapUsed / 1048576) },
  };
}

/**
 * T6: `Server-Timing: total;dur=…, app;dur=…, db;dur=…;desc="N"` on every answer (SSE streams are hijacked and send
 * their own head, so they have none). total = request in → answer out; app = the route handler; db = the summed time of
 * the statements the handler ran (its own async context). Registered first, so `total` covers every other hook.
 */
export function registerServerTiming(app: FastifyInstance): void {
  const started = new WeakMap<object, { at: bigint; handlerAt?: bigint; timing: RequestTiming }>();
  app.addHook("onRequest", async (request) => {
    started.set(request, { at: process.hrtime.bigint(), timing: { dbMs: 0, dbCount: 0 } });
  });
  app.addHook("onRoute", (route) => {
    const handler = route.handler;
    route.handler = function timedHandler(this: unknown, request, reply) {
      const entry = started.get(request);
      if (entry === undefined) return handler.call(this as never, request, reply);
      entry.handlerAt = process.hrtime.bigint();
      return requestTiming.run(entry.timing, () => handler.call(this as never, request, reply));
    } as typeof handler;
  });
  app.addHook("onSend", async (request, reply, payload) => {
    const entry = started.get(request);
    if (entry === undefined) return payload;
    const end = process.hrtime.bigint();
    const ms = (from: bigint) => Number(end - from) / 1e6;
    const parts = [`total;dur=${ms(entry.at).toFixed(1)}`];
    if (entry.handlerAt !== undefined) parts.push(`app;dur=${ms(entry.handlerAt).toFixed(1)}`);
    parts.push(`db;dur=${entry.timing.dbMs.toFixed(1)};desc="${entry.timing.dbCount}"`);
    reply.header("Server-Timing", parts.join(", "));
    return payload;
  });
}
