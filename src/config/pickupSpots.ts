import { contract } from "../contract/contract.js";

/**
 * Contract v0.18.115 (BQ-V21, contract.json#pickupSpots; owner full-audit Q6 2026-11-02 "Keep as 'approximate'" =>
 * admin on/off per zone (default on), Rules decisions/rider-g4-pickup.md:7): RiderAppConfig.booking.pickupSpots.on,
 * the zone's switch for the rider's approximate pickup entrance chips. Stored in the zone's rider document as the
 * admin publishes it; served always, missing = on (a document published before v0.18.115).
 */
export const DEFAULT_PICKUP_SPOTS_ON: boolean = (contract as unknown as { configDefaults: { pickupSpotsOn?: boolean } }).configDefaults.pickupSpotsOn ?? true;

type Doc = Record<string, unknown>;
const isObject = (value: unknown): value is Doc => typeof value === "object" && value !== null && !Array.isArray(value);

/** Why a rider document's booking.pickupSpots is not valid (null = valid or absent). */
export function pickupSpotsProblem(document: unknown): string | null {
  const booking = isObject(document) ? document["booking"] : undefined;
  if (!isObject(booking) || !("pickupSpots" in booking)) return null;
  const spots = booking["pickupSpots"];
  if (!isObject(spots)) return "booking.pickupSpots must be an object { on }";
  if ("on" in spots && typeof spots["on"] !== "boolean") return "booking.pickupSpots.on must be true or false";
  return null;
}

/** The served rider document: booking.pickupSpots.on is always there (the stored value, else the default). */
export function withPickupSpots(document: Doc): Doc {
  const booking = isObject(document["booking"]) ? document["booking"] : {};
  const spots = isObject(booking["pickupSpots"]) ? booking["pickupSpots"] : {};
  const on = typeof spots["on"] === "boolean" ? spots["on"] : DEFAULT_PICKUP_SPOTS_ON;
  return { ...document, booking: { ...booking, pickupSpots: { ...spots, on } } };
}
