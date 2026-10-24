import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/** Server-sent events (contract §4): `id:` is the sequence, `data:` one JSON event, a comment every 15 s. */

export const HEARTBEAT_MS = 15_000;

export function wantsEventStream(request: FastifyRequest): boolean {
  const accept = request.headers.accept;
  return typeof accept === "string" && accept.includes("text/event-stream");
}

export type EventStream = {
  send: (id: string | number, data: unknown) => boolean;
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
    // Proxies must not hold the stream back.
    "x-accel-buffering": "no",
  });
  raw.write(": stream open\n\n");
  let done = false;
  const closers: Array<() => void> = [];
  const finish = () => {
    if (done) return;
    done = true;
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
  return {
    send: (id, data) => {
      if (done) return false;
      return raw.write(`id: ${id}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    comment: (text) => {
      if (!done) raw.write(`: ${text.replace(/\n/g, " ")}\n\n`);
    },
    close: finish,
    closed: () => done,
    onClose: (fn) => closers.push(fn),
  };
}
