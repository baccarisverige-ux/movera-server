import { driversWithClashingBooking, driversWithCurrentTrip } from "../../reservations/service.js";
import { driversAtDrivingLimit } from "../../drivers/drivingTime.js";
import { PERFORMANCE, performanceFromCounts, scoreInputs } from "../../drivers/performance.js";
import { TimerBusy } from "../../jobs/timers.js";
import { sql } from "kysely";
import { documentsExpiredFor } from "../../drivers/reminders.js";
import type { Executor, Trx } from "../../db/db.js";
import type { TripRow } from "../../db/tripLog.js";
import { liveDocument } from "../../config/service.js";
import { DISPATCH_FIX_MAX_AGE_SECONDS, STALE_AFTER_SECONDS } from "../../drivers/service.js";
import { zoneChecker } from "../../drivers/presence.js";
import { dispatchKm, type Candidate, type DispatchDoc } from "../engine.js";
import { type Place, PICKUP_KMH, RADAR_LIST_MAX } from "./shared.js";
import { driversWithCategoryOff } from "../../accounts/phoneData.js";
import { NOT_HELD } from "../../reservations/view.js";
import { contract } from "../../contract/contract.js";

/* ---------------------------------------------------------------- candidates */

type Pool = { candidates: Candidate[]; meta: Map<string, { km: number; etaSeconds: number; meters: number }>; bookedNext: Set<string> };

/* ---------------------------------------------------------------- v0.18.33 booked ride next (owner Q7) */

type BookedNext = { on: boolean; withinMin: number };
const BOOKED_NEXT_DEFAULT = (contract as unknown as { configDefaults: { dispatch: { zone: { bookedNext: BookedNext } } } }).configDefaults.dispatch.zone.bookedNext;
/** DispatchDocument.bookedNext with the defaults (on, 60 min); a bad value reads as the default. */
export function bookedNextOf(doc: Pick<DispatchDoc, "bookedNext"> | null | undefined): BookedNext {
  const b = doc?.bookedNext;
  return {
    on: typeof b?.on === "boolean" ? b.on : BOOKED_NEXT_DEFAULT.on,
    withinMin: typeof b?.withinMin === "number" && Number.isFinite(b.withinMin) && b.withinMin >= 0 && b.withinMin <= 240 ? b.withinMin : BOOKED_NEXT_DEFAULT.withinMin,
  };
}
/** The booked ride's pickup is close enough for drivers on a trip (contract.json#afterTestRules.bookedNext). */
export function bookedNextOpen(trip: Pick<TripRow, "kind" | "scheduled_at">, settings: BookedNext, now: Date): boolean {
  return settings.on && trip.kind === "scheduled" && trip.scheduled_at !== null && trip.scheduled_at.getTime() - now.getTime() <= settings.withinMin * 60_000;
}
/**
 * Owner answer 2026-11-05 (contract.json#afterTestRules.bookedNext): may drivers on a trip get this trip as an Exclusive?
 * A booked ride: bookedNext on and its pickup within withinMin. A live ride: the zone's exclusiveWhileDriving is on.
 */
export function onTripOpen(trip: Pick<TripRow, "kind" | "scheduled_at">, doc: Pick<DispatchDoc, "bookedNext" | "exclusiveWhileDriving"> | null | undefined, now: Date): boolean {
  if (trip.kind === "scheduled") return bookedNextOpen(trip, bookedNextOf(doc), now);
  return doc?.exclusiveWhileDriving?.on === true;
}
const ON_TRIP_DEFAULT = (contract as unknown as { configDefaults: { onTripOffers: { minRouteDonePct: number } } }).configDefaults.onTripOffers.minRouteDonePct;
/** CountryRules.onTripOffers.minRouteDonePct of the zone (its own, else its country's Standard), else 70. */
export async function onTripMinDonePct(ex: Trx, zoneId: string): Promise<number> {
  const rules = await liveDocument<{ onTripOffers?: { minRouteDonePct?: unknown } }>(ex, "country_rules", zoneId);
  const v = rules?.document.onTripOffers?.minRouteDonePct;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100 ? v : ON_TRIP_DEFAULT;
}
/** Owner Q5 (2026-11-05): CountryRules.onTripOffers.lateFreeCancelMin, minutes after accept from which the rider of a
 * chained trip may cancel free (default 10, 0–120). */
export async function chainLateFreeCancelMin(ex: Trx | Executor, zoneId: string): Promise<number> {
  const rules = await liveDocument<{ onTripOffers?: { lateFreeCancelMin?: unknown } }>(ex, "country_rules", zoneId);
  const v = rules?.document.onTripOffers?.lateFreeCancelMin;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 120 ? v : CHAIN_LATE_DEFAULT;
}
const CHAIN_LATE_DEFAULT = (contract as unknown as { configDefaults: { onTripOffers: { lateFreeCancelMin: number } } }).configDefaults.onTripOffers.lateFreeCancelMin;
/** At accept: this driver, on a trip, may still take this trip (an Exclusive) as his next one. */
export async function onTripFits(trx: Trx, trip: TripRow, driverId: string, now: Date): Promise<boolean> {
  const live = await liveDocument<DispatchDoc>(trx, "dispatch", trip.zone_id);
  if (!onTripOpen(trip, live?.document, now)) return false;
  const at = await trx.selectFrom("driver_locations").select(["driver_id", "lat", "lng"]).where("driver_id", "=", driverId).executeTakeFirst();
  if (!at) return false;
  return (await onTripReach(trx, trip, [at], now)).has(driverId);
}
const ON_BOARD = new Set(["rider_onboard", "in_trip", "approaching_dropoff"]);
const hoursMs = (km: number) => (km / PICKUP_KMH) * 3600_000;
/**
 * Owner Q7 + answer 2026-11-05: the drivers on a trip who may get this trip next. The rider must be on board and he must
 * have driven at least minRouteDonePct % of the route: done = 1 − (dispatchKm to its drop-off) / (its booked km). He
 * holds no other queued trip. A booked ride also needs the end of his trip (now + the drive to its drop-off) + the drive
 * from there to the booked pickup by the booked time. km (and the ETA) are counted from the current drop-off.
 */
export async function onTripReach(trx: Trx, trip: TripRow, drivers: Array<{ driver_id: string; lat: number; lng: number }>, now: Date): Promise<Map<string, { dropKm: number; inMin: number }>> {
  const out = new Map<string, { dropKm: number; inMin: number }>();
  if (drivers.length === 0) return out;
  const minPct = await onTripMinDonePct(trx, trip.zone_id);
  const current = await trx.selectFrom("trips").select(["trip_id", "driver_id", "status", "distance_meters", "dropoff"])
    .where("driver_id", "in", drivers.map((d) => d.driver_id)).where("trip_id", "!=", trip.trip_id)
    .where("status", "in", ["accepted", "driver_to_pickup", "arrived", "rider_onboard", "in_trip", "approaching_dropoff"]).where(NOT_HELD).execute();
  const queued = current.length
    ? new Set((await trx.selectFrom("trips").select("next_after_trip_id").where("next_after_trip_id", "in", current.map((c) => c.trip_id)).where("status", "=", "accepted").execute()).map((q) => q.next_after_trip_id))
    : new Set<string | null>();
  const pickup = trip.pickup as Place;
  for (const d of drivers) {
    const mine = current.filter((c) => c.driver_id === d.driver_id);
    if (mine.length !== 1) continue;
    const c = mine[0]!;
    if (!ON_BOARD.has(c.status) || queued.has(c.trip_id)) continue;
    const leftKm = dispatchKm({ lat: d.lat, lng: d.lng }, c.dropoff as Place);
    const totalKm = Number(c.distance_meters ?? 0) / 1000;
    const donePct = totalKm > 0 ? Math.max(0, 1 - leftKm / totalKm) * 100 : 0;
    if (donePct < minPct) continue;
    const endMs = now.getTime() + hoursMs(leftKm);
    const dropKm = dispatchKm(c.dropoff as Place, pickup);
    if (trip.kind === "scheduled" && (trip.scheduled_at === null || endMs + hoursMs(dropKm) > trip.scheduled_at.getTime())) continue;
    out.set(d.driver_id, { dropKm, inMin: Math.max(0, Math.round((endMs - now.getTime()) / 60_000)) });
  }
  return out;
}

/** v0.18.11: of `zoneIds`, those with the same country and currency as `zoneId` (neighbours never cross a border). */
async function sameCountryZones(trx: Trx, zoneId: string, zoneIds: string[]): Promise<string[]> {
  const home = await trx.selectFrom("zones").select(["country", "currency"]).where("zone_id", "=", zoneId).executeTakeFirst();
  if (!home) return [];
  const rows = await trx.selectFrom("zones").select("zone_id").where("zone_id", "in", zoneIds).where("country", "=", home.country).where("currency", "=", home.currency).execute();
  return rows.map((r) => r.zone_id);
}

/**
 * Drivers who may get an offer now, with what the score needs (contract §3.6; stale ones are left out, §12).
 *
 * Job 1 (fast dispatch, fix plan R1 d, audits/stress-test-2026-11-04.md H2): no lock on the zone's drivers any more,
 * and no query per driver — every check is ONE query for all drivers of the round (open offers, current trip, held
 * booking clash, expired papers, driving-time limit, score numbers). The round locks only the drivers it picked and
 * checks them again under that lock (lockAndRecheck), so two rounds still never give one free driver two Exclusives.
 * `reachKm` (rounds only): drivers farther than the widest search step are not read at all (a box around the pickup).
 */
export async function candidatesFor(trx: Trx, trip: TripRow, doc: DispatchDoc | null, now: Date, options: { reachKm?: number } = {}): Promise<Pool> {
  const pickup = trip.pickup as Place;
  // v0.18.11: with neighbours on, drivers of the listed zones are candidates too (the engine asks them from afterStep).
  // Only zones of the same country and currency as the trip zone may lend drivers (a SE zone never borrows FR).
  const listed = doc?.neighbours?.on ? doc.neighbours.zoneIds.filter((z) => z !== trip.zone_id) : [];
  const neighbourZones = listed.length ? await sameCountryZones(trx, trip.zone_id, listed) : [];
  // Deep fix 2026-11-02 (perf): only the drivers of this trip's zone (and its neighbours) are read.
  const zones = [trip.zone_id, ...neighbourZones];
  const inZones = sql<boolean>`drivers.zone_ids && ${sql.val(zones)}::text[]`;
  let query = trx
    .selectFrom("drivers")
    .innerJoin("driver_locations", "driver_locations.driver_id", "drivers.driver_id")
    .leftJoin("vehicles", "vehicles.vehicle_id", "drivers.vehicle_id")
    .select(["drivers.driver_id", "drivers.online_status", "drivers.category_ids", "drivers.zone_ids", "drivers.rating_sum", "drivers.rating_count", "drivers.last_free_at", "drivers.driving_since", "driver_locations.lat", "driver_locations.lng", "vehicles.category_ids as vehicle_category_ids", "vehicles.status as vehicle_status", "drivers.country", "drivers.account_type", "drivers.vehicle_id"])
    .where("drivers.account_status", "=", "active")
    // Next trips (an offer to a driver who still has a rider) are a later round (owner decision 10): only free
    // (online) drivers get live offers. v0.18.33 (owner Q7): a booked ride within bookedNext.withinMin also reads the
    // drivers on a trip (Exclusive only; checked below with onTripReach).
    .where("drivers.online_status", "in", onTripOpen(trip, doc, now) ? ["online", "on_trip"] : ["online"])
    .where(inZones)
    .where("driver_locations.received_at", ">", new Date(now.getTime() - STALE_AFTER_SECONDS * 1000))
    .where("driver_locations.measured_at", ">", new Date(now.getTime() - DISPATCH_FIX_MAX_AGE_SECONDS * 1000));
  if (options.reachKm !== undefined && Number.isFinite(options.reachKm) && !onTripOpen(trip, doc, now)) {
    // dispatchKm = straight line × roadFactor (≥ 1), so a box of reachKm straight-line km holds every driver in reach.
    const dLat = options.reachKm / 111.32;
    const dLng = dLat / Math.max(0.01, Math.cos((pickup.lat * Math.PI) / 180));
    query = query.where("driver_locations.lat", ">=", pickup.lat - dLat).where("driver_locations.lat", "<=", pickup.lat + dLat).where("driver_locations.lng", ">=", pickup.lng - dLng).where("driver_locations.lng", "<=", pickup.lng + dLng);
  }
  const rows = await query.execute();
  const pool: Pool = { candidates: [], meta: new Map(), bookedNext: new Set() };
  // v0.18.4 (G3-R2): only a driver whose latest position is inside one of his own zones gets offers.
  const insideOwn = await zoneChecker(trx, [...new Set(rows.flatMap((r) => r.zone_ids))]);
  // v0.18.26 (contract.json#phoneDataToServer.driverPreferences.dispatch): a category the driver switched off in Ride
  // preferences is not sent to him (one query for the whole round).
  const switchedOff = await driversWithCategoryOff(trx, rows.map((r) => r.driver_id), trip.category_id);
  const kept: Array<(typeof rows)[number] & { km: number; neighbour: boolean }> = [];
  // v0.18.33 (owner Q7): drivers on a trip who reach this booked ride in time, km counted from their drop-off.
  const reach = await onTripReach(trx, trip, rows.filter((r) => r.online_status === "on_trip"), now);
  for (const d of rows) {
    const next = d.online_status === "on_trip" ? reach.get(d.driver_id) : undefined;
    if (d.online_status === "on_trip" && next === undefined) continue;
    const own = d.zone_ids.includes(trip.zone_id);
    const neighbour = !own && d.zone_ids.some((z) => neighbourZones.includes(z));
    if (!own && !neighbour) continue;
    if (!next && !insideOwn({ lat: d.lat, lng: d.lng }, d.zone_ids)) continue;
    // A driver who cancelled this trip is not offered it again.
    if (trip.cancelled_driver_ids.includes(d.driver_id)) continue;
    if (!d.category_ids.includes(trip.category_id)) continue;
    if (switchedOff.has(d.driver_id)) continue;
    // Deep fix 2026-11-02 (live sweep H-2, g1-g3 M5): the car he drives must be approved for the trip's category too
    // (a Komfort trip needs a Komfort car; a car re-approved without Premium no longer gets Premium trips).
    // Checker MED 9: an approved car with no categories stored (older rows) does not narrow his own chosen types.
    const carTypes = d.vehicle_category_ids ?? [];
    if (d.vehicle_status !== null && (d.vehicle_status !== "approved" || (carTypes.length > 0 && !carTypes.includes(trip.category_id)))) continue;
    const km = next ? next.dropKm : dispatchKm({ lat: d.lat, lng: d.lng }, pickup);
    if (options.reachKm !== undefined && km > options.reachKm) continue;
    kept.push({ ...d, km, neighbour });
  }
  const facts = await roundFacts(trx, trip, kept, now, new Set(reach.keys()));
  for (const d of kept) {
    if (!facts.free(d.driver_id)) continue;
    const next = reach.get(d.driver_id);
    const candidate: Candidate = {
      driverId: d.driver_id,
      km: d.km,
      categoryIds: d.category_ids,
      ...(d.neighbour ? { neighbour: true } : {}),
      ...(next ? { finishing: { inMin: next.inMin, dropKm: next.dropKm }, bookedNext: true } : {}),
      idleMin: d.last_free_at ? (now.getTime() - d.last_free_at.getTime()) / 60_000 : 0,
      // v0.18.4 (G3-D2): the driver's real numbers (contract.json#driverHome.performance); a null one is left out
      // and the engine uses the §3.6 default.
      ...facts.score(d.driver_id, d.rating_sum, d.rating_count),
    };
    pool.candidates.push(candidate);
    pool.meta.set(d.driver_id, metaOf(d.km));
    if (next) pool.bookedNext.add(d.driver_id);
  }
  return pool;
}

const metaOf = (km: number) => ({ km, etaSeconds: Math.max(60, Math.round((km / PICKUP_KMH) * 3600)), meters: Math.round(km * 1000) });

/** The per-driver checks of a round, each one query for all `drivers`. */
async function roundFacts(trx: Trx, trip: TripRow, drivers: Array<{ driver_id: string; zone_ids: string[]; driving_since: Date | null; country: string | null; account_type: string | null; vehicle_id: string | null; km: number }>, now: Date, onTrip: Set<string> = new Set()) {
  const ids = drivers.map((d) => d.driver_id);
  const out = new Set<string>();
  if (ids.length > 0) {
    // A free driver holds at most one open Exclusive (§3.6) and at most RADAR_LIST_MAX open Radar offers.
    const open = await trx.selectFrom("offers").select(["driver_id", sql<string>`count(*) FILTER (WHERE kind IN ('exclusive', 'assigned'))`.as("ex"), sql<string>`count(*) FILTER (WHERE kind = 'radar')`.as("radar")]).where("driver_id", "in", ids).where("status", "=", "open").groupBy("driver_id").execute();
    for (const o of open) if (Number(o.ex) >= 1 || Number(o.radar) >= RADAR_LIST_MAX) out.add(o.driver_id);
    // v0.18.17: a booked ride he holds for later (scheduled, accepted) is not his current trip.
    // v0.18.33 (owner Q7): a driver on a trip who reaches this booked ride in time (onTripReach) is not left out for it.
    for (const id of await driversWithCurrentTrip(trx, ids)) if (!onTrip.has(id)) out.add(id);
    // Job 1 (fix plan R10): a driver holding a booked ride gets no live ride that would clash with it.
    const etaOf = new Map(drivers.map((d) => [d.driver_id, metaOf(d.km).etaSeconds]));
    for (const id of await driversWithClashingBooking(trx, trip, ids, (id) => etaOf.get(id) ?? 0, now)) out.add(id);
    // Deep fix 2026-11-02 (g1-g3 H1, checker MED 8): no offer while one of his REQUIRED papers, or of the car he drives,
    // is past its end date — the very rule of the offline sweep. Only drivers with such a paper at all are checked one by one.
    const left = drivers.filter((d) => !out.has(d.driver_id));
    const vehicleIds = left.flatMap((d) => (d.vehicle_id ? [d.vehicle_id] : []));
    const lapsed = await trx.selectFrom("documents").select(["owner_kind", "owner_id"])
      .where((eb) => eb.or([eb.and([eb("owner_kind", "=", "driver"), eb("owner_id", "in", left.length ? left.map((d) => d.driver_id) : ["-"])]), eb.and([eb("owner_kind", "=", "vehicle"), eb("owner_id", "in", vehicleIds.length ? vehicleIds : ["-"])])]))
      .where((eb) => eb.or([eb("status", "=", "expired"), eb.and([eb("status", "=", "approved"), eb("expires_at", "<=", now)])]))
      .execute();
    const withLapsed = new Set(lapsed.map((l) => `${l.owner_kind}:${l.owner_id}`));
    for (const d of left) {
      if (!withLapsed.has(`driver:${d.driver_id}`) && !(d.vehicle_id && withLapsed.has(`vehicle:${d.vehicle_id}`))) continue;
      if (await documentsExpiredFor(trx, d, now)) out.add(d.driver_id);
    }
    // v0.18.13 (contract.json#drivingLimits.enforced): no new offers after the driving-time limit.
    for (const id of await driversAtDrivingLimit(trx, drivers.filter((d) => !out.has(d.driver_id)), now)) out.add(id);
  }
  // Score numbers (contract.json#driverHome.performance), as driverPerformance, for all drivers at once.
  const since = new Date(now.getTime() - PERFORMANCE.windowDays * 24 * 3600_000);
  const free = ids.filter((id) => !out.has(id));
  const offers = free.length ? await trx.selectFrom("offers").select(["driver_id", sql<string>`count(*) FILTER (WHERE status = 'claimed')`.as("took"), sql<string>`count(*) FILTER (WHERE status = 'claimed' OR (status IN ('declined', 'expired') AND NOT driver_on_trip))`.as("all")]).where("driver_id", "in", free).where("kind", "in", ["exclusive", "assigned"]).where("sent_at", ">", since).where("sent_at", "<=", now).groupBy("driver_id").execute() : [];
  const cancels = free.length ? await trx.selectFrom("driver_cancels").select(["driver_id", (eb) => eb.fn.countAll<string>().as("n")]).where("driver_id", "in", free).where("at", ">", since).where("at", "<=", now).groupBy("driver_id").execute() : [];
  const offerOf = new Map(offers.map((o) => [o.driver_id, o]));
  const cancelOf = new Map(cancels.map((c) => [c.driver_id, Number(c.n)]));
  return {
    free: (id: string) => !out.has(id),
    score: (id: string, ratingSum: number | string | null, ratingCount: number | string | null) => {
      const o = offerOf.get(id);
      return scoreInputs(performanceFromCounts(since, Number(o?.all ?? 0), Number(o?.took ?? 0), cancelOf.get(id) ?? 0, Number(ratingSum ?? 0), Number(ratingCount ?? 0)));
    },
  };
}

/**
 * Job 1 (fix plan R1 d "re-check under lock"): the round locks ONLY the drivers it is about to send to (id order,
 * NOWAIT: a driver row held by a command makes the round busy and it is tried again shortly) and checks again that each
 * is still online, free, without an open Exclusive and without a current trip. Returns the drivers that no longer may
 * get this offer.
 */
export async function lockAndRecheck(trx: Trx, driverIds: string[], onTrip: Set<string> = new Set()): Promise<Set<string>> {
  const ids = [...new Set(driverIds)].sort();
  const gone = new Set<string>();
  if (ids.length === 0) return gone;
  let rows: Array<{ driver_id: string; online_status: string; account_status: string }>;
  try {
    rows = await trx.selectFrom("drivers").select(["driver_id", "online_status", "account_status"]).where("driver_id", "in", ids).orderBy("driver_id").forUpdate().noWait().execute();
  } catch (error) {
    if ((error as { code?: string }).code === "55P03") throw new TimerBusy("a chosen driver is busy");
    throw error;
  }
  // v0.18.33 (owner Q7): a booked-next driver (onTrip) may be on a trip; he still must not hold an open Exclusive.
  for (const r of rows) if ((r.online_status !== "online" && !(onTrip.has(r.driver_id) && r.online_status === "on_trip")) || r.account_status !== "active") gone.add(r.driver_id);
  for (const id of ids) if (!rows.some((r) => r.driver_id === id)) gone.add(id);
  const open = await trx.selectFrom("offers").select("driver_id").where("driver_id", "in", ids).where("status", "=", "open").where("kind", "in", ["exclusive", "assigned"]).execute();
  for (const o of open) gone.add(o.driver_id);
  for (const id of await driversWithCurrentTrip(trx, ids)) if (!onTrip.has(id)) gone.add(id);
  return gone;
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
