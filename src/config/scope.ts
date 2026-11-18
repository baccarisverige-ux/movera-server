import { adminCoversZone, type Principal } from "../auth/guard.js";
import type { Db } from "../db/db.js";
import type { ConfigDoc } from "../db/schema.js";
import { ApiError } from "../http/errors.js";
import { COUNTRY_ONLY_DOCS, standardKey } from "./service.js";

/**
 * The scope key of an admin config request (contract.json#configDocs.scope): the zone id, or standard-<CC> for a
 * country; exactly one of the two is named, and the admin must cover the zone, or one zone of the country (owner
 * 2026-10-27). One rule for GET, PUT, publish, History and Restore (live 2026-11-16: History and Restore took a
 * zone only, so a country's Tips & limits could not be read back or undone).
 */
export async function scopeKey(db: Db, who: Principal, scope: { zoneId?: string | undefined; country?: string | undefined }, doc?: ConfigDoc): Promise<string> {
  if ((scope.zoneId === undefined) === (scope.country === undefined)) throw new ApiError("invalid_request", "Name exactly one of zoneId or country.", { reason: "scope_required" });
  // v0.18.0 (contract.json#configDocs.countryOnly): the onboarding settings exist per country only.
  if (doc !== undefined && COUNTRY_ONLY_DOCS.includes(doc) && scope.zoneId !== undefined) throw new ApiError("invalid_request", "These settings are per country; name the country.", { reason: "scope_country_only" });
  if (scope.zoneId !== undefined) {
    if (!adminCoversZone(who, scope.zoneId)) throw new ApiError("forbidden", "This zone is outside your scope.", { reason: "zone_out_of_scope" });
    return scope.zoneId;
  }
  const zones = await db.selectFrom("zones").select("zone_id").where("country", "=", scope.country!).execute();
  if (zones.length > 0 && !zones.some((zone) => adminCoversZone(who, zone.zone_id))) throw new ApiError("forbidden", "This country is outside your scope.", { reason: "zone_out_of_scope" });
  return standardKey(scope.country!);
}
