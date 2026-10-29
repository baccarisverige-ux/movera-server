import { z } from "zod";
import { adminCoversZone, type Principal } from "../auth/guard.js";
import type { Executor } from "../db/db.js";
import { ApiError, badRequest } from "../http/errors.js";

/**
 * contract v0.16.2 (owner 2026-10-29, "Fix fully"): the zone filters of the admin lists. `zoneId` (one zone),
 * `zoneIds` (several, comma separated or repeated) and `country` (every zone of that country) narrow a list to
 * those zones, always inside the admin's own zones. A named zone outside them is 403 zone_out_of_scope; a
 * country's zones the admin does not cover are left out. A query key the list does not know is 400 unknown_filter.
 */

const ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const zoneList = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) => (v === undefined ? undefined : (Array.isArray(v) ? v : [v]).flatMap((part) => part.split(",")).map((part) => part.trim()).filter(Boolean)))
  .pipe(z.array(ID).max(200).optional());

export const ZoneFilterQuery = { zoneId: ID.optional(), zoneIds: zoneList, country: z.string().regex(/^[A-Z]{2}$/).optional() };

export type ZoneFilter = { zoneId?: string | undefined; zoneIds?: string[] | undefined; country?: string | undefined };

/** Parse a list's query strictly: an unknown key is 400 invalid_request (reason unknown_filter). */
export function parseQuery<T extends z.ZodRawShape>(shape: T, query: unknown): z.infer<z.ZodObject<T>> {
  const parsed = z.object(shape).strict().safeParse(query ?? {});
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0]!;
  if (issue.code === "unrecognized_keys") throw badRequest(`Unknown filter: ${issue.keys.join(", ")}.`, "unknown_filter");
  const where = issue.path.length ? issue.path.join(".") : "query";
  throw badRequest(`${where}: ${issue.message}`, "invalid_body");
}

/** The admin, narrowed to the zones the filter names (unchanged when the query names none). */
export async function narrowToZones(ex: Executor, who: Principal, filter: ZoneFilter): Promise<Principal> {
  const named = [...new Set([...(filter.zoneId ? [filter.zoneId] : []), ...(filter.zoneIds ?? [])])];
  if (!named.length && !filter.country) return who;
  const outside = named.filter((zone) => !adminCoversZone(who, zone));
  if (outside.length) throw new ApiError("forbidden", "This zone is outside your scope.", { reason: "zone_out_of_scope" });
  let zones = named;
  if (filter.country) {
    const rows = await ex.selectFrom("zones").select("zone_id").where("country", "=", filter.country).execute();
    const ofCountry = new Set(rows.map((row) => row.zone_id));
    zones = named.length ? named.filter((zone) => ofCountry.has(zone)) : [...ofCountry].filter((zone) => adminCoversZone(who, zone));
  }
  return { ...who, zones };
}

/** The query without the zone filter keys (the list reads the zones from the narrowed admin). */
export function withoutZoneFilter<T extends ZoneFilter>(query: T): Omit<T, "zoneId" | "zoneIds" | "country"> {
  const { zoneId: _zoneId, zoneIds: _zoneIds, country: _country, ...rest } = query;
  return rest;
}
