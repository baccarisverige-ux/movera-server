import { sql } from "kysely";
import type { Executor, Trx } from "../db/db.js";
import { contract } from "../contract/contract.js";
import { ApiError, notFound } from "../http/errors.js";
import { audit } from "../admin/audit.js";

/**
 * Contract v0.18.5 §30 (owner G1-B2 "Real texts from admin (Recommended)", contract.json#legal): the terms of use and the
 * privacy policy per country (SE, FR) in sv / fr / en. Version 0 is the contract's Movera-made drafts (a lawyer reviews
 * them before launch); the admin publishes new versions with the company details. The apps get the texts with the
 * placeholders filled; a paragraph whose placeholder has no value is left out, so nothing empty or made up shows.
 */

type Lang = "sv" | "fr" | "en";
export type LegalDocument = { title: Record<Lang, string>; text: Record<Lang, string> };
export type LegalCompany = Partial<Record<"companyName" | "orgNumber" | "address" | "supportEmail" | "supportPhone", string>>;
type LegalContract = { countries: string[]; placeholders: string[]; defaults: Record<string, { terms: LegalDocument; privacy: LegalDocument }> };
export const LEGAL = (contract as unknown as { legal: LegalContract }).legal;

export type LegalVersion = {
  country: string;
  version: number;
  source: "default" | "admin";
  publishedAt?: string;
  publishedBy?: string;
  reaccept: boolean;
  terms: LegalDocument;
  privacy: LegalDocument;
  company: LegalCompany;
};

export function knownCountry(country: string): string {
  if (!LEGAL.countries.includes(country)) throw notFound("No legal texts for this country.", "legal_country_unknown");
  return country;
}

type Row = { country: string; version: number; terms: unknown; privacy: unknown; company: unknown; reaccept: boolean; published_at: Date; published_by: string };

const fromRow = (r: Row): LegalVersion => ({
  country: r.country,
  version: r.version,
  source: "admin",
  publishedAt: r.published_at.toISOString(),
  publishedBy: r.published_by,
  reaccept: r.reaccept,
  terms: r.terms as LegalDocument,
  privacy: r.privacy as LegalDocument,
  company: (r.company ?? {}) as LegalCompany,
});

function draft(country: string): LegalVersion {
  const d = LEGAL.defaults[country]!;
  return { country, version: 0, source: "default", reaccept: false, terms: d.terms, privacy: d.privacy, company: {} };
}

/** The live version of a country: the newest published one, else the drafts (version 0). */
export async function liveLegal(ex: Executor, country: string): Promise<LegalVersion> {
  const row = await ex.selectFrom("legal_texts").selectAll().where("country", "=", knownCountry(country)).orderBy("version", "desc").executeTakeFirst();
  return row ? fromRow(row as unknown as Row) : draft(country);
}

export async function legalHistory(ex: Executor, country: string): Promise<LegalVersion[]> {
  const rows = await ex.selectFrom("legal_texts").selectAll().where("country", "=", knownCountry(country)).orderBy("version", "desc").limit(100).execute();
  return rows.map((r) => fromRow(r as unknown as Row));
}

/** Fills {placeholder}s from the company details; a paragraph with an empty placeholder is left out. */
export function fillText(text: string, company: LegalCompany): string {
  const values = company as Record<string, string | undefined>;
  return text
    .split(/\n{2,}/)
    .filter((paragraph) => [...paragraph.matchAll(/\{(\w+)\}/g)].every((m) => (values[m[1]!] ?? "").trim() !== ""))
    .map((paragraph) => paragraph.replace(/\{(\w+)\}/g, (_, k: string) => values[k]!.trim()))
    .join("\n\n");
}

const fillDoc = (doc: LegalDocument, company: LegalCompany): LegalDocument => ({
  title: doc.title,
  text: { sv: fillText(doc.text.sv, company), fr: fillText(doc.text.fr, company), en: fillText(doc.text.en, company) },
});

/** GET /legal/{country}: what the apps show (LegalTexts). */
export async function legalForApps(ex: Executor, country: string) {
  const live = await liveLegal(ex, country);
  return {
    country: live.country,
    version: live.version,
    source: live.source,
    ...(live.publishedAt ? { publishedAt: live.publishedAt } : {}),
    reaccept: live.reaccept,
    // Checker finding 6: the newest version published with reaccept; the app asks again until the person accepted it or a later one.
    reacceptFrom: await reacceptFrom(ex, country),
    terms: fillDoc(live.terms, live.company),
    privacy: fillDoc(live.privacy, live.company),
  };
}

/** POST /admin/legal/{country}/publish: the next version, audited. The apps read it on start and on return (contract). */
export async function publishLegal(trx: Trx, adminId: string, country: string, body: { terms: LegalDocument; privacy: LegalDocument; company?: LegalCompany | undefined; reaccept?: boolean | undefined }, now: Date): Promise<LegalVersion> {
  knownCountry(country);
  await sql`SELECT pg_advisory_xact_lock(hashtext(${`legal:${country}`}))`.execute(trx);
  const last = await trx.selectFrom("legal_texts").select("version").where("country", "=", country).orderBy("version", "desc").executeTakeFirst();
  const version = (last?.version ?? 0) + 1;
  const company = Object.fromEntries(Object.entries(body.company ?? {}).filter(([, v]) => typeof v === "string" && v.trim() !== "").map(([k, v]) => [k, v.trim()]));
  await trx
    .insertInto("legal_texts")
    .values({ country, version, terms: JSON.stringify(body.terms), privacy: JSON.stringify(body.privacy), company: JSON.stringify(company), reaccept: body.reaccept ?? false, published_at: now, published_by: adminId })
    .execute();
  await audit(trx, { adminId, action: "legal.publish", targetType: "config", targetId: `legal-${country}`, zoneId: null, detail: { country, version, reaccept: body.reaccept ?? false }, at: now });
  return liveLegal(trx, country);
}

/** POST /account/legal/accept { country, version }: only the live version. */
export async function acceptLegal(trx: Trx, actor: "rider" | "driver", subjectId: string, body: { country: string; version: number }, now: Date): Promise<void> {
  const live = await liveLegal(trx, body.country);
  if (live.version !== body.version) throw new ApiError("conflict", "These are not the current terms; open the app again.", { reason: "terms_version_not_current" });
  await trx.insertInto("legal_acceptances").values({ actor, subject_id: subjectId, country: body.country, version: body.version, accepted_at: now }).onConflict((c) => c.doNothing()).execute();
}

/** The countries of these zones whose live legal version asks for re-acceptance this person has not given. */
/** The newest version of a country's texts published with reaccept, or null (never asked again). */
export async function reacceptFrom(ex: Executor, country: string): Promise<number | null> {
  const row = await ex.selectFrom("legal_texts").select((eb) => eb.fn.max("version").as("v")).where("country", "=", country).where("reaccept", "=", true).executeTakeFirst();
  return row?.v === null || row?.v === undefined ? null : Number(row.v);
}

export async function unacceptedLegalCountries(ex: Executor, actor: "rider" | "driver", subjectId: string, zoneIds: readonly string[]): Promise<string[]> {
  if (zoneIds.length === 0) return [];
  const rows = await ex.selectFrom("zones").select("country").where("zone_id", "in", [...new Set(zoneIds)]).execute();
  const out: string[] = [];
  for (const country of new Set(rows.map((r) => r.country))) {
    if (!LEGAL.countries.includes(country)) continue;
    // Checker finding 6 (contract.json#legal.accept): the person must have accepted the newest version published with
    // reaccept, or any later one (accepting v3 also satisfies v2); a later publish without reaccept never unblocks.
    const required = await reacceptFrom(ex, country);
    if (required === null) continue;
    const done = await ex.selectFrom("legal_acceptances").select("version").where("actor", "=", actor).where("subject_id", "=", subjectId).where("country", "=", country).where("version", ">=", required).executeTakeFirst();
    if (!done) out.push(country);
  }
  return out;
}

/** An admin may edit a country's texts with a zone of that country in scope (a Super admin: all). */
export async function adminCoversCountry(ex: Executor, zones: readonly string[], country: string): Promise<boolean> {
  if (zones.includes("*")) return true;
  if (zones.length === 0) return false;
  const row = await ex.selectFrom("zones").select("zone_id").where("country", "=", country).where("zone_id", "in", [...zones]).executeTakeFirst();
  return row !== undefined;
}
