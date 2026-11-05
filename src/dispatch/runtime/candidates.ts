import { currentTripOf } from "../../reservations/service.js";
import { drivingLimitReached } from "../../drivers/drivingTime.js";
import { driverPerformance, scoreInputs } from "../../drivers/performance.js";
import { sql } from "kysely";
import { documentsExpiredFor } from "../../drivers/reminders.js";
import type { Trx } from "../../db/db.js";
import type { TripRow } from "../../db/tripLog.js";
import { liveDocument } from "../../config/service.js";
import { DISPATCH_FIX_MAX_AGE_SECONDS, STALE_AFTER_SECONDS } from "../../drivers/service.js";
import { zoneChecker } from "../../drivers/presence.js";
import { dispatchKm, type Candidate, type DispatchDoc } from "../engine.js";
import { type Place, PICKUP_KMH, RADAR_LIST_MAX } from "./shared.js";
import { driversWithCategoryOff } from "../../accounts/phoneData.js";

/* ---------------------------------------------------------------- candidates */

type Pool = { candidates: Candidate[]; meta: Map<string, { km: number; etaSeconds: number; meters: number }> };

/** v0.18.11: of `zoneIds`, those with the same country and currency as `zoneId` (neighbours never cross a border). */
async function sameCountryZones(trx: Trx, zoneId: string, zoneIds: string[]): Promise<string[]> {
  const home = await trx.selectFrom("zones").select(["country", "currency"]).where("zone_id", "=", zoneId).executeTakeFirst();
  if (!home) return [];
  const rows = await trx.selectFrom("zones").select("zone_id").where("zone_id", "in", zoneIds).where("country", "=", home.country).where("currency", "=", home.currency).execute();
  return rows.map((r) => r.zone_id);
}

/** Drivers who may get an offer now, with what the score needs (contract §3.6; stale ones are left out, §12). */
export async function candidatesFor(trx: Trx, trip: TripRow, doc: DispatchDoc | null, now: Date): Promise<Pool> {
  const pickup = trip.pickup as Place;
  // Lock the online drivers in id order before counting their open offers, so two rounds at once (two server
  // instances) cannot both give one free driver an Exclusive (lock order: trip, offers, then drivers by id).
  // v0.18.11: with neighbours on, drivers of the listed zones are candidates too (the engine asks them from afterStep).
  // Only zones of the same country and currency as the trip zone may lend drivers (a SE zone never borrows FR).
  const listed = doc?.neighbours?.on ? doc.neighbours.zoneIds.filter((z) => z !== trip.zone_id) : [];
  const neighbourZones = listed.length ? await sameCountryZones(trx, trip.zone_id, listed) : [];
  // Deep fix 2026-11-02 (perf): only the drivers of this trip's zone (and its neighbours) are locked and read — a
  // Stockholm round never waits for Paris drivers.
  const zones = [trip.zone_id, ...neighbourZones];
  const inZones = sql<boolean>`drivers.zone_ids && ${sql.val(zones)}::text[]`;
  await trx.selectFrom("drivers").select("driver_id").where("account_status", "=", "active").where("online_status", "=", "online").where(inZones).orderBy("driver_id").forUpdate().execute();
  const rows = await trx
    .selectFrom("drivers")
    .innerJoin("driver_locations", "driver_locations.driver_id", "drivers.driver_id")
    .leftJoin("vehicles", "vehicles.vehicle_id", "drivers.vehicle_id")
    .select(["drivers.driver_id", "drivers.online_status", "drivers.category_ids", "drivers.zone_ids", "drivers.rating_sum", "drivers.rating_count", "drivers.last_free_at", "driver_locations.lat", "driver_locations.lng", "vehicles.category_ids as vehicle_category_ids", "vehicles.status as vehicle_status", "drivers.country", "drivers.account_type", "drivers.vehicle_id"])
    .where("drivers.account_status", "=", "active")
    .where("drivers.online_status", "in", ["online", "on_trip"])
    .where(inZones)
    .where("driver_locations.received_at", ">", new Date(now.getTime() - STALE_AFTER_SECONDS * 1000))
    .where("driver_locations.measured_at", ">", new Date(now.getTime() - DISPATCH_FIX_MAX_AGE_SECONDS * 1000))
    .execute();
  const pool: Pool = { candidates: [], meta: new Map() };
  // v0.18.4 (G3-R2): only a driver whose latest position is inside one of his own zones gets offers.
  const insideOwn = await zoneChecker(trx, [...new Set(rows.flatMap((r) => r.zone_ids))]);
  // v0.18.26 (contract.json#phoneDataToServer.driverPreferences.dispatch): a category the driver switched off in Ride
  // preferences is not sent to him (one query for the whole round).
  const switchedOff = await driversWithCategoryOff(trx, rows.map((r) => r.driver_id), trip.category_id);
  for (const d of rows) {
    const own = d.zone_ids.includes(trip.zone_id);
    const neighbour = !own && d.zone_ids.some((z) => neighbourZones.includes(z));
    if (!own && !neighbour) continue;
    if (!insideOwn({ lat: d.lat, lng: d.lng }, d.zone_ids)) continue;
    // A driver who cancelled this trip is not offered it again.
    if (trip.cancelled_driver_ids.includes(d.driver_id)) continue;
    if (!d.category_ids.includes(trip.category_id)) continue;
    if (switchedOff.has(d.driver_id)) continue;
    // Deep fix 2026-11-02 (live sweep H-2, g1-g3 M5): the car he drives must be approved for the trip's category too
    // (a Komfort trip needs a Komfort car; a car re-approved without Premium no longer gets Premium trips).
    // Checker MED 9: an approved car with no categories stored (older rows) does not narrow his own chosen types.
    const carTypes = d.vehicle_category_ids ?? [];
    if (d.vehicle_status !== null && (d.vehicle_status !== "approved" || (carTypes.length > 0 && !carTypes.includes(trip.category_id)))) continue;
    // A free driver holds at most one open Exclusive; one with a rider at most exclusiveWhileDriving.count (§3.6).
    const open = await trx.selectFrom("offers").select((eb) => eb.fn.countAll<string>().as("n")).where("driver_id", "=", d.driver_id).where("status", "=", "open").where("kind", "in", ["exclusive", "assigned"]).executeTakeFirstOrThrow();
    // v0.18.17: a booked ride he holds for later (scheduled, accepted) is not his current trip.
    const active = await currentTripOf(trx, d.driver_id);
    // Next trips (an offer to a driver who still has a rider) are a later round (owner decision 10): only free
    // drivers get offers in the test week.
    if (active || d.online_status !== "online") continue;
    if (Number(open.n) >= 1) continue;
    const radarOpen = await trx.selectFrom("offers").select((eb) => eb.fn.countAll<string>().as("n")).where("driver_id", "=", d.driver_id).where("status", "=", "open").where("kind", "=", "radar").executeTakeFirstOrThrow();
    if (Number(radarOpen.n) >= RADAR_LIST_MAX) continue;
    // Deep fix 2026-11-02 (g1-g3 H1, checker MED 8): no offer while one of his REQUIRED papers, or of the car he drives,
    // is past its end date — the very rule of the offline sweep (expiredBlockers + the car's expired papers).
    if (await documentsExpiredFor(trx, d, now)) continue;
    // v0.18.13 (contract.json#drivingLimits.enforced): no new offers after the driving-time limit.
    if (await drivingLimitReached(trx, d.driver_id, now)) continue;
    const here = { lat: d.lat, lng: d.lng };
    const km = dispatchKm(here, pickup);
    const candidate: Candidate = {
      driverId: d.driver_id,
      km,
      categoryIds: d.category_ids,
      ...(neighbour ? { neighbour: true } : {}),
      idleMin: d.last_free_at ? (now.getTime() - d.last_free_at.getTime()) / 60_000 : 0,
      // v0.18.4 (G3-D2): the driver's real numbers (contract.json#driverHome.performance); a null one is left out
      // and the engine uses the §3.6 default.
      ...scoreInputs(await driverPerformance(trx, d.driver_id, now)),
    };
    pool.candidates.push(candidate);
    const etaSeconds = Math.max(60, Math.round((km / PICKUP_KMH) * 3600));
    pool.meta.set(d.driver_id, { km, etaSeconds, meters: Math.round(km * 1000) });
  }
  return pool;
}

/**
 * Checker 2026-11-01 (admin money sent at once): the drivers the automatic dispatch could offer this trip now (same
 * filter as a round: free, online, his zone and category, fresh position, no open Exclusive elsewhere, radar list not
 * full, did not cancel it), less those who already declined or let an offer of this trip expire, nearest first.
 */
export async function freeCandidatesByDistance(trx: Trx, trip: TripRow, now: Date, maxKm = Infinity): Promise<string[]> {
  return (await freeCandidatesDetailed(trx, trip, now, maxKm)).ids;
}

/**
 * Live fix 2026-11-02 (audits/live-dispatch-2026-11-02.md 3c): the same list plus why other free drivers were left
 * out, so the admin can say honestly that nobody got the money offer. expired = declined or let an offer of this
 * trip expire; far = beyond the zone's reach for this kind (maxKm).
 */
export async function freeCandidatesDetailed(trx: Trx, trip: TripRow, now: Date, maxKm = Infinity): Promise<{ ids: string[]; expired: number; far: number }> {
  // v0.18.11: the zone's live dispatch document, so drivers of same-country neighbour zones (neighbours on) are
  // candidates here too, through the very same busy / zone / category / declined filter.
  const live = await liveDocument<DispatchDoc>(trx, "dispatch", trip.zone_id);
  const pool = await candidatesFor(trx, trip, live?.document ?? null, now);
  const missed = await trx.selectFrom("offers").select("driver_id").where("trip_id", "=", trip.trip_id).where("status", "in", ["declined", "expired"]).execute();
  const gone = new Set(missed.map((m) => m.driver_id));
  const expired = pool.candidates.filter((c) => gone.has(c.driverId)).length;
  const far = pool.candidates.filter((c) => !gone.has(c.driverId) && c.km > maxKm).length;
  const free = pool.candidates
    .filter((c) => !gone.has(c.driverId) && c.km <= maxKm)
    .sort((a, b) => a.km - b.km || a.driverId.localeCompare(b.driverId));
  // Owner 2026-11-02 (decisions/driver-g5.md, last entry): simply the nearest free driver, a same-country neighbour-zone
  // driver too when neighbours are on (the in-zone-first rule is gone); the reach limits and filters above stay.
  return { ids: free.map((c) => c.driverId), expired, far };
}
