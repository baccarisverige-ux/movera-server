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
import { LIVE_LOCATION_CHANNEL } from "../trips/liveLocation.js";
import { openEventStream, type EventStream } from "./sse.js";
import { giveUpStream, readRetry, spreadClose } from "./retry.js";

/**
 * Live streams (contract §4). Each stream subscribes before it replays, then reads everything after the last
 * sequence it sent whenever a notification (or a reconnect) says there may be more, so nothing is skipped or sent
 * twice whatever order notifications arrive in. Every event is checked again against who may see the trip: a
 * driver taken off a trip stops receiving it at once, and the stream closes.
 */

type Who = Pick<Principal, "actor" | "subjectId">;

/** B1.18: after a LISTEN reconnect, a busy DB pool may hold a settings stream's close at most this long. */
export const RECONNECT_CLOSE_MAX_HOLD_MS = 120_000;

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
  live = false,
): Promise<void> {
  const viewer = who.actor === "rider" || who.actor === "driver" ? who.actor : "admin";
  const stream = openEventStream(request, reply);
  let last = after;
  let running = false;
  let again = false;
  const retry = readRetry(() => void pump(), () => stream.closed(), () => giveUpStream(stream));
  stream.onClose(retry.stop);

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
      retry.ok();
    } catch (error) {
      request.log.warn({ err: error, tripId }, "trip stream read failed");
      retry.failed();
    } finally {
      running = false;
    }
  };

  const unsubscribe = deps.hub.subscribe(TRIP_EVENTS_CHANNEL, (payload) => {
    if (payload === null || payload["tripId"] === tripId) void pump();
    // S7 0.15: the hub finds this stream by its trip id instead of calling every open trip stream.
  }, { match: [{ tripId }] });
  stream.onClose(unsubscribe);
  // v0.18.144 (contract.json#liveLocation.relay): with ?live=true the rider / driver also gets the other side's live
  // point as `event: live_location` (no id). Its own channel: a point never makes this stream re-read the trip log.
  if (live && viewer !== "admin") {
    stream.onClose(deps.hub.subscribe(LIVE_LOCATION_CHANNEL, (payload) => {
      if (payload === null || payload["tripId"] !== tripId || payload["side"] === viewer) return;
      stream.event("live_location", payload);
    }, { match: [{ tripId }] }));
  }
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
  await attachConfig(request, stream, deps, doc, zoneId, lastSeenVersion, (version, data) => void stream.send(version, data), riderId, driverId);
}

/**
 * The settings stream's subscriptions on any open stream. v0.18.122 (L20 stream, contract.json#driverOneStream):
 * GET /driver/stream attaches these next to the offer pump; `send` gets the config version and the caller writes the
 * SSE id. Each half keeps its own hub options (the config catch-up stays "spread", so an offer never waits behind it).
 */
export async function attachConfig(
  request: FastifyRequest,
  stream: EventStream,
  deps: { db: Db; hub: NotificationHub; clock?: () => Date },
  doc: ConfigDoc,
  zoneId: string,
  lastSeenVersion: number,
  send: (version: number, data: unknown) => void,
  riderId?: string,
  driverId?: string,
): Promise<void> {
  let sent = lastSeenVersion;
  const check = async () => {
    // v0.8.0 §6.4: the zone's own document, else its country standard (liveDocument).
    const live = await liveDocument<{ publishedAt?: string }>(deps.db, doc, zoneId);
    if (live === null || live.version <= sent || stream.closed()) return;
    sent = live.version;
    const now = deps.clock?.() ?? new Date();
    const publishedAt = live.document.publishedAt ?? now.toISOString();
    send(live.version, {
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
  const retry = readRetry(() => void safeCheck(), () => stream.closed(), () => giveUpStream(stream));
  stream.onClose(retry.stop);
  const safeCheck = () =>
    check().then(retry.ok, (error: unknown) => {
      request.log.warn({ err: error }, "config stream read failed");
      retry.failed();
    });
  const unsubscribe = deps.hub.subscribe(CONFIG_CHANNEL, (payload) => {
    if (payload === null || (payload["doc"] === doc && payload["zoneId"] === zoneId)) void safeCheck();
    // v0.10.0 content of this zone and v0.11.0 zones (any zone: the apps keep every open zone) ride along on the
    // app document's stream. Their id is the app document version already sent, so Last-Event-ID stays that.
    // v0.18.6 (G4-F6, contract.json#dispatchTools.events): the events of the driver's country ride along on the driver stream.
    else if (payload["doc"] === "zones" || (payload["doc"] === "content" && payload["zoneId"] === zoneId) || (payload["doc"] === "events" && doc === "driver_app_config" && payload["zoneId"] === zoneId)) {
      if (stream.closed()) return;
      const now = deps.clock?.() ?? new Date();
      const publishedAt = typeof payload["publishedAt"] === "string" ? payload["publishedAt"] : now.toISOString();
      send(sent, { eventId: newId("evt", now.getTime()), kind: "config_published", doc: payload["doc"], zoneId: payload["zoneId"], version: payload["version"], publishedAt, occurredAt: publishedAt, serverTime: now.toISOString() });
    }
    // MF-1: the settings stream's catch-up goes after the offer feeds, trip streams and SOS stream (hub batches it).
    // S7 0.15: every branch above needs this zone's id, except doc "zones" (any zone).
  }, { catchUp: "spread", match: [{ zoneId }, { doc: "zones" }] });
  stream.onClose(unsubscribe);
  // S04 A5: the null signal (LISTEN reconnected) means hints may have been missed. A hint needs a tripId and the
  // contract has no catch-up event, so the stream is closed: the app reconnects (same Last-Event-ID) and re-reads.
  // B1.18 (owner W1 Q80): every stream of this copy gets the signal together, so the close waits a random
  // 0 – STREAM_CLOSE_SPREAD_MS (as B1.9) and, while the DB pool is over its shed limit, longer, but at most
  // RECONNECT_CLOSE_MAX_HOLD_MS. One pending close per stream, however many reconnects come in the meantime.
  let pendingClose: (() => void) | undefined;
  const missedHints = () => {
    if (pendingClose !== undefined || stream.closed()) return;
    pendingClose = spreadClose(() => giveUpStream(stream, "realtime reconnected; reconnect to catch up"), () => stream.closed(), { maxHoldMs: RECONNECT_CLOSE_MAX_HOLD_MS });
  };
  stream.onClose(() => pendingClose?.());
  // v0.18.32 (contract.json#bookedRideSeen.riderTripEvent, P21): a trip of this rider changed, wherever it was made.
  // The trip event's NOTIFY names its rider, so no read is needed; the id stays the document version already sent.
  if (riderId !== undefined) {
    stream.onClose(deps.hub.subscribe(TRIP_EVENTS_CHANNEL, (payload) => {
      if (payload === null) return missedHints();
      if (payload["riderId"] !== riderId || typeof payload["tripId"] !== "string" || stream.closed()) return;
      // v0.18.127 S7 W2 Q119 (owner 2026-11-15 "All except GPS (Rec.)", contract.json#bookedRideSeen.riderTripEvent): a
      // GPS update (position fix or ETA tick, kind location) never changes the active trip or the Upcoming list, so it
      // sends no hint. A notice without a kind (an older copy during a deploy) still sends one, as before.
      if (payload["kind"] === "location") return;
      const now = deps.clock?.() ?? new Date();
      send(sent, { eventId: newId("evt", now.getTime()), kind: "rider_trip_changed", tripId: payload["tripId"], occurredAt: now.toISOString(), serverTime: now.toISOString() });
      // S7 0.15: the hub finds this stream by its rider id.
    }, { catchUp: "spread", match: [{ riderId }] }));
  }
  // v0.18.45 §68 (contract.json#driverReservationsLive): a booked ride of this zone (or one naming this driver)
  // changed. A hint only: the app re-reads GET /driver/reservations. Sent from the post-commit NOTIFY, so a
  // rolled-back change sends nothing; every server copy LISTENs and fans out to its own streams (rule 33).
  if (driverId !== undefined) {
    stream.onClose(deps.hub.subscribe(TRIP_EVENTS_CHANNEL, (payload) => {
      // v0.18.51 §73 (S4 ISSUE 1): only a list change of a booked ride, never its location fixes or other updates.
      if (payload === null) return missedHints();
      if (payload["scheduled"] !== true || payload["reservations"] !== true || typeof payload["tripId"] !== "string" || stream.closed()) return;
      if (payload["zoneId"] !== zoneId && payload["driverId"] !== driverId) return;
      const now = deps.clock?.() ?? new Date();
      send(sent, { eventId: newId("evt", now.getTime()), kind: "driver_reservations_changed", tripId: payload["tripId"], occurredAt: now.toISOString(), serverTime: now.toISOString() });
      // S7 0.15: only a booked ride's list change (reservations: true, which tripNotice sets on a scheduled trip
      // only) of this zone or naming this driver. NOT the zone alone: every trip event carries its zone, so that would
      // run every driver stream of the zone for every GPS fix of every trip in it.
    }, { catchUp: "spread", match: [{ reservations: true, zoneId }, { reservations: true, driverId }] }));
  }
  // A reconnect with Last-Event-ID older than the live version gets the newest at once.
  await safeCheck();
}
