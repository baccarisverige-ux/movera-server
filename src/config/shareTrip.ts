import { contract } from "../contract/contract.js";

/**
 * Contract v0.18.116 §94 (contract.json#shareTrip.setting; BQ-S10, owner S10 Q6 "On"): the zone's Share trip switch,
 * RiderAppConfig.shareTrip { on } in the zone's rider document (Admin Dispatch › Safety). Never saved = the document's
 * older features.shareTrip when that is true / false (a zone whose book-wide switch was off stays off), else
 * configDefaults.shareTripOn (true). A non-boolean `on` is refused by the document schema (400 invalid_document).
 */
export const DEFAULT_SHARE_TRIP_ON = (contract as unknown as { configDefaults: { shareTripOn: boolean } }).configDefaults.shareTripOn;

type Doc = Record<string, unknown>;
const isObject = (value: unknown): value is Doc => typeof value === "object" && value !== null && !Array.isArray(value);

/** The switch of a rider document (null / undefined: nothing published). */
export function shareTripOn(document: Doc | null | undefined): boolean {
  const own = isObject(document?.["shareTrip"]) ? (document["shareTrip"] as Doc)["on"] : undefined;
  if (typeof own === "boolean") return own;
  const older = isObject(document?.["features"]) ? (document["features"] as Doc)["shareTrip"] : undefined;
  return typeof older === "boolean" ? older : DEFAULT_SHARE_TRIP_ON;
}

/** GET /rider/config: always shareTrip { on }, and the same value as features.shareTrip (apps built before v0.18.116). */
export function withShareTrip(document: Doc): Doc {
  const on = shareTripOn(document);
  return { ...document, shareTrip: { on }, features: { ...(isObject(document["features"]) ? document["features"] : {}), shareTrip: on } };
}
