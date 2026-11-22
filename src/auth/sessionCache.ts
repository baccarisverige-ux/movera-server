import { sql } from "kysely";
import type { Executor } from "../db/db.js";
import type { NotificationHub } from "../realtime/hub.js";

/**
 * S4c fix 3 (Rules audits/impact/stress-s4b-2026-11-20.md "S4c": one auth_sessions read per request). Each server copy
 * keeps "this rider / driver session is active" for at most SESSION_CACHE_MS (default 5000, 0 = off), never past the
 * session's own end. Only a positive answer is kept; a revoked, expired or unknown session is always read again.
 *
 * Revoke: every code path that ends a rider / driver session NOTIFYs SESSION_REVOKED_CHANNEL (delivered at its commit)
 * and forgets the session on this copy; every copy LISTENs and forgets it too, so sign-out, "signed in elsewhere",
 * a reused refresh token and an account change are refused at once on every copy. A change that sends no NOTIFY (a
 * hand edit in the database) is refused within SESSION_CACHE_MS at the latest. After a LISTEN reconnect (NOTIFYs may
 * have been missed) the whole cache is dropped. The cache is used only on an app with a LISTEN hub: without one
 * other copies could not tell this one. Admin sessions are never cached (role changes bite at once, step 38).
 */
export const SESSION_REVOKED_CHANNEL = "movera_session_revoked";

export class SessionCache {
  private readonly until = new Map<string, number>();
  constructor(public ms: number) {}

  cachesActor(actor: string): boolean {
    return actor === "rider" || actor === "driver";
  }

  /** True while `sessionId` was read active less than `ms` ago (and before its own end). */
  active(sessionId: string, nowMs: number): boolean {
    if (this.ms <= 0) return false;
    const end = this.until.get(sessionId);
    if (end === undefined) return false;
    if (end > nowMs) return true;
    this.until.delete(sessionId);
    return false;
  }

  /** Keeps a session just read active, until `nowMs + ms` or its own end, whichever is first. */
  put(sessionId: string, nowMs: number, expiresAtMs: number): void {
    if (this.ms <= 0) return;
    if (this.until.size >= 50_000) for (const [k, v] of this.until) if (v <= nowMs) this.until.delete(k);
    this.until.set(sessionId, Math.min(nowMs + this.ms, expiresAtMs));
  }

  forget(sessionId: string): void {
    this.until.delete(sessionId);
  }

  clear(): void {
    this.until.clear();
  }
}

/** The one cache of this server copy (off until configureSessionCache). */
export const sessionCache = new SessionCache(0);

/** At app start: on with `ms` only when a LISTEN hub carries the revokes of other copies; returns the unsubscribe. */
export function configureSessionCache(ms: number, hub: NotificationHub | undefined): () => void {
  sessionCache.clear();
  if (hub === undefined || ms <= 0) {
    sessionCache.ms = 0;
    return () => undefined;
  }
  sessionCache.ms = ms;
  const unsubscribe = hub.subscribe(SESSION_REVOKED_CHANNEL, (payload) => {
    if (payload === null) return sessionCache.clear();
    if (typeof payload["sessionId"] === "string") sessionCache.forget(payload["sessionId"]);
  });
  return () => {
    unsubscribe();
    sessionCache.ms = 0;
    sessionCache.clear();
  };
}

/** Inside the revoking transaction: forget here and tell every copy (NOTIFY is delivered at commit). */
export async function sessionsRevoked(ex: Executor, sessionIds: readonly string[]): Promise<void> {
  for (const sessionId of sessionIds) {
    sessionCache.forget(sessionId);
    await sql`SELECT pg_notify(${SESSION_REVOKED_CHANNEL}, ${JSON.stringify({ sessionId })})`.execute(ex);
  }
}
