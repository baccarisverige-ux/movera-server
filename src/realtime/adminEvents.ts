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

type LiveSpec = { path: string; permission: string; retentionHours: number; types: Record<string, { permission: string }> };
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
    const stream = openEventStream(request, reply);
    const first = await resync();
    // resync keeps the client's cursor: its id is the cursor it came with.
    if (first) stream.send(after, first);
    let last = after;
    let running = false;
    let again = false;
    const pump = async () => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        do {
          again = false;
          const rows = await rowsAfter(deps.db, last, 200);
          const serverTime = now();
          for (const row of rows) {
            if (stream.closed()) return;
            if (mayHearLive(who, row)) stream.send(Number(row.sequence), liveEventOf(row, serverTime));
            last = Number(row.sequence);
          }
          // Out-of-scope rows still move the client's cursor, so a reconnect does not read them again.
          if (rows.length) stream.cursor(last);
          if (rows.length === 200) again = true;
        } while (again && !stream.closed());
      } catch (error) {
        request.log.warn({ err: error }, "admin events stream read failed");
      } finally {
        running = false;
      }
    };
    stream.onClose(deps.hub.subscribe(ADMIN_EVENTS_CHANNEL, () => void pump()));
    await pump();
    return reply;
  });
}
