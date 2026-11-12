import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { streamClosed, streamOpened } from "../telemetry/load.js";
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
  close: () => void;
  closed: () => boolean;
  onClose: (fn: () => void) => void;
};

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
    comment: (text) => {
      if (!done) raw.write(`: ${text.replace(/\n/g, " ")}\n\n`);
    },
    close: finish,
    closed: () => done,
    onClose: (fn) => closers.push(fn),
  };
}
