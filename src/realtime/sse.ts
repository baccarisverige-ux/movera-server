import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { recordAppStreamOverPerSession, streamClosed, streamOpened } from "../telemetry/load.js";
import { SESSION_ENDED_COMMENT, streamOwnerOf, watchOf } from "./sessionWatch.js";

/** Server-sent events (contract §4): `id:` is the sequence, `data:` one JSON event, a comment every 15 s. */

export const HEARTBEAT_MS = 15_000;

export function wantsEventStream(request: FastifyRequest): boolean {
  const accept = request.headers.accept;
  return typeof accept === "string" && accept.includes("text/event-stream");
}

export type EventStream = {
  send: (id: string | number, data: unknown) => boolean;
  /** An `id:` with no data: the client's cursor (Last-Event-ID) moves there, no event is dispatched (SSE). */
  cursor: (id: string | number) => void;
  comment: (text: string) => void;
  /** v0.18.144 (contract.json#liveLocation.relay): a named frame with no id (the client's cursor does not move). */
  event: (name: string, data: unknown) => boolean;
  close: () => void;
  closed: () => boolean;
  onClose: (fn: () => void) => void;
};

/**
 * S7 W2 Q125 (Q-B3, B3.11; owner 2026-11-15 "A) count and log above N = 3, refuse later"; contract.json#realtime.appStreamsPerSession):
 * a rider or driver session with more than this many open streams on one server copy is logged (warn, once per stream
 * opened above it) and counted (GET /internal/load `streams.appOverPerSession`). Nothing is refused in this step; a later
 * step (B3.11b) may answer 429 too_many_streams and then needs a count shared by all copies (Rule 33). Fixed in code:
 * the owner chose a fixed number, no admin setting. Admin streams keep their own caps (adminEvents.ts).
 */
export const APP_STREAMS_PER_SESSION_LOG = 3;
/** Open app streams per session id, per server (one Map per Fastify instance, as openByServer). */
const appBySession = new WeakMap<FastifyInstance, Map<string, number>>();

/** Open streams per server, so a shutting-down server can end them (they would hold it open forever). */
const openByServer = new WeakMap<FastifyInstance, Set<() => void>>();
export function closeAllStreams(server: FastifyInstance): void {
  for (const close of [...(openByServer.get(server) ?? [])]) close();
}

export function openEventStream(request: FastifyRequest, reply: FastifyReply, heartbeatMs = HEARTBEAT_MS): EventStream {
  let open = openByServer.get(request.server);
  if (!open) openByServer.set(request.server, (open = new Set()));
  reply.hijack();
  const raw = reply.raw;
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(reply.getHeaders())) if (value !== undefined) headers[name] = String(value);
  raw.writeHead(200, {
    ...headers,
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-content-type-options": "nosniff",
    // Proxies must not hold the stream back.
    "x-accel-buffering": "no",
  });
  raw.write(": stream open\n\n");
  streamOpened();
  let done = false;
  const closers: Array<() => void> = [];
  const finish = () => {
    if (done) return;
    done = true;
    streamClosed();
    open.delete(finish);
    clearInterval(beat);
    for (const fn of closers) fn();
    raw.end();
  };
  const beat = setInterval(() => {
    if (!done) raw.write(": heartbeat\n\n");
  }, heartbeatMs);
  request.raw.on("close", finish);
  open.add(finish);
  // B1.15 (Q76): the stream ends within STREAM_SESSION_CHECK_MS when its session ends (sessionWatch.ts).
  const owner = streamOwnerOf(request);
  if (owner !== undefined && owner.actor !== "admin") {
    let counts = appBySession.get(request.server);
    if (!counts) appBySession.set(request.server, (counts = new Map()));
    const sessionId = owner.sessionId;
    const n = (counts.get(sessionId) ?? 0) + 1;
    counts.set(sessionId, n);
    if (n > APP_STREAMS_PER_SESSION_LOG) {
      recordAppStreamOverPerSession();
      request.log.warn({ actor: owner.actor, sessionId, open: n, limit: APP_STREAMS_PER_SESSION_LOG, path: request.routeOptions.url }, "app streams per session over the limit");
    }
    closers.push(() => {
      const left = (counts.get(sessionId) ?? 1) - 1;
      if (left > 0) counts.set(sessionId, left);
      else counts.delete(sessionId);
    });
  }
  const watch = watchOf(request.server);
  if (owner !== undefined && watch !== undefined) {
    closers.push(
      watch.add(owner, () => {
        if (!done) raw.write(`: ${SESSION_ENDED_COMMENT}\n\n`);
        finish();
      }),
    );
  }
  return {
    send: (id, data) => {
      if (done) return false;
      return raw.write(`id: ${id}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    cursor: (id) => {
      if (!done) raw.write(`id: ${id}\n\n`);
    },
    event: (name, data) => {
      if (done) return false;
      return raw.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    comment: (text) => {
      if (!done) raw.write(`: ${text.replace(/\n/g, " ")}\n\n`);
    },
    close: finish,
    closed: () => done,
    onClose: (fn) => closers.push(fn),
  };
}
