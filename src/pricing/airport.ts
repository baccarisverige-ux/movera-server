import type { Executor } from "../db/db.js";
import type { LatLng } from "../maps/routing.js";

/**
 * contract v0.7.1 (contract.json#pricing.requestExtras.airport): the server, not the rider, decides the airport
 * fees: a point inside a zone of kind airport (ARN, BMA, …), whether that zone is open or not.
 */
export async function inAirportZone(ex: Executor, point: LatLng): Promise<boolean> {
  const row = await ex
    .selectFrom("zones")
    .select("zone_id")
    .where("kind", "=", "airport")
    .where("south", "<=", point.lat)
    .where("north", ">=", point.lat)
    .where("west", "<=", point.lng)
    .where("east", ">=", point.lng)
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

export async function airportExtras(ex: Executor, pickup: LatLng, dropoff: LatLng): Promise<{ pickupInAirportZone?: true; dropoffInAirportZone?: true }> {
  return {
    ...((await inAirportZone(ex, pickup)) ? { pickupInAirportZone: true as const } : {}),
    ...((await inAirportZone(ex, dropoff)) ? { dropoffInAirportZone: true as const } : {}),
  };
}
