import { sql } from "kysely";
import type { Executor, Trx } from "../db/db.js";
import type { TripRow } from "../db/tripLog.js";
import { zoneAt } from "../config/zoneLookup.js";
import { geometry } from "../config/geometryCache.js";
import { inPolygon, type Polygon } from "../zones/geometry.js";

/**
 * v0.18.36 §60 fix job 9 "airport queue" (R27, owner G15 Q5 2026-11-02 + job 9 answers 2026-11-05,
 * contract.json#airportQueue). Rule 33: every fact lives in the database (airport_queue_entries, one open row per
 * driver by a unique index; the place is joined_at then entry_id), so any server copy reads and changes the same queue.
 */

export const QUEUE_REASON = "airport-queue";

/**
 * v0.18.145 (S4c load cut, contract.json#loadCut.airportQueueLive): a change of a line NOTIFYs this channel once per
 * driver whose place changed ({ driverId, areaId }); every server copy LISTENs and its driver settings streams send
 * airport_queue_changed (realtime/streams.ts attachConfig). NOTIFY inside the transaction is delivered at its commit,
 * so a rolled-back change tells nobody (rule 33: any copy may make the change, every copy hears it).
 */
export const AIRPORT_QUEUE_CHANNEL = "movera_airport_queue";

/** Tells each of `driverIds` and, with `line`, every driver still open in the area's line (they moved up). */
async function tell(ex: Executor, areaId: string, driverIds: readonly string[], line: boolean): Promise<void> {
  if (driverIds.length === 0 && !line) return;
  await sql`SELECT pg_notify(${AIRPORT_QUEUE_CHANNEL}, json_build_object('driverId', t.d, 'areaId', ${areaId}::text)::text)
    FROM (SELECT unnest(${[...driverIds]}::text[]) AS d
          UNION SELECT e.driver_id FROM airport_queue_entries e WHERE ${line} AND e.area_id = ${areaId} AND e.left_at IS NULL) t`.execute(ex);
}

export type AreaRow = {
  area_id: string;
  airport_zone_id: string;
  polygon: unknown;
  south: number;
  west: number;
  north: number;
  east: number;
  is_on: boolean;
  leave_grace_min: number;
  offer_seconds: number;
  max_queue_offers: number;
  keep_place_after_decline: boolean;
  updated_at: Date;
  updated_by: string | null;
};

export const areaIdOf = (zoneId: string) => `AQ-${zoneId}`;

export function areaView(row: AreaRow) {
  return {
    areaId: row.area_id,
    airportZoneId: row.airport_zone_id,
    polygon: row.polygon as Polygon,
    on: row.is_on,
    leaveGraceMin: row.leave_grace_min,
    offerSeconds: row.offer_seconds,
    maxQueueOffers: row.max_queue_offers,
    keepPlaceAfterDecline: row.keep_place_after_decline,
    updatedAt: row.updated_at.toISOString(),
  };
}

const inside = (area: Pick<AreaRow, "south" | "west" | "north" | "east" | "polygon">, p: { lat: number; lng: number }) =>
  p.lat >= area.south && p.lat <= area.north && p.lng >= area.west && p.lng <= area.east && inPolygon(p.lat, p.lng, area.polygon as Polygon);

/** The queue area that is on and holds this point, if any. */
async function areaAt(ex: Executor, p: { lat: number; lng: number }): Promise<AreaRow | undefined> {
  // Stress T-A part 3: from memory when the geometry cache is on (config/geometryCache.ts).
  const cached = await geometry(ex);
  if (cached !== null) return (cached.areas as unknown as AreaRow[]).find((a) => a.is_on && a.south <= p.lat && a.north >= p.lat && a.west <= p.lng && a.east >= p.lng && inside(a, p));
  const rows = (await ex.selectFrom("airport_queue_areas").selectAll().where("is_on", "=", true)
    .where("south", "<=", p.lat).where("north", ">=", p.lat).where("west", "<=", p.lng).where("east", ">=", p.lng).execute()) as AreaRow[];
  return rows.find((a) => inside(a, p));
}

/**
 * An open entry counts only while its driver is online (no trip) in the same online session he joined in: a driver who
 * went offline, or online again later (online_since after joined_at), has lost his place (contract airportQueue.leave).
 */
const VALID = sql<boolean>`d.online_status = 'online' AND (d.online_since IS NULL OR d.online_since <= e.joined_at)`;

async function leave(ex: Executor, entryId: string, reason: string, now: Date): Promise<void> {
  const gone = await ex.updateTable("airport_queue_entries").set({ left_at: now, left_reason: reason }).where("entry_id", "=", entryId).where("left_at", "is", null)
    .returning(["area_id", "driver_id"]).executeTakeFirst();
  if (gone) await tell(ex, gone.area_id, [gone.driver_id], true);
}

/** Lazily closes the entries of an area that no longer count (offline, new session, outside past the grace). */
async function prune(ex: Executor, area: AreaRow, now: Date): Promise<void> {
  const graceStart = new Date(now.getTime() - area.leave_grace_min * 60_000);
  const gone = await sql<{ driver_id: string }>`UPDATE airport_queue_entries e SET left_at = ${now}, left_reason = CASE WHEN e.outside_since IS NOT NULL AND e.outside_since < ${graceStart} THEN 'left_area' ELSE 'offline' END
    FROM drivers d WHERE d.driver_id = e.driver_id AND e.area_id = ${area.area_id} AND e.left_at IS NULL
    AND (NOT (${VALID}) OR (e.outside_since IS NOT NULL AND e.outside_since < ${graceStart})) RETURNING e.driver_id`.execute(ex);
  if (gone.rows.length > 0) await tell(ex, area.area_id, gone.rows.map((r) => r.driver_id), true);
}

/**
 * POST /driver/location (after the fix is stored): join, stay or leave. Join = inside an area that is on, online and
 * free; a driver who dropped a rider at the airport joins with his next position (owner job 9 Q5 "Yes, join at once").
 */
export async function onDriverPosition(
  trx: Trx,
  driverId: string,
  p: { lat: number; lng: number },
  now: Date,
  // Stress T-A part 3: POST /driver/location read the driver row (and whether he has an open entry) already.
  known?: { driver: { online_status: string; online_since: Date | null }; hasOpenEntry: boolean },
): Promise<void> {
  const driver = known?.driver ?? (await trx.selectFrom("drivers").select(["online_status", "online_since"]).where("driver_id", "=", driverId).executeTakeFirst());
  if (!driver) return;
  const open = known?.hasOpenEntry === false ? undefined : await trx.selectFrom("airport_queue_entries as e").innerJoin("airport_queue_areas as a", "a.area_id", "e.area_id")
    .select(["e.entry_id", "e.joined_at", "e.outside_since", "a.area_id", "a.is_on", "a.south", "a.west", "a.north", "a.east", "a.polygon", "a.leave_grace_min"])
    .where("e.driver_id", "=", driverId).where("e.left_at", "is", null).forUpdate("e").executeTakeFirst();
  const free = driver.online_status === "online";
  if (open) {
    const sameSession = driver.online_since === null || driver.online_since.getTime() <= open.joined_at.getTime();
    if (!free || !sameSession) await leave(trx, open.entry_id, "offline", now);
    else if (!open.is_on) await leave(trx, open.entry_id, "area_off", now);
    else if (inside(open, p)) {
      if (open.outside_since !== null) await trx.updateTable("airport_queue_entries").set({ outside_since: null }).where("entry_id", "=", open.entry_id).execute();
      return;
    } else {
      const since = open.outside_since ?? now;
      if (now.getTime() - since.getTime() > open.leave_grace_min * 60_000) await leave(trx, open.entry_id, "left_area", now);
      else {
        if (open.outside_since === null) await trx.updateTable("airport_queue_entries").set({ outside_since: now }).where("entry_id", "=", open.entry_id).execute();
        return;
      }
    }
  }
  if (!free) return;
  const area = await areaAt(trx, p);
  if (!area) return;
  // Two copies handling two batches of one driver at once: the unique open-row index keeps one.
  const joined = await trx.insertInto("airport_queue_entries").values({ area_id: area.area_id, driver_id: driverId, joined_at: now })
    .onConflict((c) => c.column("driver_id").where("left_at", "is", null).doNothing()).returning("entry_id").executeTakeFirst();
  // v0.18.145: only the driver who joined (at the back: nobody else's place changed).
  if (joined) await tell(trx, area.area_id, [driverId], false);
}

/** Accepting any trip leaves the queue (a queue trip counts as an airport pickup for the Dashboard). */
export async function leaveOnAccept(trx: Trx, driverId: string, reasonCode: string | null, now: Date): Promise<void> {
  const gone = await trx.updateTable("airport_queue_entries").set({ left_at: now, left_reason: reasonCode === QUEUE_REASON ? "queue_trip" : "accepted" })
    .where("driver_id", "=", driverId).where("left_at", "is", null).returning("area_id").execute();
  for (const row of gone) await tell(trx, row.area_id, [driverId], true);
}

/** Turning an area off (or redrawing it off) empties its queue. */
export async function emptyArea(trx: Trx, areaId: string, now: Date): Promise<void> {
  const gone = await trx.updateTable("airport_queue_entries").set({ left_at: now, left_reason: "area_off" }).where("area_id", "=", areaId).where("left_at", "is", null)
    .returning("driver_id").execute();
  await tell(trx, areaId, gone.map((r) => r.driver_id), false);
}

/** The valid open entries of an area, first in line first. */
async function lineOf(ex: Executor, areaId: string, graceMin: number, now: Date) {
  const graceStart = new Date(now.getTime() - graceMin * 60_000);
  return ex.selectFrom("airport_queue_entries as e").innerJoin("drivers as d", "d.driver_id", "e.driver_id")
    .select(["e.entry_id", "e.driver_id", "e.joined_at"]).where("e.area_id", "=", areaId).where("e.left_at", "is", null).where(VALID)
    .where((eb) => eb.or([eb("e.outside_since", "is", null), eb("e.outside_since", ">=", graceStart)]))
    .orderBy("e.joined_at").orderBy("e.entry_id").execute();
}

/** GET /driver/airport-queue (contract airportQueue.driverRead). */
export async function queueStatus(ex: Executor, driverId: string, now: Date) {
  const mine = await ex.selectFrom("airport_queue_entries as e").innerJoin("drivers as d", "d.driver_id", "e.driver_id").innerJoin("airport_queue_areas as a", "a.area_id", "e.area_id")
    .select(["e.entry_id", "e.joined_at", "e.outside_since", "a.area_id", "a.airport_zone_id", "a.is_on", "a.leave_grace_min"])
    .where("e.driver_id", "=", driverId).where("e.left_at", "is", null).where(VALID).executeTakeFirst();
  const graceOver = mine?.outside_since && now.getTime() - mine.outside_since.getTime() > mine.leave_grace_min * 60_000;
  if (mine && mine.is_on && !graceOver) {
    const line = await lineOf(ex, mine.area_id, mine.leave_grace_min, now);
    const ahead = line.findIndex((l) => l.entry_id === mine.entry_id);
    return {
      status: "in_queue" as const,
      areaId: mine.area_id,
      airportZoneId: mine.airport_zone_id,
      position: Math.max(0, ahead) + 1,
      ahead: Math.max(0, ahead),
      joinedAt: mine.joined_at.toISOString(),
      waitingMin: Math.max(0, Math.floor((now.getTime() - mine.joined_at.getTime()) / 60_000)),
    };
  }
  const anyOn = await ex.selectFrom("airport_queue_areas").select("area_id").where("is_on", "=", true).limit(1).executeTakeFirst();
  return { status: anyOn ? ("not_in_area" as const) : ("off" as const) };
}

/**
 * B1.29: may queuePick give this trip to a queued driver at all (its pickup is in an airport zone whose area is on)?
 * Read only. A round that skips the driver facts on a sure wait does so only when this is false, so queuePick (which
 * also re-orders and prunes the line) runs exactly when it ran before.
 */
export async function queueMayPick(ex: Executor, trip: Pick<TripRow, "pickup">): Promise<boolean> {
  const airport = await zoneAt(ex, trip.pickup as { lat: number; lng: number }, { kind: "airport" });
  if (!airport) return false;
  const area = await ex.selectFrom("airport_queue_areas").select("area_id").where("airport_zone_id", "=", airport.zoneId).where("is_on", "=", true).executeTakeFirst();
  return area !== undefined;
}

/**
 * Dispatch (contract airportQueue.dispatch): for a trip picked up inside an airport zone whose area is on, the first
 * driver in line who is in this round's pool (the normal filter) and was not asked for this trip yet, while fewer than
 * maxQueueOffers queue offers went out. Runs in the round's transaction (trip row locked); the round then locks the
 * driver row NOWAIT and checks him again, as for every Exclusive.
 */
export async function queuePick(trx: Trx, trip: Pick<TripRow, "trip_id" | "pickup">, poolIds: string[], now: Date): Promise<{ driverId: string; offerSeconds: number } | null> {
  if (poolIds.length === 0) return null;
  const airport = await zoneAt(trx, trip.pickup as { lat: number; lng: number }, { kind: "airport" });
  if (!airport) return null;
  const area = (await trx.selectFrom("airport_queue_areas").selectAll().where("airport_zone_id", "=", airport.zoneId).where("is_on", "=", true).executeTakeFirst()) as AreaRow | undefined;
  if (!area) return null;
  const asked = await trx.selectFrom("offers").select(["driver_id", "reason_code", "status", "answered_at"]).where("trip_id", "=", trip.trip_id).execute();
  if (asked.filter((o) => o.reason_code === QUEUE_REASON).length >= area.max_queue_offers) return null;
  if (!area.keep_place_after_decline) {
    // keepPlaceAfterDecline false: a declined or missed queue offer sends him to the back (joined_at = when he answered).
    for (const o of asked) {
      if (o.reason_code !== QUEUE_REASON || !["declined", "expired"].includes(o.status) || !o.answered_at) continue;
      const moved = await trx.updateTable("airport_queue_entries").set({ joined_at: o.answered_at }).where("driver_id", "=", o.driver_id).where("area_id", "=", area.area_id)
        .where("left_at", "is", null).where("joined_at", "<", o.answered_at).returning("entry_id").execute();
      // v0.18.145: he went to the back, so everyone behind him moved up.
      if (moved.length > 0) await tell(trx, area.area_id, [o.driver_id], true);
    }
  }
  await prune(trx, area, now);
  const pool = new Set(poolIds);
  const gone = new Set(asked.map((o) => o.driver_id));
  const first = (await lineOf(trx, area.area_id, area.leave_grace_min, now)).find((l) => pool.has(l.driver_id) && !gone.has(l.driver_id));
  return first ? { driverId: first.driver_id, offerSeconds: area.offer_seconds } : null;
}

/** GET /admin/airport-queues (contract airportQueue.adminRead): the Dashboard airport card. */
export async function queueFeed(ex: Executor, zoneIds: (zoneId: string) => boolean, now: Date) {
  const areas = ((await ex.selectFrom("airport_queue_areas").selectAll().orderBy("airport_zone_id").execute()) as AreaRow[]).filter((a) => zoneIds(a.airport_zone_id));
  const hourAgo = new Date(now.getTime() - 3600_000);
  const items = [];
  for (const a of areas) {
    const line = a.is_on ? await lineOf(ex, a.area_id, a.leave_grace_min, now) : [];
    const picked = await ex.selectFrom("airport_queue_entries").select((eb) => eb.fn.countAll<string>().as("n")).where("area_id", "=", a.area_id).where("left_reason", "=", "queue_trip").where("left_at", ">", hourAgo).executeTakeFirstOrThrow();
    const oldest = line[0]?.joined_at;
    items.push({
      areaId: a.area_id,
      airportZoneId: a.airport_zone_id,
      on: a.is_on,
      waiting: line.length,
      longestWaitMin: oldest ? Math.max(0, Math.floor((now.getTime() - oldest.getTime()) / 60_000)) : 0,
      pickupsLastHour: Number(picked.n),
    });
  }
  return { items };
}
