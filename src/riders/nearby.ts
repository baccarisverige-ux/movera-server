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
function stockholmDay(now: Date): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function vehicleKey(secret: string, driverId: string, now: Date): string {
  return createHmac("sha256", secret).update(`nearby|${stockholmDay(now)}|${driverId}`).digest("base64url").slice(0, 12);
}

const round = (value: number) => {
  const f = 10 ** RULES.roundDecimals;
  return Math.round(value * f) / f;
};

export async function nearbyVehicles(ex: Executor, point: { lat: number; lng: number }, secret: string, now: Date) {
  const dLat = RULES.radiusMeters / METERS_PER_DEGREE;
  const dLng = RULES.radiusMeters / (METERS_PER_DEGREE * Math.max(0.01, Math.cos((point.lat * Math.PI) / 180)));
  const rows = await ex
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
    .execute();
  const items = rows
    .map((r) => ({ r, meters: haversineKm(point, { lat: r.lat, lng: r.lng }) * 1000 }))
    .filter((x) => x.meters <= RULES.radiusMeters)
    .sort((a, b) => a.meters - b.meters || (a.r.driver_id < b.r.driver_id ? -1 : 1))
    .slice(0, RULES.maxVehicles)
    .map(({ r }) => ({ r, shown: blurred(secret, r.driver_id, { lat: r.lat, lng: r.lng }, now) }))
    .map(({ r, shown }) => ({
      key: vehicleKey(secret, r.driver_id, now),
      lat: round(shown.lat),
      lng: round(shown.lng),
      ...(r.heading !== null && Number.isFinite(r.heading) ? { heading: Math.round(((r.heading % 360) + 360) % 360) } : {}),
    }));
  return { items, refreshSeconds: RULES.refreshSeconds, radiusMeters: RULES.radiusMeters };
}
