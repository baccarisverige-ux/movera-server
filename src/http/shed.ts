import { monitorEventLoopDelay } from "node:perf_hooks";
import type { FastifyInstance } from "fastify";
import { ApiError } from "./errors.js";

/**
 * Job 1 (stress test H3: spikes of 700+ req/s queued 14 000 requests on the pool, 100 % timeouts, 2.2 GB memory and
 * no recovery while load went on): load shedding. A new request is answered at once 503 unavailable, reason
 * server_busy, Retry-After 2, while the database pool already has more than `maxPoolWaiting` queries waiting or the
 * event loop is more than `maxLoopDelayMs` late — so the queue (and memory) stays bounded and the work already
 * admitted finishes. A request whose client has gone is dropped before it reaches a route. Health checks are never shed.
 */
export type ShedOptions = { maxPoolWaiting: number; maxLoopDelayMs: number; poolWaiting: () => number };

const NEVER_SHED = new Set(["/healthz", "/readyz"]);

export function registerLoadShedding(app: FastifyInstance, options: ShedOptions): () => void {
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  let lateMs = 0;
  const sample = setInterval(() => {
    lateMs = loop.percentile(99) / 1e6;
    loop.reset();
  }, 500);
  sample.unref();
  app.addHook("onRequest", async (request, reply) => {
    if (NEVER_SHED.has(request.url.split("?")[0] ?? "")) return;
    if (request.raw.destroyed || request.raw.socket?.destroyed) {
      reply.hijack();
      return;
    }
    const pool = options.maxPoolWaiting > 0 && options.poolWaiting() > options.maxPoolWaiting;
    const late = options.maxLoopDelayMs > 0 && lateMs > options.maxLoopDelayMs;
    if (pool || late) {
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
