import type { FastifyInstance, FastifyRequest } from "fastify";
import { sql } from "kysely";
import type { Db } from "../db/db.js";

/**
 * B1.15 (owner W1 Q76, S04 C1 / P7; contract.json#realtime.sessionEnd, contract 0.18.73): an open stream ends within 60 s when its
 * SESSION ends — sign-out, a sign-in on a new phone, an account change, an admin's role change or deactivation, any
 * revoke however the row was changed. Only the session row is re-checked, never the access token's 15 minutes, so a
 * stream stays open across refreshes. Rule 33 cost: each server copy runs ONE batched query for all its open streams
 * every STREAM_SESSION_CHECK_MS (default 30 s, at most 60 s), by primary key (one more per 500 sessions); no query per
 * stream, none while no stream is open. A preview token has no session row: its stream ends at the token's own end (a timer, no query).
 */

/** Who opened a stream (recorded by the guard on every authenticated request; only streams read it). */
export type StreamOwner = { sessionId: string; actor: "rider" | "driver" | "admin"; role?: string; previewEndsAt?: number };

/** The SSE comment sent just before the close; the app's reconnect then gets 401 with the reason (session_ended, signed_in_elsewhere). */
export const SESSION_ENDED_COMMENT = "session ended; sign in again";
export const SESSION_CHECK_DEFAULT_MS = 30_000;
export const SESSION_CHECK_MAX_MS = 60_000;
/**
 * Session ids per query. EXPLAIN (200 000 session rows): 500 ids = bitmap scan on auth_sessions_pkey, 1.9 ms; 2000 ids
 * made the planner pick a sequential scan of the whole table (19 ms, growing with the table), so bigger sets are split.
 */
export const SESSION_CHECK_BATCH = 500;

const owners = new WeakMap<FastifyRequest, StreamOwner>();
export function noteStreamOwner(request: FastifyRequest, owner: StreamOwner): void {
  owners.set(request, owner);
}
export function streamOwnerOf(request: FastifyRequest): StreamOwner | undefined {
  return owners.get(request);
}

type Watched = { owner: StreamOwner; end: () => void };
type Options = { everyMs: number; clock?: () => Date; warn: (data: Record<string, unknown>, message: string) => void };

export class SessionWatch {
  private readonly streams = new Set<Watched>();
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  /** Session queries run (for the Rule 33 cost test). */
  checks = 0;

  constructor(
    private readonly db: Db,
    private readonly options: Options,
  ) {}

  private now(): Date {
    return this.options.clock?.() ?? new Date();
  }

  /** Watches one open stream; `end` sends the comment and closes it. Returns the stop function (call it on close). */
  add(owner: StreamOwner, end: () => void): () => void {
    if (owner.previewEndsAt !== undefined) {
      const at = setTimeout(end, Math.max(0, owner.previewEndsAt - this.now().getTime()));
      at.unref();
      return () => clearTimeout(at);
    }
    const watched = { owner, end };
    this.streams.add(watched);
    if (this.timer === undefined) {
      this.timer = setInterval(() => void this.check(), this.options.everyMs);
      this.timer.unref();
    }
    return () => {
      this.streams.delete(watched);
      if (this.streams.size === 0) this.stop();
    };
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One query for every open stream of this copy: the sessions still alive (and, for admins, their current role). */
  async check(): Promise<void> {
    if (this.running || this.streams.size === 0) return;
    this.running = true;
    try {
      const ids = [...new Set([...this.streams].map((w) => w.owner.sessionId))];
      const now = this.now();
      const alive = new Map<string, { role: string | null; active: boolean | null }>();
      for (let at = 0; at < ids.length; at += SESSION_CHECK_BATCH) {
        this.checks += 1;
        const { rows } = await sql<{ session_id: string; role: string | null; active: boolean | null }>`
          SELECT s.session_id, a.role, a.active
            FROM auth_sessions s LEFT JOIN admins a ON s.actor = 'admin' AND a.admin_id = s.subject_id
           WHERE s.session_id = ANY(${ids.slice(at, at + SESSION_CHECK_BATCH)}::text[]) AND s.revoked_at IS NULL AND s.expires_at > ${now}`.execute(this.db);
        for (const row of rows) alive.set(row.session_id, row);
      }
      for (const watched of [...this.streams]) {
        const row = alive.get(watched.owner.sessionId);
        // Step 38 (Q42): an admin's rights live in his token, so a role change or a deactivation ends his streams too.
        const ok = row !== undefined && (watched.owner.actor !== "admin" || (row.active === true && row.role === watched.owner.role));
        if (!ok) watched.end();
      }
    } catch (error) {
      // A failed check closes nothing; the next interval tries again.
      this.options.warn({ err: error }, "stream session check failed");
    } finally {
      this.running = false;
    }
  }
}

const watches = new WeakMap<FastifyInstance, SessionWatch>();

/** Installs the session watch of this server copy (app.ts); its open streams register in openEventStream. */
export function watchStreamSessions(server: FastifyInstance, db: Db, options: Options): SessionWatch {
  const watch = new SessionWatch(db, options);
  watches.set(server, watch);
  server.addHook("onClose", async () => watch.stop());
  return watch;
}
export function watchOf(server: FastifyInstance): SessionWatch | undefined {
  return watches.get(server);
}
