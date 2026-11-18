import type { FastifyRequest } from "fastify";
import type { Db } from "../db/db.js";
import { OFFER_EVENTS_CHANNEL } from "../db/tripLog.js";
import type { NotificationHub } from "../realtime/hub.js";
import { giveUpStream, readRetry } from "../realtime/retry.js";
import type { EventStream } from "../realtime/sse.js";

/**
 * The driver's offer feed (contract §4, GET /driver/offers/stream), as a pump that can sit on any open stream:
 * v0.18.122 (L20 stream, contract.json#driverOneStream) GET /driver/stream attaches this same pump next to the config
 * stream's subscriptions. `send` gets the offer sequence; the caller writes the SSE id (a plain sequence on the old feed,
 * '<sequence>.<config version>' on the one stream).
 */
export type OfferFeedDeps = { db: Db; hub: NotificationHub; clock?: () => Date };

const readOffers = (db: Db, driverId: string, from: number) =>
  db.selectFrom("offer_events").selectAll().where("driver_id", "=", driverId).where("sequence", ">", String(from)).orderBy("sequence").limit(200).execute();
type OfferRow = Awaited<ReturnType<typeof readOffers>>[number];

export function offerEnvelope(row: OfferRow, now: Date): Record<string, unknown> {
  // v0.8.0 (contract.json#autoOffline): the run's last miss carries driverOffline beside the offer.
  const { driverOffline, ...offer } = row.offer as Record<string, unknown>;
  return { eventId: row.event_id, sequence: Number(row.sequence), kind: row.kind, occurredAt: row.occurred_at.toISOString(), serverTime: now.toISOString(), offer, ...(driverOffline === true ? { driverOffline: true } : {}) };
}

/** The JSON page of the feed (Accept: application/json). */
export async function offerPage(db: Db, driverId: string, after: number, now: Date) {
  const rows = await readOffers(db, driverId, after);
  return { items: rows.map((row) => offerEnvelope(row, now)), nextCursor: rows.length === 200 ? String(rows[rows.length - 1]!.sequence) : null };
}

/**
 * Driver 03c (live test 2026-10-30): a feed opened without a cursor (an app that just started) does not replay the
 * driver's whole history (an old driverOffline set the driver offline again right after Go online). It starts at the
 * newest event from before this Go online (occurred_at < online_since), so everything since Go online is still sent.
 * Offline (no online_since): the newest event.
 */
export async function offerHead(db: Db, driverId: string): Promise<number> {
  const driver = await db.selectFrom("drivers").select("online_since").where("driver_id", "=", driverId).executeTakeFirst();
  let query = db.selectFrom("offer_events").select((eb) => eb.fn.max("sequence").as("head")).where("driver_id", "=", driverId);
  if (driver?.online_since) query = query.where("occurred_at", "<", driver.online_since);
  return Number((await query.executeTakeFirst())?.head ?? 0);
}

/** Attaches the offer pump to `stream` from sequence `after`; resolves after the first read (the replay). */
export async function attachOfferFeed(request: FastifyRequest, deps: OfferFeedDeps, stream: EventStream, driverId: string, after: number, send: (sequence: number, data: unknown) => void): Promise<void> {
  let last = after;
  let running = false;
  let again = false;
  const retry = readRetry(() => void pump(), () => stream.closed(), () => giveUpStream(stream));
  stream.onClose(retry.stop);
  const pump = async () => {
    if (running) return void (again = true);
    running = true;
    try {
      do {
        again = false;
        const rows = await readOffers(deps.db, driverId, last);
        const now = deps.clock?.() ?? new Date();
        for (const row of rows) {
          if (stream.closed()) return;
          send(Number(row.sequence), offerEnvelope(row, now));
          last = Number(row.sequence);
        }
        if (rows.length === 200) again = true;
      } while (again && !stream.closed());
      retry.ok();
    } catch (error) {
      request.log.warn({ err: error }, "offer stream read failed");
      retry.failed();
    } finally {
      running = false;
    }
  };
  const unsubscribe = deps.hub.subscribe(OFFER_EVENTS_CHANNEL, (payload) => {
    if (payload === null || payload["driverId"] === driverId) void pump();
    // S7 0.15: the hub finds this feed by its driver id instead of calling every open offer feed.
  }, { match: [{ driverId }] });
  stream.onClose(unsubscribe);
  await pump();
}
