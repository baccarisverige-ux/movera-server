import { createHash } from "node:crypto";
import { sql } from "kysely";
import type { Principal } from "../auth/guard.js";
import { adminCoversZone } from "../auth/guard.js";
import { audit } from "../admin/audit.js";
import { cursorOf, readCursor, zonesOf } from "../admin/lists.js";
import { liveDocument } from "../config/service.js";
import { contract } from "../contract/contract.js";
import type { Executor, Trx } from "../db/db.js";
import { ApiError, badRequest, notFound } from "../http/errors.js";
import { newId } from "../ids.js";
import { DRIVER_ASSIGNED, type TripStatus } from "../rules/transitions.js";
import { driverPhotoUrl } from "../trips/driverPhoto.js";

/**
 * v0.18.147 (contract.json#driverProfile; owner 2026-11-20 "Now build all"): the driver's public profile the rider
 * opens from the waiting card, the compliment counts (kept on write, LOAD RULE), the short reviews an admin approves,
 * the driver's Min profil and the per-zone switches. Privacy: nothing about a rider leaves this file but the first
 * name he allowed on his own review, and the month.
 */
type DP = {
  compliments: { list: { code: string; emoji: string }[]; minStars: number };
  review: { maxLength: number; minStarsShown: number };
  languages: { max: number; codes: string[] };
};
const C = contract as unknown as { driverProfile: DP; configDefaults: { driverProfileOn: boolean; driverReviewsOn: boolean } };
export const DP_RULES = C.driverProfile;
export const COMPLIMENT_CODES = DP_RULES.compliments.list.map((c) => c.code);
const MIN_RATINGS_FOR_AVERAGE = 5;
const TOP_RATING = { average: 4.9, months: 6, min: 50 };
const AFTER_END_MS = 24 * 3600_000;
const MAX_OWN_REVIEWS = 50;

type Doc = Record<string, unknown>;
const isObject = (v: unknown): v is Doc => typeof v === "object" && v !== null && !Array.isArray(v);

/** The zone's switches from its rider document (missing = configDefaults). */
export function driverProfileSettings(document: Doc | null | undefined): { on: boolean; reviews: boolean } {
  const own = isObject(document?.["driverProfile"]) ? (document["driverProfile"] as Doc) : {};
  return {
    on: typeof own["on"] === "boolean" ? own["on"] : C.configDefaults.driverProfileOn,
    reviews: typeof own["reviews"] === "boolean" ? own["reviews"] : C.configDefaults.driverReviewsOn,
  };
}
export async function zoneDriverProfile(ex: Executor, zoneId: string): Promise<{ on: boolean; reviews: boolean }> {
  return driverProfileSettings((await liveDocument<Doc>(ex, "rider_app_config", zoneId))?.document);
}
/** GET /rider/config: always driverProfile { on, reviews }. */
export function withDriverProfile(document: Doc): Doc {
  return { ...document, driverProfile: driverProfileSettings(document) };
}

const monthOf = (at: Date, timeZone: string) => {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit" }).formatToParts(at);
  return `${parts.find((p) => p.type === "year")!.value}-${parts.find((p) => p.type === "month")!.value}`;
};
/** The first word of the profile name, at most 20 characters; null when empty. */
export const reviewFirstName = (name: string | null | undefined): string | null => {
  const first = (name ?? "").trim().split(/\s+/)[0] ?? "";
  return first ? [...first].slice(0, 20).join("") : null;
};

/* ---------------------------------------------------------------- the rating (called inside rateTrip's transaction) */

export async function recordRiderRating(
  trx: Trx,
  trip: { trip_id: string; driver_id: string | null; rider_id: string; zone_id: string },
  rating: { stars: number; tags: readonly string[]; review?: string | undefined; reviewName?: "first_name" | "anonymous" | undefined },
  hidden: boolean,
  now: Date,
): Promise<void> {
  if (!trip.driver_id || hidden || rating.stars < DP_RULES.compliments.minStars) return;
  const codes = rating.tags.filter((t) => COMPLIMENT_CODES.includes(t));
  for (const code of codes) {
    await trx
      .insertInto("driver_compliment_counts")
      .values({ driver_id: trip.driver_id, code, count: 1 })
      .onConflict((oc) => oc.columns(["driver_id", "code"]).doUpdateSet({ count: sql`driver_compliment_counts.count + 1` }))
      .execute();
  }
  const text = rating.review?.trim();
  if (!text || rating.stars < DP_RULES.review.minStarsShown) return;
  const zone = await trx.selectFrom("zones").select(["time_zone"]).where("zone_id", "=", trip.zone_id).executeTakeFirst();
  if (!(await zoneDriverProfile(trx, trip.zone_id)).reviews) return;
  let name: string | null = null;
  if (rating.reviewName !== "anonymous") {
    const r = await trx.selectFrom("riders").select(["first_name"]).where("rider_id", "=", trip.rider_id).executeTakeFirst();
    name = reviewFirstName(r?.first_name);
  }
  await trx
    .insertInto("driver_reviews")
    .values({ review_id: newId("rvw"), driver_id: trip.driver_id, trip_id: trip.trip_id, zone_id: trip.zone_id, stars: rating.stars, text: [...text].slice(0, DP_RULES.review.maxLength).join(""), name, month: monthOf(now, zone?.time_zone ?? "UTC"), created_at: now })
    .onConflict((oc) => oc.column("trip_id").doNothing())
    .execute();
}

/** An admin hid / restored a rider's rating: its compliments leave / come back. */
export async function moveCompliments(trx: Trx, driverId: string, stars: number, tags: readonly string[], sign: 1 | -1): Promise<void> {
  if (stars < DP_RULES.compliments.minStars) return;
  for (const code of tags.filter((t) => COMPLIMENT_CODES.includes(t))) {
    await trx.updateTable("driver_compliment_counts").set({ count: sql`greatest(0, count + ${sign})` }).where("driver_id", "=", driverId).where("code", "=", code).execute();
    if (sign === 1) await trx.insertInto("driver_compliment_counts").values({ driver_id: driverId, code, count: 1 }).onConflict((oc) => oc.columns(["driver_id", "code"]).doNothing()).execute();
  }
}

/* ---------------------------------------------------------------- the public profile */

async function settingsOf(ex: Executor, driverId: string) {
  const row = await ex.selectFrom("driver_public_profiles").selectAll().where("driver_id", "=", driverId).executeTakeFirst();
  return { languages: row?.languages ?? [], showCity: row?.show_city ?? true, showYears: row?.show_years ?? true };
}

async function complimentsOf(ex: Executor, driverId: string) {
  const rows = await ex.selectFrom("driver_compliment_counts").select(["code", "count"]).where("driver_id", "=", driverId).where("count", ">", 0).execute();
  const by = new Map(rows.map((r) => [r.code, Number(r.count)]));
  return COMPLIMENT_CODES.filter((c) => (by.get(c) ?? 0) > 0).map((code) => ({ code, count: by.get(code)! }));
}

export async function buildPublicProfile(ex: Executor, driverId: string, opts: { tripId: string | null; zoneId: string; reviewsOn: boolean; now: Date }) {
  const d = await ex.selectFrom("drivers").select(["driver_id", "first_name", "account_status", "rating_sum", "rating_count", "first_activated_at", "created_at"]).where("driver_id", "=", driverId).executeTakeFirstOrThrow();
  const zone = await ex.selectFrom("zones").select(["name", "time_zone"]).where("zone_id", "=", opts.zoneId).executeTakeFirst();
  const tz = zone?.time_zone ?? "UTC";
  const s = await settingsOf(ex, driverId);
  const photoUrl = opts.tripId ? ((await driverPhotoUrl(ex, driverId, opts.tripId, opts.now)) ?? null) : null;
  const hasPhoto = opts.tripId ? photoUrl !== null : (await driverPhotoUrl(ex, driverId, "-", opts.now)) !== undefined;
  const trips = await ex.selectFrom("trips").select((eb) => eb.fn.countAll<string>().as("n")).where("driver_id", "=", driverId).where("status", "=", "completed").executeTakeFirst();
  const tripCount = Number(trips?.n ?? 0);
  const ratingCount = Number(d.rating_count);
  const rating = ratingCount >= MIN_RATINGS_FOR_AVERAGE ? Math.round((Number(d.rating_sum) / ratingCount) * 10) / 10 : null;
  const since = d.first_activated_at ?? d.created_at;
  const years = Math.max(0, Math.floor((opts.now.getTime() - since.getTime()) / (365.25 * 86400_000)));
  const milestones: { code: string; reachedAt: string }[] = [];
  if (tripCount >= 1000) {
    const t = await ex.selectFrom("trips").select(["ended_at"]).where("driver_id", "=", driverId).where("status", "=", "completed").orderBy("ended_at", "asc").offset(999).limit(1).executeTakeFirst();
    milestones.push({ code: "trips_1000", reachedAt: monthOf(t?.ended_at ?? opts.now, tz) });
  }
  const recent = await ex
    .selectFrom("ratings").innerJoin("trips", "trips.trip_id", "ratings.trip_id")
    .select((eb) => [eb.fn.countAll<string>().as("n"), eb.fn.avg<string>("ratings.stars").as("avg")])
    .where("trips.driver_id", "=", driverId).where("ratings.rater", "=", "rider").where("ratings.hidden", "=", false)
    .where("ratings.at", ">=", new Date(opts.now.getTime() - TOP_RATING.months * 30.44 * 86400_000))
    .executeTakeFirst();
  if (Number(recent?.n ?? 0) >= TOP_RATING.min && Number(recent?.avg ?? 0) >= TOP_RATING.average) milestones.push({ code: "top_rating", reachedAt: monthOf(opts.now, tz) });
  let latestReview: { text: string; name: string | null; month: string } | null = null;
  if (opts.reviewsOn) {
    const r = await ex.selectFrom("driver_reviews").select(["text", "name", "month"]).where("driver_id", "=", driverId).where("status", "=", "approved").orderBy("month", "desc").orderBy("moderated_at", "desc").limit(1).executeTakeFirst();
    latestReview = r ? { text: r.text, name: r.name, month: r.month } : null;
  }
  return {
    driverId: d.driver_id,
    firstName: d.first_name || "Driver",
    verified: d.account_status === "active" && hasPhoto,
    photoUrl,
    languages: s.languages,
    city: s.showCity ? (zone?.name ?? null) : null,
    sinceMonth: s.showYears ? monthOf(since, tz) : null,
    years: s.showYears ? years : null,
    tripCount,
    rating,
    compliments: await complimentsOf(ex, driverId),
    milestones,
    latestReview,
  };
}

/** GET /rider/trips/{tripId}/driver-profile: the trip's own rider, from accept until 24 h after the end. */
export async function riderDriverProfile(ex: Executor, riderId: string, tripId: string, now: Date) {
  const trip = await ex.selectFrom("trips").select(["rider_id", "driver_id", "status", "zone_id", "ended_at"]).where("trip_id", "=", tripId).executeTakeFirst();
  const missing = () => notFound("No driver profile for this trip.");
  if (trip === undefined || trip.rider_id !== riderId || trip.driver_id === null) throw missing();
  const live = DRIVER_ASSIGNED.has(trip.status as TripStatus);
  const recentEnd = trip.status === "completed" && trip.ended_at !== null && now.getTime() - trip.ended_at.getTime() <= AFTER_END_MS;
  if (!live && !recentEnd) throw missing();
  const zone = await zoneDriverProfile(ex, trip.zone_id);
  if (!zone.on) throw notFound("The driver profile is off in this zone.", "driver_profile_off");
  return buildPublicProfile(ex, trip.driver_id, { tripId, zoneId: trip.zone_id, reviewsOn: zone.reviews, now });
}

export const etagOf = (body: unknown) => `"${createHash("sha256").update(JSON.stringify(body)).digest("base64url").slice(0, 27)}"`;

/* ---------------------------------------------------------------- Min profil */

export async function ownPublicProfile(ex: Executor, driverId: string, now: Date) {
  const d = await ex.selectFrom("drivers").select(["zone_ids"]).where("driver_id", "=", driverId).executeTakeFirstOrThrow();
  const zoneId = d.zone_ids[0] ?? "";
  const zone = zoneId ? await zoneDriverProfile(ex, zoneId) : { on: C.configDefaults.driverProfileOn, reviews: C.configDefaults.driverReviewsOn };
  const s = await settingsOf(ex, driverId);
  const preview = await buildPublicProfile(ex, driverId, { tripId: null, zoneId, reviewsOn: zone.reviews, now });
  const reviews = await ex.selectFrom("driver_reviews").select(["review_id", "text", "name", "month", "stars", "status"]).where("driver_id", "=", driverId).orderBy("created_at", "desc").limit(MAX_OWN_REVIEWS).execute();
  return {
    languages: s.languages, showCity: s.showCity, showYears: s.showYears, profileOn: zone.on, reviewsOn: zone.reviews,
    preview, compliments: preview.compliments,
    reviews: reviews.map((r) => ({ reviewId: r.review_id, text: r.text, name: r.name, month: r.month, stars: r.stars, status: r.status })),
  };
}

export async function updateOwnPublicProfile(trx: Trx, driverId: string, body: { languages?: string[]; showCity?: boolean; showYears?: boolean }, now: Date) {
  if (body.languages !== undefined) {
    const bad = body.languages.some((l) => !DP_RULES.languages.codes.includes(l)) || new Set(body.languages).size !== body.languages.length || body.languages.length > DP_RULES.languages.max;
    if (bad) throw badRequest(`Pick up to ${DP_RULES.languages.max} languages from the list.`, "invalid_language");
  }
  const cur = await settingsOf(trx, driverId);
  const next = { languages: body.languages ?? cur.languages, show_city: body.showCity ?? cur.showCity, show_years: body.showYears ?? cur.showYears, updated_at: now };
  await trx.insertInto("driver_public_profiles").values({ driver_id: driverId, ...next }).onConflict((oc) => oc.column("driver_id").doUpdateSet(next)).execute();
  return ownPublicProfile(trx, driverId, now);
}

/* ---------------------------------------------------------------- admin moderation */

type ReviewRow = { review_id: string; driver_id: string; first_name: string; zone_id: string; stars: number; text: string; name: string | null; month: string; status: string; created_at: Date };
const adminView = (r: ReviewRow) => ({ reviewId: r.review_id, driverId: r.driver_id, driverFirstName: r.first_name, zoneId: r.zone_id, text: r.text, name: r.name, month: r.month, stars: r.stars, status: r.status, createdAt: r.created_at.toISOString() });
const reviewBase = (ex: Executor) =>
  ex.selectFrom("driver_reviews").innerJoin("drivers", "drivers.driver_id", "driver_reviews.driver_id")
    .select(["driver_reviews.review_id", "driver_reviews.driver_id", "drivers.first_name", "driver_reviews.zone_id", "driver_reviews.stars", "driver_reviews.text", "driver_reviews.name", "driver_reviews.month", "driver_reviews.status", "driver_reviews.created_at"]);

export async function listDriverReviews(ex: Executor, who: Principal, input: { status?: "pending" | "approved" | "hidden"; zoneId?: string; cursor?: string; limit: number }) {
  let q = reviewBase(ex);
  const zones = zonesOf(who);
  if (zones) q = q.where("driver_reviews.zone_id", "in", zones.length ? zones : ["-"]);
  if (input.status) q = q.where("driver_reviews.status", "=", input.status);
  if (input.zoneId) q = q.where("driver_reviews.zone_id", "=", input.zoneId);
  if (input.cursor) {
    const c = readCursor(input.cursor);
    q = q.where(sql<boolean>`(driver_reviews.created_at, driver_reviews.review_id) > (${c.at}, ${c.id})`);
  }
  const rows = await q.orderBy("driver_reviews.created_at", "asc").orderBy("driver_reviews.review_id", "asc").limit(input.limit + 1).execute();
  const page = rows.slice(0, input.limit) as ReviewRow[];
  const last = page[page.length - 1];
  return { items: page.map(adminView), nextCursor: rows.length > input.limit && last ? cursorOf(last.created_at, last.review_id) : null };
}

export async function moderateDriverReview(trx: Trx, who: Principal, reviewId: string, approve: boolean, now: Date) {
  const row = await trx.selectFrom("driver_reviews").select(["zone_id", "status"]).where("review_id", "=", reviewId).forUpdate().executeTakeFirst();
  if (row === undefined) throw notFound("No such review.", "review_not_found");
  if (!adminCoversZone(who, row.zone_id)) throw new ApiError("forbidden", "This zone is outside your scope.", { reason: "zone_out_of_scope" });
  await trx.updateTable("driver_reviews").set({ status: approve ? "approved" : "hidden", moderated_at: now, moderated_by: who.subjectId }).where("review_id", "=", reviewId).execute();
  await audit(trx, { adminId: who.subjectId, action: approve ? "driver_review.approve" : "driver_review.hide", targetType: "driver_review", targetId: reviewId, zoneId: row.zone_id, detail: {}, at: now });
  return adminView((await reviewBase(trx).where("driver_reviews.review_id", "=", reviewId).executeTakeFirstOrThrow()) as ReviewRow);
}
