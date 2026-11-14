import { monitorEventLoopDelay } from "node:perf_hooks";
import type { FastifyInstance } from "fastify";
import { ApiError } from "./errors.js";
import { API_PREFIX } from "./prefix.js";

/**
 * Job 1 (stress test H3: spikes of 700+ req/s queued 14 000 requests on the pool, 100 % timeouts, 2.2 GB memory and
 * no recovery while load went on): load shedding. A new request is answered at once 503 unavailable, reason
 * server_busy, Retry-After 2, while the database pool already has more than `maxPoolWaiting` queries waiting or the
 * event loop is more than `maxLoopDelayMs` late — so the queue (and memory) stays bounded and the work already
 * admitted finishes. A request whose client has gone is dropped before it reaches a route. Only low-priority work is shed (sheddable).
 */
export type ShedOptions = { maxPoolWaiting: number; maxLoopDelayMs: number; poolWaiting: () => number };

/**
 * B1.24 (owner W1 Q84, 2026-11-11): the admin's safety screens are read even when the server is busy, never answered
 * 503 server_busy: the incidents list, an incident, its emergency contacts, the ride checks, the alert book and a trip's
 * detail. Matched on the route pattern (like B1.22's SAFETY_WRITE_ROUTES), never on the raw path. Every other admin
 * read is still shed under load.
 */
export const SAFETY_READ_ROUTES: ReadonlySet<string> = new Set(
  [
    "/admin/incidents",
    "/admin/incidents/:incidentId",
    "/admin/incidents/:incidentId/emergency-contacts",
    "/admin/ride-checks",
    "/admin/alerts/book",
    "/admin/trips/:tripId",
  ].map((route) => `GET ${API_PREFIX}${route}`),
);

/**
 * G34 S2 (contract v0.18.83 fastDispatch.shedPolls; owner 2026-11-13 12:21 UTC "Yes, 7 checks"; proof Rules
 * audits/fix-plan-2026-11-13/sup1-server-performance.md P1-A): the 7 repeat timer checks the phones make by themselves
 * and whose failure they already ignore (they keep the last value and ask again at the next check, never sooner than
 * Retry-After). Shed like the admin lists, so under load they answer 503 server_busy at once instead of queueing behind
 * GPS, accept and trip steps. Matched on the route pattern only (never the raw path). GET /rider/trips/active is NEVER
 * here (owner): it is also the rider's restore read on cold start / resume and the booking recover read. Nor are
 * location, accept, trip steps, SOS, GET /driver/profile, GET /trips/:tripId, the streams or any write.
 */
export const POLL_READ_ROUTES: ReadonlySet<string> = new Set(
  [
    "/driver/airport-queue",
    "/driver/surge-map",
    "/notifications",
    "/driver/reminders",
    "/driver/onboarding/settings",
    "/rider/trips",
    "/trips/:tripId/messages",
  ].map((route) => `GET ${API_PREFIX}${route}`),
);

/**
 * Supervisor P4: ONLY new, low-priority work is ever shed — a price quote, the rider's map of cars, address search and
 * the admin panel's lists, and (G34 S2) the phones' 7 repeat checks in POLL_READ_ROUTES. Everything else (SOS / safety, offer accept / decline, trip state changes, payment and cash,
 * trip GPS, every event stream and its resume, sign-in, health checks) is never refused here. B1.24: nor are the admin
 * safety reads (SAFETY_READ_ROUTES). `routePattern` is the matched route (request.routeOptions.url); without one the
 * raw path is compared, so only the routes without an id match then.
 */
export function sheddable(method: string, url: string, routePattern?: string): boolean {
  const path = url.split("?")[0] ?? "";
  const route = path.replace(/^\/api\/v1/, "");
  if (method === "POST" && (route === "/quotes" || route.startsWith("/locations/"))) return true;
  if (method !== "GET") return false;
  if (SAFETY_READ_ROUTES.has(`${method} ${routePattern ?? path}`)) return false;
  if (route.endsWith("/stream") || route.endsWith("/events")) return false;
  if (route === "/rider/nearby-vehicles" || route.startsWith("/places/")) return true;
  if (routePattern !== undefined && POLL_READ_ROUTES.has(`${method} ${routePattern}`)) return true;
  return route.startsWith("/admin/");
}

export function registerLoadShedding(app: FastifyInstance, options: ShedOptions): () => void {
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  // The loop counts as late only when BOTH of the last two 0.5 s samples were late (one GC pause or the first seconds
  // after start never shed anything; job 1 re-test found 503s at 50 req/s from single late samples).
  let lateMs = 0;
  let previous = 0;
  const sample = setInterval(() => {
    const current = loop.percentile(99) / 1e6;
    lateMs = Math.min(current, previous);
    previous = current;
    loop.reset();
  }, 500);
  sample.unref();
  app.addHook("onRequest", async (request, reply) => {
    if (request.raw.destroyed || request.raw.socket?.destroyed) {
      reply.hijack();
      return;
    }
    if (!sheddable(request.method, request.url, request.routeOptions.url)) return;
    const pool = options.maxPoolWaiting > 0 && options.poolWaiting() > options.maxPoolWaiting;
    const late = options.maxLoopDelayMs > 0 && lateMs > options.maxLoopDelayMs;
    if (pool || late) {
      request.log.warn({ shed: pool ? "pool" : "loop", poolWaiting: options.poolWaiting(), loopLateMs: Math.round(lateMs) }, "load shed");
      reply.header("Retry-After", "2");
      return reply.status(503).send(new ApiError("unavailable", "The server is busy. Try again in a moment.", { reason: "server_busy", retryAfterSeconds: 2 }).body(request.id));
    }
  });
  // A route that waits on the database checks again: work for a client that already gave up is not started.
  app.addHook("preHandler", async (request, reply) => {
    if (request.raw.destroyed || request.raw.socket?.destroyed) reply.hijack();
  });
  return () => {
    clearInterval(sample);
    loop.disable();
  };
}
