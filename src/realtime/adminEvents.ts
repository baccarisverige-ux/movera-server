import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import { authenticateAdmin, type GuardDeps, type Principal } from "../auth/guard.js";
import { contract } from "../contract/contract.js";
import type { Executor } from "../db/db.js";
import { ApiError } from "../http/errors.js";
import { API_PREFIX } from "../http/prefix.js";
import { narrowToZones, parseQuery, ZoneFilterQuery } from "../admin/zoneFilter.js";
import type { NotificationHub } from "./hub.js";
import { openEventStream, wantsEventStream } from "./sse.js";

/**
 * contract v0.18.22 (CONTRACT.md §46, contract.json#adminLiveEvents): the admin live updates stream. Rows are written by
 * database triggers (migrations/0067_admin_live_events.sql), so every service that changes a trip, driver, alert,
 * ticket, incident or approval publishes. An event says only what changed; the panel reads it again with its routes.
 */

export const ADMIN_EVENTS_CHANNEL = "movera_admin_events";

type LiveSpec = { path: string; permission: string; retentionHours: number; types: Record<string, { permission: string }>; limits: { maxStreamsPerAdmin: number; maxStreamsTotal: number } };
export const LIVE = (contract as unknown as { adminLiveEvents: LiveSpec }).adminLiveEvents;

export type AdminLiveRow = { sequence: string; type: string; entity_id: string; zone_id: string | null; occurred_at: Date };

/** Zone scope (zone null only for all-zone admins) and the type's own permission. */
export function mayHearLive(who: Principal, row: Pick<AdminLiveRow, "type" | "zone_id">): boolean {
  const spec = LIVE.types[row.type];
  if (!spec || !(who.perms ?? []).includes(spec.permission)) return false;
  return who.zones.includes("*") || (row.zone_id !== null && who.zones.includes(row.zone_id));
}

export function liveEventOf(row: AdminLiveRow, serverTime: Date) {
  return { sequence: Number(row.sequence), type: row.type, entityId: row.entity_id, zoneId: row.zone_id, occurredAt: row.occurred_at.toISOString(), serverTime: serverTime.toISOString() };
}

async function rowsAfter(ex: Executor, after: number, limit: number): Promise<AdminLiveRow[]> {
  return (await ex.selectFrom("admin_live_events").selectAll().where("sequence", ">", String(after)).orderBy("sequence").limit(limit).execute()) as AdminLiveRow[];
}

/** Were events after the cursor pruned (contract: an older cursor gets one resync)? */
async function cursorTooOld(ex: Executor, after: number): Promise<boolean> {
  const row = await ex.selectFrom("admin_live_pruned").select("up_to").where("id", "=", 1).executeTakeFirst();
  return row !== undefined && after < Number(row.up_to);
}

/** Drops events older than retentionHours (hourly sweep; safe to run any time) and remembers how far it went. */
export async function pruneAdminLiveEvents(ex: Executor, now: Date): Promise<void> {
  const gone = await ex.deleteFrom("admin_live_events").where("occurred_at", "<", new Date(now.getTime() - LIVE.retentionHours * 3_600_000)).returning("sequence").execute();
  if (!gone.length) return;
  const top = Math.max(...gone.map((row) => Number(row.sequence)));
  await ex.updateTable("admin_live_pruned").set({ up_to: sql<string>`greatest(up_to, ${String(top)}::bigint)` }).where("id", "=", 1).execute();
}

type Subscriber = { who: Principal; last: number; catchingUp: boolean; send: (row: AdminLiveRow) => void; cursor: (sequence: number) => void };

/**
 * One reader per server for every open admin stream: a notify makes ONE read of the new rows, fanned out to each
 * stream with its own scope (mayHearLive). A new stream first catches up from its cursor on its own, then joins.
 */
export class AdminLiveFeed {
  private readonly subs = new Set<Subscriber>();
  private readonly perAdmin = new Map<string, number>();
  private head: number | undefined;
  private running = false;
  private again = false;
  private unsubscribe: (() => void) | undefined;
  /** How many shared reads ran (tests: one per change, whatever the number of streams). */
  reads = 0;

  constructor(
    private readonly db: Executor,
    private readonly hub: NotificationHub,
    private readonly log: { warn: (data: object, message: string) => void },
    private readonly limits = LIVE.limits,
  ) {}

  /** 429 too_many_streams over the per-admin or total cap. */
  admit(who: Principal): void {
    if (this.subs.size >= this.limits.maxStreamsTotal || (this.perAdmin.get(who.subjectId) ?? 0) >= this.limits.maxStreamsPerAdmin) {
      throw new ApiError("rate_limited", "Too many live update streams are open. The panel keeps refreshing every minute.", { reason: "too_many_streams", retryAfterSeconds: 30 });
    }
  }

  async join(sub: Subscriber): Promise<() => void> {
    this.subs.add(sub);
    this.perAdmin.set(sub.who.subjectId, (this.perAdmin.get(sub.who.subjectId) ?? 0) + 1);
    let left = false;
    const leave = () => {
      if (left) return;
      left = true;
      this.subs.delete(sub);
      const n = (this.perAdmin.get(sub.who.subjectId) ?? 1) - 1;
      if (n > 0) this.perAdmin.set(sub.who.subjectId, n);
      else this.perAdmin.delete(sub.who.subjectId);
      if (!this.subs.size) this.stop();
    };
    try {
      if (!this.unsubscribe) this.unsubscribe = this.hub.subscribe(ADMIN_EVENTS_CHANNEL, () => void this.pump());
      if (this.head === undefined) {
        const top = await this.db.selectFrom("admin_live_events").select((eb) => eb.fn.max("sequence").as("top")).executeTakeFirst();
        this.head ??= Number(top?.top ?? 0);
      }
      // Catch up alone; the shared reader skips this stream until it has read up to the shared head.
      for (;;) {
        if (left) break;
        const rows = await rowsAfter(this.db, sub.last, 200);
        for (const row of rows) {
          if (left) break;
          if (mayHearLive(sub.who, row)) sub.send(row);
          sub.last = Number(row.sequence);
        }
        if (rows.length) sub.cursor(sub.last);
        // Synchronous check: no fan-out can run between it and the switch.
        if (rows.length < 200 && sub.last >= (this.head ?? 0)) {
          sub.catchingUp = false;
          break;
        }
      }
    } catch (error) {
      leave();
      throw error;
    }
    return leave;
  }

  get open(): number {
    return this.subs.size;
  }

  private async pump(): Promise<void> {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.again = false;
        if (this.head === undefined) return;
        this.reads += 1;
        const rows = await rowsAfter(this.db, this.head, 500);
        if (!rows.length) break;
        for (const sub of this.subs) {
          if (sub.catchingUp) continue;
          for (const row of rows) {
            const seq = Number(row.sequence);
            if (seq <= sub.last) continue;
            if (mayHearLive(sub.who, row)) sub.send(row);
            sub.last = seq;
          }
          sub.cursor(sub.last);
        }
        this.head = Number(rows[rows.length - 1]!.sequence);
        if (rows.length === 500) this.again = true;
      } while (this.again && this.subs.size);
    } catch (error) {
      this.log.warn({ err: error }, "admin events read failed");
    } finally {
      this.running = false;
    }
  }

  private stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    // Re-read the head on the next join (events may be written while nobody listens).
    this.head = undefined;
  }
}

const feeds = new WeakMap<NotificationHub, AdminLiveFeed>();
export function adminLiveFeed(db: Executor, hub: NotificationHub, log: { warn: (data: object, message: string) => void }): AdminLiveFeed {
  let feed = feeds.get(hub);
  if (!feed) feeds.set(hub, (feed = new AdminLiveFeed(db, hub, log)));
  return feed;
}

const Query = {
  ...ZoneFilterQuery,
  after: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
};

export async function adminEventRoutes(app: FastifyInstance, deps: GuardDeps & { hub?: NotificationHub }): Promise<void> {
  const now = deps.clock ?? (() => new Date());
  app.get(`${API_PREFIX}${LIVE.path}`, async (request, reply) => {
    const signedIn = await authenticateAdmin(request, deps, LIVE.permission);
    const query = parseQuery(Query, request.query);
    const who = await narrowToZones(deps.db, signedIn, query);
    const lastEventId = request.headers["last-event-id"];
    const after = query.after ?? (typeof lastEventId === "string" && /^\d+$/.test(lastEventId) ? Number(lastEventId) : 0);
    const resync = async () => ((await cursorTooOld(deps.db, after)) ? { sequence: after, type: "resync", entityId: who.subjectId, zoneId: null, occurredAt: now().toISOString(), serverTime: now().toISOString() } : undefined);

    if (!wantsEventStream(request)) {
      const rows = await rowsAfter(deps.db, after, query.limit + 1);
      const page = rows.slice(0, query.limit);
      const serverTime = now();
      const first = await resync();
      const items = [...(first ? [first] : []), ...page.filter((row) => mayHearLive(who, row)).map((row) => liveEventOf(row, serverTime))];
      const last = page[page.length - 1];
      return { items, nextCursor: rows.length > query.limit && last ? String(last.sequence) : null };
    }
    if (deps.hub === undefined) throw new ApiError("unavailable", "Live updates are not available; poll the admin lists instead.", { reason: "realtime_unavailable", retryAfterSeconds: 10 });
    const feed = adminLiveFeed(deps.db, deps.hub, { warn: (data, message) => request.log.warn(data, message) });
    const first = await resync();
    // No await between the cap check and join (which counts the stream at once): two requests cannot both pass.
    feed.admit(who);
    const stream = openEventStream(request, reply);
    // resync keeps the client's cursor: its id is the cursor it came with.
    if (first) stream.send(after, first);
    const leave = await feed.join({
      who,
      last: after,
      catchingUp: true,
      send: (row) => void stream.send(Number(row.sequence), liveEventOf(row, now())),
      cursor: (sequence) => stream.cursor(sequence),
    });
    if (stream.closed()) leave();
    else stream.onClose(leave);
    return reply;
  });
}
