import { sql } from "kysely";
import type { Executor, Trx } from "../db/db.js";
import type { ConfigDoc } from "../db/schema.js";
import { schemaProblem } from "../contract/schemas.js";
import { ApiError, badRequest } from "../http/errors.js";
import { registerApprovalHandler } from "../admin/approvals.js";
import { audit } from "../admin/audit.js";
import { contract } from "../contract/contract.js";
import { pricingProblems } from "./pricingRules.js";

/**
 * Config documents (contract v0.5.1 §6, contract.json#configDocs and #configVersion). The admin panel builds each
 * document; the server keeps one draft and one live version per document and zone, checks every document against
 * the contract's schema, and on publish stamps the next live version and the publish time. The rider and driver
 * documents are served to the apps unchanged; pricing and dispatch are read by the server only.
 */

export const CONFIG_DOCS: readonly ConfigDoc[] = ["rider_app_config", "driver_app_config", "pricing", "dispatch", "country_rules"];
export const APP_DOCS: readonly ConfigDoc[] = ["rider_app_config", "driver_app_config"];
/** v0.8.0 (contract.json#configDocs.countryOnly): published per country only. */
export const COUNTRY_ONLY_DOCS: readonly ConfigDoc[] = ["country_rules"];

const SCHEMA: Record<ConfigDoc, string> = {
  rider_app_config: "RiderAppConfig",
  driver_app_config: "DriverAppConfig",
  pricing: "PricingDocument",
  dispatch: "DispatchDocument",
  country_rules: "CountryRules",
};

/**
 * x-permission-by-doc in openapi.yaml. v0.8.0 (contract.json#configDocs.publishApproval, owner 2026-10-27): config
 * publishes never wait for a second admin; whoever holds the publish permission publishes at once.
 */
export const EDIT_PERMISSION: Record<ConfigDoc, string> = { rider_app_config: "settings.edit", driver_app_config: "settings.edit", pricing: "settings.edit", dispatch: "dispatch.edit", country_rules: "settings.edit" };
export const PUBLISH_PERMISSION: Record<ConfigDoc, string> = { rider_app_config: "settings.publish", driver_app_config: "settings.publish", pricing: "settings.publish", dispatch: "dispatch.edit", country_rules: "settings.publish" };

/** The channel apps' config streams LISTEN on (config_published). */
export const CONFIG_CHANNEL = "movera_config_published";

export type Zone = { zoneId: string; name: string; country: string; currency: string; timeZone: string; kind: string; open: boolean; center: { lat: number; lng: number } };

/** v0.8.0 §6.4: the scope key of a country's documents (standard and country_rules). */
export const standardKey = (country: string) => `standard-${country}`;
const STANDARD_KEY = /^standard-([A-Z]{2})$/;
export const countryOfKey = (key: string): string | null => STANDARD_KEY.exec(key)?.[1] ?? null;

export async function getZone(ex: Executor, zoneId: string): Promise<Zone> {
  if (countryOfKey(zoneId) !== null) throw new ApiError("not_found", "No such zone.", { reason: "zone_not_found" });
  const row = await ex.selectFrom("zones").selectAll().where("zone_id", "=", zoneId).executeTakeFirst();
  if (row === undefined) throw new ApiError("not_found", "No such zone.", { reason: "zone_not_found" });
  return { zoneId: row.zone_id, name: row.name, country: row.country, currency: row.currency, timeZone: row.time_zone, kind: row.kind, open: row.open, center: { lat: row.center_lat, lng: row.center_lng } };
}

/**
 * A config scope: a zone, or (v0.8.0) a country's standard-<CC> key, which takes the currency and time zone of the
 * country's zones (the first by id). A country with no zone is 404 country_not_found.
 */
export async function getScope(ex: Executor, key: string): Promise<Zone> {
  const country = countryOfKey(key);
  if (country === null) return getZone(ex, key);
  const row = await ex.selectFrom("zones").selectAll().where("country", "=", country).orderBy("zone_id").executeTakeFirst();
  if (row === undefined) throw new ApiError("not_found", "No zone in this country.", { reason: "country_not_found" });
  return { zoneId: key, name: `Standard ${country}`, country, currency: row.currency, timeZone: row.time_zone, kind: "standard", open: true, center: { lat: row.center_lat, lng: row.center_lng } };
}

export type ConfigDraftView = { doc: ConfigDoc; zoneId?: string; country?: string; usesStandard?: boolean; version: number; liveVersion: number; document: unknown; updatedAt: string; updatedBy?: string };

/** A document must pass the contract schema and belong to the scope it is saved for. */
export function checkDocument(doc: ConfigDoc, zone: Zone, document: unknown): void {
  const country = countryOfKey(zone.zoneId);
  if (COUNTRY_ONLY_DOCS.includes(doc) && country === null) throw badRequest(`${doc} is set per country (?country=), not per zone.`, "country_only");
  const problem = schemaProblem(SCHEMA[doc], document);
  if (problem !== null) throw badRequest(`The ${doc} document is not valid: ${problem}.`, "invalid_document");
  const own = document as { zoneId?: string; currency?: string; country?: string; timeZone?: string };
  if (!COUNTRY_ONLY_DOCS.includes(doc) && own.zoneId !== zone.zoneId) throw badRequest(`The document is for zone ${own.zoneId}, not ${zone.zoneId}.`, "zone_mismatch");
  if (own.currency !== undefined && own.currency !== zone.currency) throw badRequest(`Zone ${zone.zoneId} uses ${zone.currency}.`, "currency_mismatch");
  if (own.country !== undefined && own.country !== zone.country) throw badRequest(`Zone ${zone.zoneId} is in ${zone.country}.`, "country_mismatch");
  if (doc === "pricing") {
    const problems = pricingProblems(document);
    if (problems.length > 0) throw badRequest(`The pricing document is not valid: ${problems.join("; ")}.`, "invalid_document");
  }
}

async function liveVersion(ex: Executor, doc: ConfigDoc, zoneId: string): Promise<number> {
  const row = await ex.selectFrom("config_live").select("version").where("doc", "=", doc).where("zone_id", "=", zoneId).executeTakeFirst();
  return row?.version ?? 0;
}

const scopeFields = (zoneId: string): { zoneId: string } | { country: string } => {
  const country = countryOfKey(zoneId);
  return country === null ? { zoneId } : { country };
};

/**
 * GET /admin/config/{doc}. A scope with no draft yet starts from its live document (draft version 1). v0.8.0: a
 * zone with neither starts from its country's standard (usesStandard: true, zoneId set to the zone); with nothing,
 * 404 config_not_found, and the first PUT is made with expectedVersion 1.
 */
export async function getDraft(db: Executor, doc: ConfigDoc, zoneId: string): Promise<ConfigDraftView> {
  const zone = await getScope(db, zoneId);
  if (COUNTRY_ONLY_DOCS.includes(doc) && zone.kind !== "standard") throw badRequest(`${doc} is set per country (?country=), not per zone.`, "country_only");
  const draft = await db.selectFrom("config_drafts").selectAll().where("doc", "=", doc).where("zone_id", "=", zoneId).executeTakeFirst();
  const live = await db.selectFrom("config_live").selectAll().where("doc", "=", doc).where("zone_id", "=", zoneId).executeTakeFirst();
  const standard = live === undefined && zone.kind !== "standard" ? await db.selectFrom("config_live").selectAll().where("doc", "=", doc).where("zone_id", "=", standardKey(zone.country)).executeTakeFirst() : undefined;
  const usesStandard = standard !== undefined ? { usesStandard: true } : zone.kind === "standard" || COUNTRY_ONLY_DOCS.includes(doc) ? {} : { usesStandard: false };
  if (draft !== undefined) {
    return { doc, ...scopeFields(zoneId), ...usesStandard, version: draft.version, liveVersion: live?.version ?? 0, document: draft.document, updatedAt: draft.updated_at.toISOString(), ...(draft.updated_by ? { updatedBy: draft.updated_by } : {}) };
  }
  if (live !== undefined) {
    return { doc, ...scopeFields(zoneId), ...usesStandard, version: 1, liveVersion: live.version, document: live.document, updatedAt: live.published_at.toISOString(), ...(live.published_by ? { updatedBy: live.published_by } : {}) };
  }
  if (standard !== undefined) {
    const document: Doc = { ...(standard.document as Doc), zoneId };
    delete document["usesStandard"];
    return { doc, zoneId, usesStandard: true, version: 1, liveVersion: 0, document, updatedAt: standard.published_at.toISOString(), ...(standard.published_by ? { updatedBy: standard.published_by } : {}) };
  }
  throw new ApiError("not_found", "This zone has no such document yet.", { reason: "config_not_found" });
}

async function lockDraftVersion(trx: Trx, doc: ConfigDoc, zoneId: string): Promise<{ version: number; document: unknown | null }> {
  // Serialises every change to one document of one zone, also the very first one (no row to lock yet).
  await sql`SELECT pg_advisory_xact_lock(hashtext(${`config:${doc}:${zoneId}`}))`.execute(trx);
  const draft = await trx.selectFrom("config_drafts").select(["version", "document"]).where("doc", "=", doc).where("zone_id", "=", zoneId).executeTakeFirst();
  if (draft !== undefined) return { version: draft.version, document: draft.document };
  const live = await trx.selectFrom("config_live").select("document").where("doc", "=", doc).where("zone_id", "=", zoneId).executeTakeFirst();
  return { version: 1, document: live?.document ?? null };
}

/** PUT /admin/config/{doc}: replace the draft, inside the caller's transaction. */
export async function putDraft(trx: Trx, input: { doc: ConfigDoc; zoneId: string; expectedVersion: number; document: unknown; adminId: string }, now: Date): Promise<ConfigDraftView> {
  const zone = await getScope(trx, input.zoneId);
  checkDocument(input.doc, zone, input.document);
  const current = await lockDraftVersion(trx, input.doc, input.zoneId);
  if (current.version !== input.expectedVersion) {
    const projection = await getDraft(trx, input.doc, input.zoneId).catch(() => undefined);
    throw new ApiError("version_mismatch", "The settings changed since you last saw them.", projection === undefined ? {} : { projection });
  }
  // v0.8.0 §6.5: tips, raise steps and driver bonus limits come from the country's rules while they are live.
  const rules = await liveCountryRules(trx, zone.country);
  const document = rules === null ? input.document : withCountryRules(input.doc, input.document as Doc, rules);
  const version = current.version + 1;
  const values = { doc: input.doc, zone_id: input.zoneId, version, document: JSON.stringify(document), updated_at: now, updated_by: input.adminId };
  await trx.insertInto("config_drafts").values(values).onConflict((c) => c.columns(["doc", "zone_id"]).doUpdateSet(values)).execute();
  await audit(trx, { adminId: input.adminId, action: "config.draft", targetType: "config", targetId: input.doc, zoneId: input.zoneId, detail: { version }, at: now });
  return getDraft(trx, input.doc, input.zoneId);
}

export type Publication = { doc: ConfigDoc; zoneId?: string; country?: string; version: number; publishedAt: string };

/** Zones of a country that have no own live document of this kind (they use the country standard). */
async function zonesUsingStandard(ex: Executor, doc: ConfigDoc, country: string): Promise<string[]> {
  const zones = await ex.selectFrom("zones").select("zone_id").where("country", "=", country).orderBy("zone_id").execute();
  const own = new Set((await ex.selectFrom("config_live").select("zone_id").where("doc", "=", doc).where("zone_id", "in", zones.length ? zones.map((z) => z.zone_id) : ["-"]).execute()).map((r) => r.zone_id));
  return zones.map((z) => z.zone_id).filter((id) => !own.has(id));
}

/** config_published for a scope: a standard's goes to every zone of its country that uses it (§6.4). */
async function notifyPublished(trx: Trx, doc: ConfigDoc, key: string, version: number, publishedAt: string): Promise<void> {
  const country = countryOfKey(key);
  const zones = country === null ? [key] : APP_DOCS.includes(doc) ? await zonesUsingStandard(trx, doc, country) : [];
  for (const zoneId of zones) await sql`SELECT pg_notify(${CONFIG_CHANNEL}, ${JSON.stringify({ doc, zoneId, version, publishedAt })})`.execute(trx);
}

/**
 * Makes the draft live: the server stamps the next version and publishedAt (v0.8.0, contract.json#configVersion;
 * a zone's first own document continues above its country standard's version), history row, and a
 * config_published notification sent on commit. v0.8.0: never waits for a second admin.
 */
export async function publishDraft(trx: Trx, input: { doc: ConfigDoc; zoneId: string; expectedVersion: number; note?: string | undefined; publishedBy: string; approvedBy: string | null }, now: Date): Promise<Publication> {
  const zone = await getScope(trx, input.zoneId);
  const current = await lockDraftVersion(trx, input.doc, input.zoneId);
  if (current.version !== input.expectedVersion) {
    throw new ApiError("version_mismatch", "The settings changed since this publish was asked for.", { reason: "draft_changed" });
  }
  if (current.document === null) throw new ApiError("not_found", "There is no draft to publish.", { reason: "config_not_found" });
  const standardVersion = zone.kind === "standard" ? 0 : await liveVersion(trx, input.doc, standardKey(zone.country));
  const version = Math.max(await liveVersion(trx, input.doc, input.zoneId), standardVersion) + 1;
  const publishedAt = now.toISOString();
  const document: Doc = { ...(current.document as Doc), version, publishedAt };
  delete document["usesStandard"];
  checkDocument(input.doc, zone, document);
  const json = JSON.stringify(document);
  const live = { doc: input.doc, zone_id: input.zoneId, version, document: json, published_at: now, published_by: input.publishedBy };
  await trx.insertInto("config_live").values(live).onConflict((c) => c.columns(["doc", "zone_id"]).doUpdateSet(live)).execute();
  await trx
    .insertInto("config_history")
    .values({ ...live, approved_by: input.approvedBy, note: input.note ?? null })
    .execute();
  // The published document becomes the draft too, so the panel continues from what is live.
  await trx.updateTable("config_drafts").set({ document: json, version: current.version + 1, updated_at: now, updated_by: input.publishedBy }).where("doc", "=", input.doc).where("zone_id", "=", input.zoneId).execute();
  await notifyPublished(trx, input.doc, input.zoneId, version, publishedAt);
  await audit(trx, { adminId: input.publishedBy, action: "config.publish", targetType: "config", targetId: input.doc, zoneId: input.zoneId, detail: { version, ...(input.note ? { note: input.note } : {}) }, at: now });
  const by = { publishedBy: input.publishedBy, approvedBy: input.approvedBy };
  if (input.doc === "pricing") {
    const pricing = document as unknown as PricingForApps;
    // A standard's pricing also keeps in step the own app documents of the zones that price with it.
    const keys = zone.kind === "standard" ? [input.zoneId, ...(await zonesUsingStandard(trx, "pricing", zone.country))] : [input.zoneId];
    await rewriteAppDocs(trx, keys, (doc, d) => appDocWithPricing(doc, d, pricing), { ...by, note: `pricing v${version}: waiting, no-show and pickup fee`, adoptStandard: zone.kind !== "standard" }, now);
  }
  if (input.doc === "country_rules") {
    const zones = (await trx.selectFrom("zones").select("zone_id").where("country", "=", zone.country).orderBy("zone_id").execute()).map((z) => z.zone_id);
    await rewriteAppDocs(trx, [input.zoneId, ...zones], (doc, d) => withCountryRules(doc, d, document as unknown as CountryRules), { ...by, note: `country rules v${version}: tips, raise steps, driver bonus` }, now);
  }
  return { doc: input.doc, ...scopeFields(input.zoneId), version, publishedAt };
}

type Waiting = { freeWaitMin: unknown; perMin: unknown; noShowAfterMin: unknown; noShowFee: unknown };
type PricingForApps = { categories?: Record<string, { waiting?: Waiting; riderPickupFee?: unknown }> };
type Doc = Record<string, unknown>;

const SEED_ORDER: readonly string[] = (contract as unknown as { categories: { seed: string[] } }).categories.seed;
const WAIT_KEYS = ["freeWaitMin", "perMin", "noShowAfterMin", "noShowFee"] as const;

/** The headline category (CONTRACT.md §6): economy, else the first in the contract's seed order, else by id. */
function headlineCategory(ids: string[]): string | undefined {
  const rank = (id: string) => (SEED_ORDER.indexOf(id) === -1 ? Infinity : SEED_ORDER.indexOf(id));
  return [...ids].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))[0];
}

const isObject = (value: unknown): value is Doc => value !== null && typeof value === "object" && !Array.isArray(value);
const waitingOf = (w: Waiting) => Object.fromEntries(WAIT_KEYS.map((k) => [k, w[k]]));

/**
 * contract.json#configDocs.mustMatch / publishPricing (v0.6.0): an app document with the waiting, no-show and rider
 * pickup fee of the pricing document; every other field as it was.
 */
export function appDocWithPricing(doc: ConfigDoc, appDocument: Doc, pricing: PricingForApps): Doc {
  const categories = pricing.categories ?? {};
  const next: Doc = structuredClone(appDocument);
  const waiting: Doc = isObject(next["waiting"]) ? next["waiting"] : {};
  const byCategory: Doc = isObject(waiting["byCategory"]) ? waiting["byCategory"] : {};
  for (const [id, category] of Object.entries(categories)) {
    if (category.waiting) byCategory[id] = { ...(isObject(byCategory[id]) ? byCategory[id] : {}), ...waitingOf(category.waiting) };
  }
  const head = headlineCategory(Object.keys(categories).filter((id) => categories[id]?.waiting !== undefined));
  next["waiting"] = { ...waiting, ...(head ? waitingOf(categories[head]!.waiting!) : {}), byCategory };
  if (doc === "rider_app_config") {
    const pickupFee: Doc = isObject(next["pickupFee"]) ? next["pickupFee"] : {};
    const fees: Doc = isObject(pickupFee["byCategory"]) ? pickupFee["byCategory"] : {};
    for (const [id, category] of Object.entries(categories)) if (category.riderPickupFee !== undefined) fees[id] = category.riderPickupFee;
    next["pickupFee"] = { ...pickupFee, byCategory: fees };
  } else if (isObject(next["pickupPay"]) && isObject(next["pickupPay"]["byCategory"])) {
    // A category the driver document has no pickup pay rate for keeps none.
    const rates = next["pickupPay"]["byCategory"];
    for (const [id, rate] of Object.entries(rates)) {
      const fee = categories[id]?.riderPickupFee;
      if (isObject(rate) && fee !== undefined) rates[id] = { ...rate, riderFee: fee };
    }
  }
  return next;
}

export type CountryRules = { tips?: unknown; raiseSteps?: unknown; driverBonus?: unknown };

/** v0.8.0 §6.5: an app document with the country's tips and raise steps (rider) or driver bonus limits (driver). */
export function withCountryRules(doc: ConfigDoc, appDocument: Doc, rules: CountryRules): Doc {
  if (doc === "rider_app_config") return { ...appDocument, tips: rules.tips, raiseSteps: rules.raiseSteps };
  if (doc === "driver_app_config") return { ...appDocument, driverBonus: rules.driverBonus };
  return appDocument;
}

async function liveCountryRules(ex: Executor, country: string): Promise<CountryRules | null> {
  const row = await ex.selectFrom("config_live").select("document").where("doc", "=", "country_rules").where("zone_id", "=", standardKey(country)).executeTakeFirst();
  return row === undefined ? null : (row.document as CountryRules);
}

/**
 * contract.json#configDocs.publishPricing (v0.6.0) and #configDocs.countryRules (v0.8.0): the live rider and
 * driver documents of the scopes are written again through `change`, as the next version with config_published;
 * a document already equal stays as it is; a scope with no app document gets none. A draft takes the same values
 * and its version goes up by 1, so a later app publish does not undo them.
 */
async function rewriteAppDocs(trx: Trx, keys: string[], change: (doc: ConfigDoc, document: Doc) => Doc, by: { publishedBy: string; approvedBy: string | null; note: string; adoptStandard?: boolean }, now: Date): Promise<void> {
  for (const key of keys) {
    const zone = await getScope(trx, key);
    for (const doc of APP_DOCS) {
      const draftRow = await lockDraftVersion(trx, doc, key);
      const own = await trx.selectFrom("config_live").select(["version", "document"]).where("doc", "=", doc).where("zone_id", "=", key).executeTakeFirst();
      // A zone's own pricing and the country's standard app document: the zone's apps must show the zone's prices,
      // so the zone takes the standard as its own document with the new values (it no longer uses the standard).
      const adopted = own === undefined && by.adoptStandard === true && zone.kind !== "standard" ? await liveDocument<Doc>(trx, doc, key) : null;
      const live = own ?? (adopted === null ? undefined : { version: adopted.version, document: adopted.document });
      if (live === undefined) continue;
      const current = live.document as Doc;
      const synced = change(doc, current);
      if (adopted !== null) delete synced["usesStandard"];
      if (adopted !== null || JSON.stringify(synced) !== JSON.stringify(current)) {
        const version = live.version + 1;
        const document = { ...synced, version, publishedAt: now.toISOString() };
        checkDocument(doc, zone, document);
        const json = JSON.stringify(document);
        const row = { doc, zone_id: key, version, document: json, published_at: now, published_by: by.publishedBy };
        await trx.insertInto("config_live").values(row).onConflict((c) => c.columns(["doc", "zone_id"]).doUpdateSet(row)).execute();
        await trx.insertInto("config_history").values({ ...row, approved_by: by.approvedBy, note: by.note }).execute();
        await notifyPublished(trx, doc, key, version, document.publishedAt);
      }
      const draft = await trx.selectFrom("config_drafts").select(["document"]).where("doc", "=", doc).where("zone_id", "=", key).executeTakeFirst();
      if (draft !== undefined && isObject(draft.document)) {
        const next = change(doc, draft.document);
        if (JSON.stringify(next) !== JSON.stringify(draft.document)) {
          await trx.updateTable("config_drafts").set({ document: JSON.stringify(next), version: draftRow.version + 1, updated_at: now, updated_by: by.publishedBy }).where("doc", "=", doc).where("zone_id", "=", key).execute();
        }
      }
    }
  }
}

export const PUBLISH_ACTION = "config.publish";

registerApprovalHandler(PUBLISH_ACTION, async (trx, payload, approvedBy, requestedBy, now) =>
  publishDraft(
    trx,
    {
      doc: payload["doc"] as ConfigDoc,
      zoneId: payload["zoneId"] as string,
      expectedVersion: payload["expectedVersion"] as number,
      note: payload["note"] as string | undefined,
      publishedBy: requestedBy,
      approvedBy,
    },
    now,
  ),
);

export type LiveDocument<T> = { version: number; document: T; usesStandard: boolean; scope: string };

/**
 * The live document of a zone, or null (the apps keep their own seed; the server treats pricing/dispatch as
 * required). v0.8.0 §6.4: a zone with no own document uses its country's standard, with the zone's id and
 * usesStandard: true; a zone with its own document never does.
 */
export async function liveDocument<T = Record<string, unknown>>(ex: Executor, doc: ConfigDoc, zoneId: string): Promise<LiveDocument<T> | null> {
  const row = await ex.selectFrom("config_live").select(["version", "document"]).where("doc", "=", doc).where("zone_id", "=", zoneId).executeTakeFirst();
  if (row !== undefined) return { version: row.version, document: row.document as T, usesStandard: false, scope: zoneId };
  if (countryOfKey(zoneId) !== null) return null;
  const zone = await ex.selectFrom("zones").select("country").where("zone_id", "=", zoneId).executeTakeFirst();
  if (zone === undefined) return null;
  const key = standardKey(zone.country);
  const standard = await ex.selectFrom("config_live").select(["version", "document"]).where("doc", "=", doc).where("zone_id", "=", key).executeTakeFirst();
  if (standard === undefined) return null;
  return { version: standard.version, document: { ...(standard.document as Doc), zoneId, usesStandard: true } as T, usesStandard: true, scope: key };
}
