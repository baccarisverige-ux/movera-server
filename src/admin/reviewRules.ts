import { sql } from "kysely";
import { contract } from "../contract/contract.js";
import type { Principal } from "../auth/guard.js";
import type { Executor, Trx } from "../db/db.js";
import { ApiError, badRequest, notFound } from "../http/errors.js";
import { audit } from "./audit.js";
import { notify } from "../notifications/service.js";
import { scheduleTimer } from "../jobs/timers.js";
import { markSetOffline } from "../drivers/offlineReason.js";

/**
 * Review rules applied by the server (contract v0.18.15 §40, contract.json#reviewRules; owner 2026-11-02 G14 Q6
 * "Make them real"): bad words hide a comment at once; a person's average crossing the warning, review or block line
 * sends a warning, puts them on the admin review list, or (block on) suspends the account — once per crossing.
 */

type Line = { on: boolean; below: number };
export type ReviewRules = { country: string; warn: Line; review: Line; block: Line; minReviews: number; badWords: { on: boolean; words: string[] }; updatedAt?: string; updatedBy?: string };
type Lang = "sv" | "fr" | "en";
const RR = (contract as unknown as {
  reviewRules: { defaults: Omit<ReviewRules, "country">; warningTexts: { title: Record<Lang, string>; body: Record<Lang, string> } };
}).reviewRules;

export function defaultReviewRules(country: string): ReviewRules {
  return { country, ...structuredClone(RR.defaults) };
}

export async function reviewRulesOf(ex: Executor, country: string | null): Promise<ReviewRules> {
  const c = country ?? "SE";
  const row = await ex.selectFrom("review_rules").selectAll().where("country", "=", c).executeTakeFirst();
  if (!row) return defaultReviewRules(c);
  return { ...defaultReviewRules(c), ...(row.doc as object), country: c, updatedAt: row.updated_at.toISOString(), ...(row.updated_by ? { updatedBy: row.updated_by } : {}) };
}

export async function saveReviewRules(trx: Trx, who: Principal, body: ReviewRules, now: Date): Promise<ReviewRules> {
  if (!who.zones.includes("*")) {
    const hit = who.zones.length ? await trx.selectFrom("zones").select("zone_id").where("country", "=", body.country).where("zone_id", "in", who.zones).executeTakeFirst() : undefined;
    if (!hit) throw new ApiError("forbidden", "This country is outside your scope.", { reason: "zone_out_of_scope" });
  }
  const { warn, review, block } = body;
  if (warn.on && review.on && review.below > warn.below) throw badRequest("Review must be below the warning line.", "invalid_body");
  if (review.on && block.on && block.below > review.below) throw badRequest("Block must be below the review line.", "invalid_body");
  const doc = { warn, review, block, minReviews: body.minReviews, badWords: { on: body.badWords.on, words: [...new Set(body.badWords.words.map((w) => w.trim().toLowerCase()).filter(Boolean))] } };
  await trx
    .insertInto("review_rules")
    .values({ country: body.country, doc: JSON.stringify(doc), updated_at: now, updated_by: who.subjectId })
    .onConflict((oc) => oc.column("country").doUpdateSet({ doc: JSON.stringify(doc), updated_at: now, updated_by: who.subjectId }))
    .execute();
  await audit(trx, { adminId: who.subjectId, action: "reviews.rules", targetType: "review_rules", targetId: body.country, detail: doc, at: now });
  return reviewRulesOf(trx, body.country);
}

export function hasBadWord(text: string | null | undefined, rules: ReviewRules): boolean {
  if (!text || !rules.badWords.on) return false;
  const lower = text.toLowerCase();
  return rules.badWords.words.some((word) => word && lower.includes(word.toLowerCase()));
}

const SEVERITY = { warn: 1, review: 2, block: 3 } as const;

function levelOf(average: number, count: number, rules: ReviewRules): "warn" | "review" | "block" | null {
  if (count < rules.minReviews) return null;
  if (rules.block.on && average < rules.block.below) return "block";
  if (rules.review.on && average < rules.review.below) return "review";
  if (rules.warn.on && average < rules.warn.below) return "warn";
  return null;
}

/** After a rating: where the rated person stands now, and the one action for a newly crossed line. */
export async function applyPersonRules(trx: Trx, who: "driver" | "rider", personId: string, country: string | null, rules: ReviewRules, now: Date): Promise<void> {
  const person = who === "driver"
    ? await trx.selectFrom("drivers").select(["rating_sum", "rating_count", "language", "account_status", "online_status", "version", "zone_ids"]).where("driver_id", "=", personId).executeTakeFirst()
    : await trx.selectFrom("riders").select(["rating_sum", "rating_count", "language", "status", "version"]).where("rider_id", "=", personId).executeTakeFirst();
  if (!person) return;
  const count = Number(person.rating_count);
  const average = count > 0 ? Math.round((Number(person.rating_sum) / count) * 100) / 100 : 5;
  const level = levelOf(average, count, rules);
  const before = await trx.selectFrom("review_people").selectAll().where("who", "=", who).where("person_id", "=", personId).forUpdate().executeTakeFirst();
  if (level === null) {
    if (before) await trx.deleteFrom("review_people").where("who", "=", who).where("person_id", "=", personId).execute();
    return;
  }
  const worse = !before || SEVERITY[level] > SEVERITY[before.level];
  const queued = (before?.queued ?? false) || (worse && level !== "warn");
  await trx
    .insertInto("review_people")
    .values({ who, person_id: personId, country, level, average, count, since: before?.since ?? now, queued })
    .onConflict((oc) => oc.columns(["who", "person_id"]).doUpdateSet({ level, average, count, queued, ...(worse ? { since: now } : {}) }))
    .execute();
  if (!worse) return;
  if (level === "warn") {
    const lang: Lang = person.language === "sv" || person.language === "fr" ? person.language : "en";
    await notify(trx, { audience: who, subjectId: personId, kind: "review_warning", title: RR.warningTexts.title[lang], body: RR.warningTexts.body[lang].replace("{average}", average.toFixed(2).replace(".", lang === "en" ? "." : ",")), data: { average, count } }, now);
  }
  if (level === "block") {
    if (who === "driver" && "account_status" in person && person.account_status !== "suspended") {
      const offline = ["online", "going_online"].includes(person.online_status) ? { online_status: "offline" as const, online_since: null } : {};
      await trx.updateTable("drivers").set({ account_status: "suspended", ...offline, version: person.version + 1, updated_at: now }).where("driver_id", "=", personId).execute();
      await scheduleTimer(trx, { kind: "withdraw_driver_offers", refId: personId, dueAt: now, payload: {} });
      if ("online_status" in offline) await markSetOffline(trx, personId, "account_status", {}, now);
    } else if (who === "rider" && "status" in person && person.status !== "suspended") {
      await trx.updateTable("riders").set({ status: "suspended", version: person.version + 1, updated_at: now }).where("rider_id", "=", personId).execute();
    }
  }
  await audit(trx, { adminId: null, action: `reviews.${level}`, targetType: who, targetId: personId, detail: { average, count, country }, at: now });
}

/** Called by rateTrip before the stars are counted: true = the comment has a listed word, so the rating is hidden. */
export async function ratingRules(trx: Trx, trip: { zone_id: string | null }): Promise<{ rules: ReviewRules; country: string | null }> {
  const zone = trip.zone_id ? await trx.selectFrom("zones").select("country").where("zone_id", "=", trip.zone_id).executeTakeFirst() : undefined;
  const country = zone?.country ?? null;
  return { rules: await reviewRulesOf(trx, country), country };
}

export async function reviewQueue(ex: Executor, who: Principal) {
  let q = ex.selectFrom("review_people").selectAll().where("queued", "=", true);
  if (!who.zones.includes("*")) {
    const zones = who.zones.length ? await ex.selectFrom("zones").select("country").where("zone_id", "in", who.zones).execute() : [];
    const countries = [...new Set(zones.map((z) => z.country).filter((c): c is string => Boolean(c)))];
    q = q.where("country", "in", countries.length ? countries : ["-"]);
  }
  const rows = await q.orderBy("since", "desc").limit(500).execute();
  const driverIds = rows.filter((r) => r.who === "driver").map((r) => r.person_id);
  const riderIds = rows.filter((r) => r.who === "rider").map((r) => r.person_id);
  const drivers = driverIds.length ? await ex.selectFrom("drivers").select(["driver_id", sql<string>`trim(first_name || ' ' || last_name)`.as("name")]).where("driver_id", "in", driverIds).execute() : [];
  const riders = riderIds.length ? await ex.selectFrom("riders").select(["rider_id", "first_name as name"]).where("rider_id", "in", riderIds).execute() : [];
  const names = new Map<string, string>([...drivers.map((d) => [`driver:${d.driver_id}`, d.name] as const), ...riders.map((r) => [`rider:${r.rider_id}`, r.name ?? ""] as const)]);
  return {
    items: rows.map((r) => ({
      who: r.who, personId: r.person_id, ...(names.get(`${r.who}:${r.person_id}`) ? { name: names.get(`${r.who}:${r.person_id}`) } : {}), ...(r.country ? { country: r.country } : {}),
      level: r.level === "block" ? "block" : "review", average: Number(r.average), count: r.count, since: r.since.toISOString(),
    })),
  };
}

export async function reviewDone(trx: Trx, who: Principal, person: { who: "driver" | "rider"; personId: string }, note: string, now: Date) {
  const row = await trx.selectFrom("review_people").selectAll().where("who", "=", person.who).where("person_id", "=", person.personId).where("queued", "=", true).forUpdate().executeTakeFirst();
  if (!row) throw notFound("Not on the review list.", "not_in_review");
  await trx.updateTable("review_people").set({ queued: false }).where("who", "=", person.who).where("person_id", "=", person.personId).execute();
  await audit(trx, { adminId: who.subjectId, action: "reviews.done", targetType: person.who, targetId: person.personId, detail: { note, level: row.level }, at: now });
  return reviewQueue(trx, who);
}
