import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../db/db.js";
import type { ConfigDoc } from "../db/schema.js";
import { TRIP_EVENTS_CHANNEL, tripEventsAfter } from "../db/tripLog.js";
import { CONFIG_CHANNEL, liveDocument } from "../config/service.js";
import type { Principal } from "../auth/guard.js";
import { newId } from "../ids.js";
import { eventEnvelope } from "./events.js";
import { TERMINAL, type TripStatus } from "../rules/transitions.js";
import type { NotificationHub } from "./hub.js";
import { openEventStream } from "./sse.js";

/**
 * Live streams (contract §4). Each stream subscribes before it replays, then reads everything after the last
 * sequence it sent whenever a notification (or a reconnect) says there may be more, so nothing is skipped or sent
 * twice whatever order notifications arrive in. Every event is checked again against who may see the trip: a
 * driver taken off a trip stops receiving it at once, and the stream closes.
 */

type Who = Pick<Principal, "actor" | "subjectId">;

/** Whether `who` may see the trip, and (v0.18.5 G9) whether its chat text is hidden from him: rider / driver after the trip. */
async function maySee(db: Db, tripId: string, who: Who): Promise<{ ok: boolean; hideMessage: boolean }> {
  if (who.actor === "admin") return { ok: true, hideMessage: false };
  const trip = await db.selectFrom("trips").select(["rider_id", "driver_id", "status"]).where("trip_id", "=", tripId).executeTakeFirst();
  if (trip === undefined) return { ok: false, hideMessage: true };
  const ok = (who.actor === "rider" && trip.rider_id === who.subjectId) || (who.actor === "driver" && trip.driver_id === who.subjectId);
  return { ok, hideMessage: TERMINAL.has(trip.status as TripStatus) };
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
        const access = await maySee(deps.db, tripId, who);
        if (!access.ok) {
          stream.comment("access ended");
          stream.close();
          return;
        }
        const rows = await tripEventsAfter(deps.db, tripId, last, 200);
        const now = deps.clock?.() ?? new Date();
        for (const row of rows) {
          if (stream.closed()) return;
          stream.send(Number(row.sequence), eventEnvelope(row, viewer, now, { hideMessage: access.hideMessage }));
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
  if (viewer !== "admin") markPresence(request, deps, stream, tripId, who);
  await pump();
}

/** A stream not refreshed for this long belongs to a copy that died (inAppCalls.push: "no open trip stream"). */
export const PRESENCE_STALE_MS = 90_000;
const PRESENCE_EVERY_MS = 30_000;

/**
 * v0.18.56 §78 (inAppCalls.push, Q79): the rider's / driver's open trip stream is written to trip_stream_presence
 * (Rule 33: any copy can see it), refreshed every 30 s and removed on close, so a call push goes only to a callee
 * whose app has no open stream for the trip.
 */
function markPresence(request: FastifyRequest, deps: { db: Db; clock?: () => Date }, stream: ReturnType<typeof openEventStream>, tripId: string, who: Who): void {
  const streamId = newId("sse", Date.now());
  const at = () => deps.clock?.() ?? new Date();
  const warn = (error: unknown) => request.log.warn({ err: error, tripId }, "trip stream presence write failed");
  void deps.db.insertInto("trip_stream_presence").values({ stream_id: streamId, trip_id: tripId, actor: who.actor, subject_id: who.subjectId, seen_at: at() }).execute().catch(warn);
  const beat = setInterval(() => {
    void deps.db.updateTable("trip_stream_presence").set({ seen_at: at() }).where("stream_id", "=", streamId).execute().catch(warn);
  }, PRESENCE_EVERY_MS);
  beat.unref();
  stream.onClose(() => {
    clearInterval(beat);
    void deps.db.deleteFrom("trip_stream_presence").where("stream_id", "=", streamId).execute().catch(warn);
  });
}

export async function streamConfig(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: { db: Db; hub: NotificationHub; clock?: () => Date },
  doc: ConfigDoc,
  zoneId: string,
  lastSeenVersion: number,
  riderId?: string,
  driverId?: string,
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
    // v0.18.6 (G4-F6, contract.json#dispatchTools.events): the events of the driver's country ride along on the driver stream.
    else if (payload["doc"] === "zones" || (payload["doc"] === "content" && payload["zoneId"] === zoneId) || (payload["doc"] === "events" && doc === "driver_app_config" && payload["zoneId"] === zoneId)) {
      if (stream.closed()) return;
      const now = deps.clock?.() ?? new Date();
      const publishedAt = typeof payload["publishedAt"] === "string" ? payload["publishedAt"] : now.toISOString();
      stream.send(sent, { eventId: newId("evt", now.getTime()), kind: "config_published", doc: payload["doc"], zoneId: payload["zoneId"], version: payload["version"], publishedAt, occurredAt: publishedAt, serverTime: now.toISOString() });
    }
  });
  stream.onClose(unsubscribe);
  // v0.18.32 (contract.json#bookedRideSeen.riderTripEvent, P21): a trip of this rider changed, wherever it was made.
  // The trip event's NOTIFY names its rider, so no read is needed; the id stays the document version already sent.
  if (riderId !== undefined) {
    stream.onClose(deps.hub.subscribe(TRIP_EVENTS_CHANNEL, (payload) => {
      if (payload === null || payload["riderId"] !== riderId || typeof payload["tripId"] !== "string" || stream.closed()) return;
      const now = deps.clock?.() ?? new Date();
      stream.send(sent, { eventId: newId("evt", now.getTime()), kind: "rider_trip_changed", tripId: payload["tripId"], occurredAt: now.toISOString(), serverTime: now.toISOString() });
    }));
  }
  // v0.18.45 §68 (contract.json#driverReservationsLive): a booked ride of this zone (or one naming this driver)
  // changed. A hint only: the app re-reads GET /driver/reservations. Sent from the post-commit NOTIFY, so a
  // rolled-back change sends nothing; every server copy LISTENs and fans out to its own streams (rule 33).
  if (driverId !== undefined) {
    stream.onClose(deps.hub.subscribe(TRIP_EVENTS_CHANNEL, (payload) => {
      // v0.18.51 §73 (S4 ISSUE 1): only a list change of a booked ride, never its location fixes or other updates.
      if (payload === null || payload["scheduled"] !== true || payload["reservations"] !== true || typeof payload["tripId"] !== "string" || stream.closed()) return;
      if (payload["zoneId"] !== zoneId && payload["driverId"] !== driverId) return;
      const now = deps.clock?.() ?? new Date();
      stream.send(sent, { eventId: newId("evt", now.getTime()), kind: "driver_reservations_changed", tripId: payload["tripId"], occurredAt: now.toISOString(), serverTime: now.toISOString() });
    }));
  }
  // A reconnect with Last-Event-ID older than the live version gets the newest at once.
  await check();
}
