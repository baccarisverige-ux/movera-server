import { NOT_HELD } from "../reservations/view.js";
import { createHmac } from "node:crypto";
import { sql } from "kysely";
import type { Executor } from "../db/db.js";
import { DISPATCH_FIX_MAX_AGE_SECONDS } from "../drivers/service.js";
import { contract } from "../contract/contract.js";
import { haversineKm } from "../maps/routing.js";
import { DRIVER_ASSIGNED } from "../rules/transitions.js";

/**
 * The free cars near the rider, for its map while it chooses a ride (contract v0.5.2 §13, contract.json#riderNearby).
 * Nothing in the answer tells who drives: no driver or vehicle id, name, plate, category or trip; positions are
 * moved 100–200 m (v0.18.4, G3-D4) and rounded; the key is an HMAC of the driver id and the day, so one car keeps its key through the day only.
 */

type Rules = { radiusMeters: number; maxVehicles: number; freshSeconds: number; refreshSeconds: number; roundDecimals: number };
const RULES = (contract as unknown as { riderNearby: Rules }).riderNearby;

const METERS_PER_DEGREE = 111_320;

/** v0.18.4 (G3-D4, contract.json#driverHome.nearbyBlur): every car is moved minMeters..maxMeters, stable per slot. */
type Blur = { minMeters: number; maxMeters: number; stableMinutes: number };
const BLUR = (contract as unknown as { driverHome: { nearbyBlur: Blur } }).driverHome.nearbyBlur;

/** The car's shown position: moved by a distance and direction from an HMAC of the driver and the time slot. */
export function blurred(secret: string, driverId: string, at: { lat: number; lng: number }, now: Date): { lat: number; lng: number } {
  const slot = Math.floor(now.getTime() / (BLUR.stableMinutes * 60_000));
  const h = createHmac("sha256", secret).update(`nearby-blur|${slot}|${driverId}`).digest();
  const meters = BLUR.minMeters + (h.readUInt32BE(0) / 0xffffffff) * (BLUR.maxMeters - BLUR.minMeters);
  const angle = (h.readUInt32BE(4) / 0xffffffff) * 2 * Math.PI;
  const dLat = (meters * Math.cos(angle)) / METERS_PER_DEGREE;
  const dLng = (meters * Math.sin(angle)) / (METERS_PER_DEGREE * Math.max(0.01, Math.cos((at.lat * Math.PI) / 180)));
  return { lat: at.lat + dLat, lng: at.lng + dLng };
}

/** The day in Stockholm (YYYY-MM-DD): the key changes at local midnight. */
// Stress T-A part 4: one formatter for the process (building one per vehicle per map request was ~3 % of the copy's CPU).
const STOCKHOLM_DAY = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm", year: "numeric", month: "2-digit", day: "2-digit" });
function stockholmDay(now: Date): string {
  return STOCKHOLM_DAY.format(now);
}

export function vehicleKey(secret: string, driverId: string, now: Date): string {
  return createHmac("sha256", secret).update(`nearby|${stockholmDay(now)}|${driverId}`).digest("base64url").slice(0, 12);
}

const round = (value: number) => {
  const f = 10 ** RULES.roundDecimals;
  return Math.round(value * f) / f;
};

/** One car as the rider's map gets it: the opaque key, the blurred and rounded position, the heading. */
export type NearbyCar = { key: string; lat: number; lng: number; heading?: number };

/** v0.18.145 (contract.json#loadCut.nearbyCache): the grid cell the cache keeps cars for. */
export const NEARBY_CELL_DEGREES = 0.005;
export const nearbyCell = (p: { lat: number; lng: number }): string => `${Math.floor(p.lat / NEARBY_CELL_DEGREES)}:${Math.floor(p.lng / NEARBY_CELL_DEGREES)}`;
/** Past this many cells the expired ones are dropped (a copy never holds more than the cells asked in the last few s). */
const PRUNE_AT = 2_000;

/**
 * v0.18.145 (S4c load cut, contract.json#loadCut.nearbyCache): each server copy keeps the cars of a grid cell for at
 * most `ms` (NEARBY_CACHE_MS, default 2500, 0 = off), so the riders of one cell share one database read. Only what the
 * answer already shows is kept — the blurred, rounded positions, the day keys and the headings — never a driver id or a
 * true position. Expiry is on the request clock. Riders asking for a cell while it is being read share that read.
 */
export class NearbyCache {
  private readonly cells = new Map<string, { until: number; cars: Promise<NearbyCar[]>; kept?: NearbyCar[] }>();
  constructor(readonly ms: number) {}

  get on(): boolean {
    return this.ms > 0;
  }

  cars(cell: string, now: Date, read: () => Promise<NearbyCar[]>): Promise<NearbyCar[]> {
    const at = now.getTime();
    const kept = this.cells.get(cell);
    if (kept !== undefined && kept.until > at) return kept.cars;
    if (this.cells.size >= PRUNE_AT) for (const [k, v] of this.cells) if (v.until <= at) this.cells.delete(k);
    const cars = read();
    const entry: { until: number; cars: Promise<NearbyCar[]>; kept?: NearbyCar[] } = { until: at + this.ms, cars };
    this.cells.set(cell, entry);
    // A failed read is not kept: the next rider reads again.
    cars.then(
      (list) => void (entry.kept = list),
      () => {
        if (this.cells.get(cell) === entry) this.cells.delete(cell);
      },
    );
    return cars;
  }

  /** For tests: every car kept now (what the cache holds, nothing more). */
  keptCars(): NearbyCar[] {
    return [...this.cells.values()].flatMap((entry) => entry.kept ?? []);
  }
}

type DriverRow = { driver_id: string; lat: number; lng: number; heading: number | null };

/** The free cars within `radius` m of `point` (true positions), at most `limit`, nearest first. */
async function freeCarsAround(ex: Executor, point: { lat: number; lng: number }, radius: number, limit: number, now: Date): Promise<DriverRow[]> {
  const dLat = radius / METERS_PER_DEGREE;
  const dLng = radius / (METERS_PER_DEGREE * Math.max(0.01, Math.cos((point.lat * Math.PI) / 180)));
  return ex
    .selectFrom("drivers")
    .innerJoin("driver_locations", "driver_locations.driver_id", "drivers.driver_id")
    .select(["drivers.driver_id", "driver_locations.lat", "driver_locations.lng", "driver_locations.heading"])
    .where("drivers.account_status", "=", "active")
    .where("drivers.online_status", "=", "online")
    .where("driver_locations.received_at", ">", new Date(now.getTime() - RULES.freshSeconds * 1000))
    .where("driver_locations.measured_at", ">", new Date(now.getTime() - DISPATCH_FIX_MAX_AGE_SECONDS * 1000))
    .where("driver_locations.lat", ">=", point.lat - dLat)
    .where("driver_locations.lat", "<=", point.lat + dLat)
    .where("driver_locations.lng", ">=", point.lng - dLng)
    .where("driver_locations.lng", "<=", point.lng + dLng)
    // A driver with an accepted trip is not free, also before the app says on_trip.
    .where(({ not, exists, selectFrom }) =>
      not(exists(selectFrom("trips").select(sql`1`.as("one")).whereRef("trips.driver_id", "=", "drivers.driver_id").where("trips.status", "in", [...DRIVER_ASSIGNED]).where(NOT_HELD))),
    )
    // Job 1 (stress M4): never more than a few times the cars shown, nearest first (a busy city centre has hundreds).
    .orderBy(sql`(driver_locations.lat - ${point.lat}) * (driver_locations.lat - ${point.lat}) + (driver_locations.lng - ${point.lng}) * (driver_locations.lng - ${point.lng}) * ${Math.cos((point.lat * Math.PI) / 180) ** 2}`)
    .limit(limit)
    .execute() as Promise<DriverRow[]>;
}

/** What the map shows of one car (no identity, no true position). */
function shownCar(secret: string, r: DriverRow, now: Date): NearbyCar {
  const shown = blurred(secret, r.driver_id, { lat: r.lat, lng: r.lng }, now);
  return {
    key: vehicleKey(secret, r.driver_id, now),
    lat: round(shown.lat),
    lng: round(shown.lng),
    ...(r.heading !== null && Number.isFinite(r.heading) ? { heading: Math.round(((r.heading % 360) + 360) % 360) } : {}),
  };
}

export async function nearbyVehicles(ex: Executor, point: { lat: number; lng: number }, secret: string, now: Date, cache?: NearbyCache) {
  if (cache?.on) {
    // The whole cell: every car whose shown position can be within radiusMeters of any point of the cell (half the
    // cell's diagonal plus the largest blur further out), more of them than one rider is shown.
    const cell = nearbyCell(point);
    const centre = { lat: (Math.floor(point.lat / NEARBY_CELL_DEGREES) + 0.5) * NEARBY_CELL_DEGREES, lng: (Math.floor(point.lng / NEARBY_CELL_DEGREES) + 0.5) * NEARBY_CELL_DEGREES };
    const halfDiagonal = (NEARBY_CELL_DEGREES * METERS_PER_DEGREE * Math.SQRT2) / 2;
    const cars = await cache.cars(cell, now, async () =>
      (await freeCarsAround(ex, centre, RULES.radiusMeters + halfDiagonal + BLUR.maxMeters, RULES.maxVehicles * 8, now)).map((r) => shownCar(secret, r, now)),
    );
    const items = cars
      .map((car) => ({ car, meters: haversineKm(point, car) * 1000 }))
      .filter((x) => x.meters <= RULES.radiusMeters)
      .sort((a, b) => a.meters - b.meters || (a.car.key < b.car.key ? -1 : 1))
      .slice(0, RULES.maxVehicles)
      .map(({ car }) => car);
    return { items, refreshSeconds: RULES.refreshSeconds, radiusMeters: RULES.radiusMeters };
  }
  const rows = await freeCarsAround(ex, point, RULES.radiusMeters, RULES.maxVehicles * 4, now);
  const items = rows
    .map((r) => ({ r, meters: haversineKm(point, { lat: r.lat, lng: r.lng }) * 1000 }))
    .filter((x) => x.meters <= RULES.radiusMeters)
    .sort((a, b) => a.meters - b.meters || (a.r.driver_id < b.r.driver_id ? -1 : 1))
    .slice(0, RULES.maxVehicles)
    .map(({ r }) => shownCar(secret, r, now));
  return { items, refreshSeconds: RULES.refreshSeconds, radiusMeters: RULES.radiusMeters };
}
