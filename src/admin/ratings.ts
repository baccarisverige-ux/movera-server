import { sql } from "kysely";
import { applyPersonRules, ratingRules } from "./reviewRules.js";
import { adminCoversZone, type Principal } from "../auth/guard.js";
import { contract } from "../contract/contract.js";
import type { Executor, Trx } from "../db/db.js";
import { ApiError, badRequest, notFound } from "../http/errors.js";
import { audit } from "./audit.js";
import { cursorOf, readCursor, zonesOf } from "./lists.js";

/**
 * Ratings in Admin › Reviews (contract v0.9.0 §16): the list and hide / restore. A hidden rating does not count in the
 * person's average (drivers.rating_sum / riders.rating_sum) nor in the low-rating risk signal; restoring counts it
 * again (owner, 2026-10-27).
 */

const TAGS = (contract as unknown as { ratings: { tags: { aboutDriver: string[]; aboutRider: string[]; maxPerRating: number } } }).ratings.tags;

/** The tags a rater may give (contract.json#ratings.tags): a rider rates the driver, a driver the rider. */
export function allowedTags(rater: "rider" | "driver"): readonly string[] {
  return rater === "rider" ? TAGS.aboutDriver : TAGS.aboutRider;
}

/** Throws 400 when a tag is not on the rater's list, repeats, or there are too many. */
export function checkTags(rater: "rider" | "driver", tags: readonly string[]): void {
  const allowed = allowedTags(rater);
  const unknown = tags.filter((tag) => !allowed.includes(tag));
  if (unknown.length) throw badRequest(`Unknown rating tag ${unknown.join(", ")}.`, "invalid_body");
  if (new Set(tags).size !== tags.length) throw badRequest("A tag can be given once.", "invalid_body");
  if (tags.length > TAGS.maxPerRating) throw badRequest(`At most ${TAGS.maxPerRating} tags.`, "invalid_body");
}

type RatingRow = {
  trip_id: string;
  rater: "rider" | "driver";
  stars: number;
  tags: string[];
  comment: string | null;
  at: Date;
  hidden: boolean;
  hidden_by: string | null;
  hidden_at: Date | null;
  hide_reason: string | null;
  rider_id: string;
  driver_id: string | null;
  zone_id: string;
  rider_name: string | null;
  driver_first: string | null;
  driver_last: string | null;
};

function ratingView(r: RatingRow) {
  const driverName = [r.driver_first, r.driver_last].filter(Boolean).join(" ");
  return {
    tripId: r.trip_id,
    from: r.rater,
    stars: r.stars,
    tags: r.tags,
    ...(r.comment ? { comment: r.comment } : {}),
    at: r.at.toISOString(),
    riderId: r.rider_id,
    ...(r.rider_name ? { riderName: r.rider_name } : {}),
    ...(r.driver_id ? { driverId: r.driver_id } : {}),
    ...(driverName ? { driverName } : {}),
    zoneId: r.zone_id,
    hidden: r.hidden,
    ...(r.hidden_by ? { hiddenBy: r.hidden_by } : {}),
    ...(r.hidden_at ? { hiddenAt: r.hidden_at.toISOString() } : {}),
    ...(r.hide_reason ? { hideReason: r.hide_reason } : {}),
  };
}

function base(ex: Executor) {
  return ex
    .selectFrom("ratings")
    .innerJoin("trips", "trips.trip_id", "ratings.trip_id")
    .leftJoin("riders", "riders.rider_id", "trips.rider_id")
    .leftJoin("drivers", "drivers.driver_id", "trips.driver_id")
    .select([
      "ratings.trip_id", "ratings.rater", "ratings.stars", "ratings.tags", "ratings.comment", "ratings.at", "ratings.hidden", "ratings.hidden_by", "ratings.hidden_at", "ratings.hide_reason",
      "trips.rider_id", "trips.driver_id", "trips.zone_id", "riders.first_name as rider_name", "drivers.first_name as driver_first", "drivers.last_name as driver_last",
    ]);
}

export async function listRatings(ex: Executor, who: Principal, input: { cursor?: string; limit: number; from?: "rider" | "driver"; hidden?: boolean; maxStars?: number; driverId?: string; riderId?: string; zoneId?: string; since?: string; until?: string }) {
  let q = base(ex);
  const zones = zonesOf(who);
  if (zones) q = q.where("trips.zone_id", "in", zones.length ? zones : ["-"]);
  if (input.from) q = q.where("ratings.rater", "=", input.from);
  if (input.hidden !== undefined) q = q.where("ratings.hidden", "=", input.hidden);
  if (input.maxStars) q = q.where("ratings.stars", "<=", input.maxStars);
  if (input.driverId) q = q.where("trips.driver_id", "=", input.driverId);
  if (input.riderId) q = q.where("trips.rider_id", "=", input.riderId);
  if (input.zoneId) q = q.where("trips.zone_id", "=", input.zoneId);
  if (input.since) q = q.where("ratings.at", ">=", new Date(input.since));
  if (input.until) q = q.where("ratings.at", "<", new Date(input.until));
  if (input.cursor) {
    const c = readCursor(input.cursor);
    const [tripId, rater] = c.id.split("~");
    q = q.where(sql<boolean>`(ratings.at, ratings.trip_id, ratings.rater) < (${c.at}, ${tripId ?? ""}, ${rater ?? ""})`);
  }
  const rows = await q.orderBy("ratings.at", "desc").orderBy("ratings.trip_id", "desc").orderBy("ratings.rater", "desc").limit(input.limit + 1).execute();
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return { items: page.map((r) => ratingView(r as RatingRow)), nextCursor: rows.length > input.limit && last ? cursorOf(last.at, `${last.trip_id}~${last.rater}`) : null };
}

/** Hide (stop counting) or restore (count again) one rating, moving its stars out of or back into the average. */
export async function moderateRating(trx: Trx, who: Principal, tripId: string, rater: "rider" | "driver", hide: boolean, reason: string, now: Date) {
  const row = await base(trx).where("ratings.trip_id", "=", tripId).where("ratings.rater", "=", rater).forUpdate("ratings").executeTakeFirst();
  if (row === undefined) throw notFound("No such rating.", "rating_not_found");
  if (!adminCoversZone(who, row.zone_id)) throw new ApiError("forbidden", "This zone is outside your scope.", { reason: "zone_out_of_scope" });
  if (row.hidden === hide) throw new ApiError("invalid_transition", hide ? "This rating is already hidden." : "This rating is not hidden.", { reason: hide ? "already_hidden" : "not_hidden" });
  await trx
    .updateTable("ratings")
    .set(hide ? { hidden: true, hidden_by: who.subjectId, hidden_at: now, hide_reason: reason } : { hidden: false, hidden_by: null, hidden_at: null, hide_reason: null })
    .where("trip_id", "=", tripId)
    .where("rater", "=", rater)
    .execute();
  const sign = hide ? -1 : 1;
  // The rider rated the driver; the driver rated the rider (trips/ride.ts rateTrip).
  if (rater === "rider" && row.driver_id) {
    await trx.updateTable("drivers").set({ rating_sum: sql`rating_sum + ${sign * row.stars}`, rating_count: sql`rating_count + ${sign}` }).where("driver_id", "=", row.driver_id).execute();
  } else if (rater === "driver") {
    await trx.updateTable("riders").set({ rating_sum: sql`rating_sum + ${sign * row.stars}`, rating_count: sql`rating_count + ${sign}` }).where("rider_id", "=", row.rider_id).execute();
  }
  // v0.18.15 (contract.json#reviewRules): the person's new average is checked against the review lines.
  const { rules, country } = await ratingRules(trx, { zone_id: row.zone_id });
  if (rater === "rider" && row.driver_id) await applyPersonRules(trx, "driver", row.driver_id, country, rules, now);
  else if (rater === "driver") await applyPersonRules(trx, "rider", row.rider_id, country, rules, now);
  await audit(trx, { adminId: who.subjectId, action: hide ? "rating.hide" : "rating.restore", targetType: "rating", targetId: `${tripId}:${rater}`, zoneId: row.zone_id, detail: { reason }, at: now });
  const after = await base(trx).where("ratings.trip_id", "=", tripId).where("ratings.rater", "=", rater).executeTakeFirstOrThrow();
  return ratingView(after as RatingRow);
}
