import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../db/db.js";
import type { ConfigDoc } from "../db/schema.js";
import { TRIP_EVENTS_CHANNEL, tripEventsAfter } from "../db/tripLog.js";
import { CONFIG_CHANNEL, liveDocument } from "../config/service.js";
import type { Principal } from "../auth/guard.js";
import { newId } from "../ids.js";
import { eventEnvelope } from "./events.js";
import type { NotificationHub } from "./hub.js";
import { openEventStream } from "./sse.js";

/**
 * Live streams (contract §4). Each stream subscribes before it replays, then reads everything after the last
 * sequence it sent whenever a notification (or a reconnect) says there may be more, so nothing is skipped or sent
 * twice whatever order notifications arrive in. Every event is checked again against who may see the trip: a
 * driver taken off a trip stops receiving it at once, and the stream closes.
 */

type Who = Pick<Principal, "actor" | "subjectId">;

async function maySee(db: Db, tripId: string, who: Who): Promise<boolean> {
  if (who.actor === "admin") return true;
  const trip = await db.selectFrom("trips").select(["rider_id", "driver_id"]).where("trip_id", "=", tripId).executeTakeFirst();
  if (trip === undefined) return false;
  return (who.actor === "rider" && trip.rider_id === who.subjectId) || (who.actor === "driver" && trip.driver_id === who.subjectId);
}

export async function streamTrip(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: { db: Db; hub: NotificationHub; clock?: () => Date },
  tripId: string,
  who: Who,
  after: number,
): Promise<void> {
  const viewer = who.actor === "rider" || who.actor === "driver" ? who.actor : "admin";
  const stream = openEventStream(request, reply);
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
        if (!(await maySee(deps.db, tripId, who))) {
          stream.comment("access ended");
          stream.close();
          return;
        }
        const rows = await tripEventsAfter(deps.db, tripId, last, 200);
        const now = deps.clock?.() ?? new Date();
        for (const row of rows) {
          if (stream.closed()) return;
          stream.send(Number(row.sequence), eventEnvelope(row, viewer, now));
          last = Number(row.sequence);
        }
        if (rows.length === 200) again = true;
      } while (again && !stream.closed());
    } catch (error) {
      request.log.warn({ err: error, tripId }, "trip stream read failed");
    } finally {
      running = false;
    }
  };

  const unsubscribe = deps.hub.subscribe(TRIP_EVENTS_CHANNEL, (payload) => {
    if (payload === null || payload["tripId"] === tripId) void pump();
  });
  stream.onClose(unsubscribe);
  await pump();
}

export async function streamConfig(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: { db: Db; hub: NotificationHub; clock?: () => Date },
  doc: ConfigDoc,
  zoneId: string,
  lastSeenVersion: number,
): Promise<void> {
  const stream = openEventStream(request, reply);
  let sent = lastSeenVersion;
  const check = async () => {
    // v0.8.0 §6.4: the zone's own document, else its country standard (liveDocument).
    const live = await liveDocument<{ publishedAt?: string }>(deps.db, doc, zoneId);
    if (live === null || live.version <= sent || stream.closed()) return;
    sent = live.version;
    const now = deps.clock?.() ?? new Date();
    const publishedAt = live.document.publishedAt ?? now.toISOString();
    stream.send(live.version, {
      eventId: newId("evt", now.getTime()),
      kind: "config_published",
      doc,
      zoneId,
      version: live.version,
      publishedAt,
      occurredAt: publishedAt,
      serverTime: now.toISOString(),
    });
  };
  const unsubscribe = deps.hub.subscribe(CONFIG_CHANNEL, (payload) => {
    if (payload === null || (payload["doc"] === doc && payload["zoneId"] === zoneId)) void check().catch((error) => request.log.warn({ err: error }, "config stream read failed"));
    // v0.10.0 content of this zone and v0.11.0 zones (any zone: the apps keep every open zone) ride along on the
    // app document's stream. Their id is the app document version already sent, so Last-Event-ID stays that.
    else if (payload["doc"] === "zones" || (payload["doc"] === "content" && payload["zoneId"] === zoneId)) {
      if (stream.closed()) return;
      const now = deps.clock?.() ?? new Date();
      const publishedAt = typeof payload["publishedAt"] === "string" ? payload["publishedAt"] : now.toISOString();
      stream.send(sent, { eventId: newId("evt", now.getTime()), kind: "config_published", doc: payload["doc"], zoneId: payload["zoneId"], version: payload["version"], publishedAt, occurredAt: publishedAt, serverTime: now.toISOString() });
    }
  });
  stream.onClose(unsubscribe);
  // A reconnect with Last-Event-ID older than the live version gets the newest at once.
  await check();
}
