import { sql } from "kysely";
import type { Executor, Trx } from "../db/db.js";
import type { ConfigDoc } from "../db/schema.js";
import { schemaProblem } from "../contract/schemas.js";
import { ApiError, badRequest } from "../http/errors.js";
import { registerApprovalHandler } from "../admin/approvals.js";
import { audit } from "../admin/audit.js";
import { contract } from "../contract/contract.js";
import { pricingProblems } from "./pricingRules.js";
import { randomBytes } from "node:crypto";
import { defaultSettings, prepareSettings, settingsProblems, type OnboardingSettings } from "../drivers/onboardingSettings.js";
import { DEFAULT_RAISE_MAX_FACTOR, raiseMaxFactor, validFactor, withRaiseLimit } from "./raiseLimit.js";

/**
 * Config documents (contract v0.5.1 §6, contract.json#configDocs and #configVersion). The admin panel builds each
 * document; the server keeps one draft and one live version per document and zone, checks every document against
 * the contract's schema, and on publish stamps the next live version and the publish time. The rider and driver
 * documents are served to the apps unchanged; pricing and dispatch are read by the server only.
 */

export const CONFIG_DOCS: readonly ConfigDoc[] = ["rider_app_config", "driver_app_config", "pricing", "dispatch", "country_rules", "onboarding"];
export const APP_DOCS: readonly ConfigDoc[] = ["rider_app_config", "driver_app_config"];
/**
 * v0.8.1 (contract.json#configDocs.rules, owner 2026-10-28): tips and limits. Published per zone or as the country's
 * standard like the others (no longer per country only); the document names its country, not a zone.
 */
export const RULES_DOCS: readonly ConfigDoc[] = ["country_rules"];
/**
 * v0.18.0 (contract.json#configDocs.countryOnly, §27): the onboarding settings are published per country only; the
 * document names its country, not a zone.
 */
export const COUNTRY_ONLY_DOCS: readonly ConfigDoc[] = ["onboarding"];

const SCHEMA: Record<ConfigDoc, string> = {
  rider_app_config: "RiderAppConfig",
  driver_app_config: "DriverAppConfig",
  pricing: "PricingDocument",
  dispatch: "DispatchDocument",
  country_rules: "CountryRules",
  onboarding: "OnboardingSettings",
};

/**
 * x-permission-by-doc in openapi.yaml. v0.8.0 (contract.json#configDocs.publishApproval, owner 2026-10-27): config
 * publishes never wait for a second admin; whoever holds the publish permission publishes at once.
 */
export const EDIT_PERMISSION: Record<ConfigDoc, string> = { rider_app_config: "settings.edit", driver_app_config: "settings.edit", pricing: "settings.edit", dispatch: "dispatch.edit", country_rules: "settings.edit", onboarding: "settings.edit" };
export const PUBLISH_PERMISSION: Record<ConfigDoc, string> = { rider_app_config: "settings.publish", driver_app_config: "settings.publish", pricing: "settings.publish", dispatch: "dispatch.edit", country_rules: "settings.publish", onboarding: "settings.publish" };

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
  const problem = schemaProblem(SCHEMA[doc], document);
  if (problem !== null) throw badRequest(`The ${doc} document is not valid: ${problem}.`, "invalid_document");
  const own = document as { zoneId?: string; currency?: string; country?: string; timeZone?: string };
  if (!RULES_DOCS.includes(doc) && !COUNTRY_ONLY_DOCS.includes(doc) && own.zoneId !== zone.zoneId) throw badRequest(`The document is for zone ${own.zoneId}, not ${zone.zoneId}.`, "zone_mismatch");
  if (own.currency !== undefined && own.currency !== zone.currency) throw badRequest(`Zone ${zone.zoneId} uses ${zone.currency}.`, "currency_mismatch");
  if (own.country !== undefined && own.country !== zone.country) throw badRequest(`Zone ${zone.zoneId} is in ${zone.country}.`, "country_mismatch");
  if (doc === "onboarding") {
    const problems = settingsProblems(document);
    if (problems.length > 0) throw badRequest(`The onboarding settings are not valid: ${problems.join("; ")}.`, "invalid_document");
  }
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
  const draft = await db.selectFrom("config_drafts").selectAll().where("doc", "=", doc).where("zone_id", "=", zoneId).executeTakeFirst();
  const live = await db.selectFrom("config_live").selectAll().where("doc", "=", doc).where("zone_id", "=", zoneId).executeTakeFirst();
  const standard = live === undefined && zone.kind !== "standard" ? await db.selectFrom("config_live").selectAll().where("doc", "=", doc).where("zone_id", "=", standardKey(zone.country)).executeTakeFirst() : undefined;
  const usesStandard = standard !== undefined ? { usesStandard: true } : zone.kind === "standard" ? {} : { usesStandard: false };
  if (draft !== undefined) {
    return { doc, ...scopeFields(zoneId), ...usesStandard, version: draft.version, liveVersion: live?.version ?? 0, document: draft.document, updatedAt: draft.updated_at.toISOString(), ...(draft.updated_by ? { updatedBy: draft.updated_by } : {}) };
  }
  if (live !== undefined) {
    return { doc, ...scopeFields(zoneId), ...usesStandard, version: 1, liveVersion: live.version, document: live.document, updatedAt: live.published_at.toISOString(), ...(live.published_by ? { updatedBy: live.published_by } : {}) };
  }
  if (standard !== undefined) {
    const document: Doc = RULES_DOCS.includes(doc) ? { ...(standard.document as Doc) } : { ...(standard.document as Doc), zoneId };
    delete document["usesStandard"];
    return { doc, zoneId, usesStandard: true, version: 1, liveVersion: 0, document, updatedAt: standard.published_at.toISOString(), ...(standard.published_by ? { updatedBy: standard.published_by } : {}) };
  }
  // v0.18.0 (§27): a country with no onboarding settings yet starts from the contract defaults (the admin's own).
  if (COUNTRY_ONLY_DOCS.includes(doc) && zone.kind === "standard") {
    return { doc, country: zone.country, version: 1, liveVersion: 0, document: defaultSettings(zone.country), updatedAt: new Date(0).toISOString() };
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
  if (input.doc === "onboarding" && schemaProblem(SCHEMA.onboarding, input.document) === null) {
    // v0.18.0 (owner item 14): new document types get their server id; draft:<key> in the lists becomes it.
    const before = await lockDraftVersion(trx, input.doc, input.zoneId);
    const live = await trx.selectFrom("config_live").select("document").where("doc", "=", "onboarding").where("zone_id", "=", input.zoneId).executeTakeFirst();
    const known = new Set([before.document, live?.document].flatMap((d) => ((d as OnboardingSettings | null)?.customTypes ?? []).map((c) => c.id!)));
    try {
      input = { ...input, document: prepareSettings(input.document as OnboardingSettings, known, () => randomBytes(5).toString("hex")) };
    } catch (error) {
      throw badRequest(`The onboarding settings are not valid: ${(error as Error).message}.`, "invalid_document");
    }
  }
  checkDocument(input.doc, zone, input.document);
  const current = await lockDraftVersion(trx, input.doc, input.zoneId);
  if (current.version !== input.expectedVersion) {
    const projection = await getDraft(trx, input.doc, input.zoneId).catch(() => undefined);
    throw new ApiError("version_mismatch", "The settings changed since you last saw them.", projection === undefined ? {} : { projection });
  }
  // v0.8.1 §6.5: tips, raise steps and driver bonus limits come from the scope's rules (its own, else the standard).
  const rules = await liveRules(trx, input.zoneId);
  let document = rules === null ? input.document : withCountryRules(input.doc, input.document as Doc, rules);
  // v0.18.6 (G4-E4, configDocs.mustMatch): a rider document carries its zone's raise limit from the dispatch document.
  if (input.doc === "rider_app_config" && isObject(document)) document = withRaiseLimit(document, await raiseMaxFactor(trx, input.zoneId));
  const version = current.version + 1;
  const values = { doc: input.doc, zone_id: input.zoneId, version, document: JSON.stringify(document), updated_at: now, updated_by: input.adminId };
  await trx.insertInto("config_drafts").values(values).onConflict((c) => c.columns(["doc", "zone_id"]).doUpdateSet(values)).execute();
  await audit(trx, { adminId: input.adminId, action: "config.draft", targetType: "config", targetId: input.doc, zoneId: input.zoneId, detail: { version }, at: now });
  return getDraft(trx, input.doc, input.zoneId);
}

export type Publication = {
  doc: ConfigDoc;
  zoneId?: string;
  country?: string;
  version: number;
  publishedAt: string;
  /** v0.7.1: the app documents a pricing publish rewrote (for the one audit line, contract.json#pricingHistory). */
  appDocuments?: Array<{ doc: ConfigDoc; version: number }>;
  restoredFrom?: number;
};

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
export async function publishDraft(trx: Trx, input: { doc: ConfigDoc; zoneId: string; expectedVersion: number; note?: string | undefined; publishedBy: string; approvedBy: string | null; restoredFrom?: number }, now: Date): Promise<Publication> {
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
    .values({ ...live, approved_by: input.approvedBy, note: input.note ?? null, ...(input.restoredFrom ? { action: "restore" as const, restored_from: input.restoredFrom } : {}) })
    .execute();
  // The published document becomes the draft too, so the panel continues from what is live.
  await trx.updateTable("config_drafts").set({ document: json, version: current.version + 1, updated_at: now, updated_by: input.publishedBy }).where("doc", "=", input.doc).where("zone_id", "=", input.zoneId).execute();
  await notifyPublished(trx, input.doc, input.zoneId, version, publishedAt);
  const by = { publishedBy: input.publishedBy, approvedBy: input.approvedBy };
  const appDocuments: Array<{ doc: ConfigDoc; version: number }> = [];
  if (input.doc === "pricing") {
    const pricing = document as unknown as PricingForApps;
    // A standard's pricing also keeps in step the own app documents of the zones that price with it.
    const keys = zone.kind === "standard" ? [input.zoneId, ...(await zonesUsingStandard(trx, "pricing", zone.country))] : [input.zoneId];
    appDocuments.push(...(await rewriteAppDocs(trx, keys, (doc, d) => appDocWithPricing(doc, d, pricing), { ...by, note: `pricing v${version}: waiting, no-show and pickup fee`, adoptStandard: zone.kind !== "standard" }, now)));
  }
  if (input.doc === "dispatch") {
    // v0.18.6 (owner G4-E4, configDocs.mustMatch): the rider documents that use this dispatch document get its raise
    // limit (RiderAppConfig.raisePrice.maxFactor), as their next version with config_published, so the rider app hides
    // the raise buttons over it.
    const factor = validFactor((document["raisePrice"] as { maxFactor?: unknown } | undefined)?.maxFactor) ?? DEFAULT_RAISE_MAX_FACTOR;
    const keys = zone.kind === "standard" ? [input.zoneId, ...(await zonesUsingStandard(trx, "dispatch", zone.country))] : [input.zoneId];
    await rewriteAppDocs(trx, keys, (doc, d) => (doc === "rider_app_config" ? withRaiseLimit(d, factor) : d), { ...by, note: `dispatch v${version}: rider raise limit ×${factor}` }, now);
  }
  if (input.doc === "country_rules") {
    // v0.8.1 (owner 2026-10-28): a zone's own rules reach only that zone (on the standard app documents it takes
    // them as its own); the standard's reach the standard and the zones with no own rules.
    const keys = zone.kind === "standard" ? [input.zoneId, ...(await zonesUsingStandard(trx, "country_rules", zone.country))] : [input.zoneId];
    await rewriteAppDocs(trx, keys, (doc, d) => withCountryRules(doc, d, document as unknown as CountryRules), { ...by, note: `tips and limits v${version}: tips, raise steps, driver bonus`, adoptStandard: zone.kind !== "standard" }, now);
  }
  // One audit line per publish, with the app documents it rewrote (v0.7.1, contract.json#pricingHistory).
  await audit(trx, { adminId: input.publishedBy, action: "config.publish", targetType: "config", targetId: input.doc, zoneId: input.zoneId, detail: { version, ...(input.note ? { note: input.note } : {}), ...(input.doc === "pricing" ? { appDocuments } : {}), ...(input.restoredFrom ? { restoredFrom: input.restoredFrom } : {}) }, at: now });
  return { doc: input.doc, ...scopeFields(input.zoneId), version, publishedAt, ...(input.doc === "pricing" ? { appDocuments } : {}), ...(input.restoredFrom ? { restoredFrom: input.restoredFrom } : {}) };
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

/**
 * v0.18.7 (contract.json#pickupWaiting.servedConfig): an app document as it is SERVED: waiting terms and rider pickup fees
 * from the zone's live pricing document (configDocs.mustMatch applied on every read, so an app document published before
 * the prices, or edited by hand, never shows other amounts), and RiderAppConfig.waiting.cancelAfterArrivedIsNoShow copied
 * from the zone's driver document (Q2). Without a pricing document the app document is served as published.
 */
export async function withLivePricing(ex: Executor, doc: ConfigDoc, zoneId: string, document: Doc): Promise<Doc> {
  if (doc !== "rider_app_config" && doc !== "driver_app_config") return document;
  const pricing = await liveDocument<PricingForApps>(ex, "pricing", zoneId);
  let next = pricing ? appDocWithPricing(doc, document, pricing.document) : document;
  if (doc === "rider_app_config") {
    const driver = await liveDocument<{ waiting?: { cancelAfterArrivedIsNoShow?: unknown } }>(ex, "driver_app_config", zoneId);
    const flag = driver?.document.waiting?.cancelAfterArrivedIsNoShow;
    const waiting: Doc = isObject(next["waiting"]) ? next["waiting"] : {};
    next = { ...next, waiting: { ...waiting, cancelAfterArrivedIsNoShow: typeof flag === "boolean" ? flag : CANCEL_AFTER_ARRIVED_DEFAULT } };
  }
  return next;
}
const CANCEL_AFTER_ARRIVED_DEFAULT = (contract as unknown as { configDefaults: { cancelAfterArrivedIsNoShow: boolean } }).configDefaults.cancelAfterArrivedIsNoShow;

/**
 * contract.json#configDocs.useStandard (v0.8.0, owner 2026-10-27): the zone's own document and draft go (the
 * history keeps every version); the standard is re-stamped above the zone's last own version so the zone's apps
 * never see a lower number, and every zone using it is told.
 */
export async function useStandard(trx: Trx, input: { doc: ConfigDoc; zoneId: string; expectedVersion: number; adminId: string }, now: Date): Promise<Publication> {
  const zone = await getZone(trx, input.zoneId);
  const key = standardKey(zone.country);
  const current = await lockDraftVersion(trx, input.doc, input.zoneId);
  await lockDraftVersion(trx, input.doc, key);
  const own = await trx.selectFrom("config_live").select("version").where("doc", "=", input.doc).where("zone_id", "=", input.zoneId).executeTakeFirst();
  if (own === undefined) throw new ApiError("conflict", "This zone already uses the standard.", { reason: "already_standard" });
  if (current.version !== input.expectedVersion) throw new ApiError("version_mismatch", "The settings changed since you last saw them.", { reason: "draft_changed" });
  const standard = await trx.selectFrom("config_live").select(["version", "document"]).where("doc", "=", input.doc).where("zone_id", "=", key).executeTakeFirst();
  if (standard === undefined) throw new ApiError("conflict", "No standard is published for this country.", { reason: "standard_not_published" });
  await trx.deleteFrom("config_live").where("doc", "=", input.doc).where("zone_id", "=", input.zoneId).execute();
  await trx.deleteFrom("config_drafts").where("doc", "=", input.doc).where("zone_id", "=", input.zoneId).execute();
  const version = Math.max(standard.version, own.version) + 1;
  const publishedAt = now.toISOString();
  const json = JSON.stringify({ ...(standard.document as Doc), version, publishedAt });
  const row = { doc: input.doc, zone_id: key, version, document: json, published_at: now, published_by: input.adminId };
  await trx.updateTable("config_live").set(row).where("doc", "=", input.doc).where("zone_id", "=", key).execute();
  await trx.insertInto("config_history").values({ ...row, approved_by: null, note: `re-stamped: ${input.zoneId} went back to the standard` }).execute();
  await notifyPublished(trx, input.doc, key, version, publishedAt);
  await audit(trx, { adminId: input.adminId, action: "config.use_standard", targetType: "config", targetId: input.doc, zoneId: input.zoneId, detail: { version, from: own.version }, at: now });
  // v0.8.1: back on the standard tips and limits, the zone's own app documents take the standard's rules.
  if (RULES_DOCS.includes(input.doc)) {
    await rewriteAppDocs(trx, [input.zoneId], (doc, d) => withCountryRules(doc, d, standard.document as CountryRules), { publishedBy: input.adminId, approvedBy: null, note: `tips and limits: back to the standard v${version}` }, now);
  }
  return { doc: input.doc, zoneId: input.zoneId, version, publishedAt };
}

export type CountryRules = { tips?: unknown; raiseSteps?: unknown; driverBonus?: unknown };

/** v0.8.0 §6.5: an app document with the country's tips and raise steps (rider) or driver bonus limits (driver). */
export function withCountryRules(doc: ConfigDoc, appDocument: Doc, rules: CountryRules): Doc {
  if (doc === "rider_app_config") return { ...appDocument, tips: rules.tips, raiseSteps: rules.raiseSteps };
  if (doc === "driver_app_config") return { ...appDocument, driverBonus: rules.driverBonus };
  return appDocument;
}

/** v0.8.1: the tips and limits of a scope: a zone's own, else its country's standard; a standard key its own. */
async function liveRules(ex: Executor, key: string): Promise<CountryRules | null> {
  return (await liveDocument<CountryRules>(ex, "country_rules", key))?.document ?? null;
}

/**
 * contract.json#configDocs.publishPricing (v0.6.0) and #configDocs.countryRules (v0.8.0): the live rider and
 * driver documents of the scopes are written again through `change`, as the next version with config_published;
 * a document already equal stays as it is; a scope with no app document gets none. A draft takes the same values
 * and its version goes up by 1, so a later app publish does not undo them.
 */
async function rewriteAppDocs(trx: Trx, keys: string[], change: (doc: ConfigDoc, document: Doc) => Doc, by: { publishedBy: string; approvedBy: string | null; note: string; adoptStandard?: boolean }, now: Date): Promise<Array<{ doc: ConfigDoc; version: number }>> {
  const rewritten: Array<{ doc: ConfigDoc; version: number }> = [];
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
        rewritten.push({ doc, version });
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
  return rewritten;
}

/* ---------------------------------------------------------------- v0.7.1: history, restore (contract.json#pricingHistory) */

export type HistoryEntry = { doc: ConfigDoc; zoneId: string; version: number; publishedAt: string; publishedBy?: string; note?: string; action: "publish" | "restore"; restoredFrom?: number; document: unknown };

/** GET /admin/config/{doc}/history: newest first; cursor = the last row's version. */
export async function configHistory(ex: Executor, doc: ConfigDoc, zoneId: string, input: { cursor?: string | undefined; limit: number }): Promise<{ items: HistoryEntry[]; nextCursor: string | null }> {
  await getZone(ex, zoneId);
  let q = ex.selectFrom("config_history").selectAll().where("doc", "=", doc).where("zone_id", "=", zoneId);
  if (input.cursor !== undefined) {
    if (!/^\d{1,9}$/.test(input.cursor)) throw badRequest("The cursor is not valid.", "invalid_cursor");
    q = q.where("version", "<", Number(input.cursor));
  }
  const rows = await q.orderBy("version", "desc").limit(input.limit + 1).execute();
  const page = rows.slice(0, input.limit);
  return {
    items: page.map((row) => ({
      doc,
      zoneId,
      version: row.version,
      publishedAt: row.published_at.toISOString(),
      ...(row.published_by ? { publishedBy: row.published_by } : {}),
      ...(row.note ? { note: row.note } : {}),
      action: row.action,
      ...(row.restored_from ? { restoredFrom: row.restored_from } : {}),
      document: row.document,
    })),
    nextCursor: rows.length > input.limit ? String(page[page.length - 1]!.version) : null,
  };
}

/**
 * POST /admin/config/{doc}/restore: an earlier published version becomes live again as the next version, with every
 * effect of a publish. expectedVersion is the live version the admin saw. Undo last publish = the version before it.
 */
export async function restoreVersion(trx: Trx, input: { doc: ConfigDoc; zoneId: string; version: number; expectedVersion: number; note?: string | undefined; by: string }, now: Date): Promise<Publication> {
  await lockDraftVersion(trx, input.doc, input.zoneId);
  const live = await liveVersion(trx, input.doc, input.zoneId);
  if (live !== input.expectedVersion) throw new ApiError("version_mismatch", "The settings changed since you last saw them.", { reason: "live_changed" });
  if (input.version === live) throw new ApiError("invalid_transition", "That version is already live.", { reason: "already_live" });
  const old = await trx.selectFrom("config_history").select("document").where("doc", "=", input.doc).where("zone_id", "=", input.zoneId).where("version", "=", input.version).executeTakeFirst();
  if (old === undefined) throw new ApiError("not_found", "That version is not in the history.", { reason: "version_not_found" });
  const document = old.document as Record<string, unknown>;
  const draft = await trx.selectFrom("config_drafts").select("version").where("doc", "=", input.doc).where("zone_id", "=", input.zoneId).executeTakeFirst();
  const saved = await putDraft(trx, { doc: input.doc, zoneId: input.zoneId, expectedVersion: draft?.version ?? 1, document, adminId: input.by }, now);
  return publishDraft(trx, { doc: input.doc, zoneId: input.zoneId, expectedVersion: saved.version, note: input.note ?? `Restore version ${input.version}`, publishedBy: input.by, approvedBy: null, restoredFrom: input.version }, now);
}

/**
 * Writes a new live version of a document that the server itself changes (v0.7.1: a car type archived in every
 * zone), with history and config_published; the draft takes the same change and its version goes up by 1.
 */
export async function rewriteLive(trx: Trx, doc: ConfigDoc, zoneId: string, change: (document: Doc) => Doc | null, note: string, by: string, now: Date): Promise<number | null> {
  const zone = await getScope(trx, zoneId);
  const draftRow = await lockDraftVersion(trx, doc, zoneId);
  const live = await trx.selectFrom("config_live").select(["version", "document"]).where("doc", "=", doc).where("zone_id", "=", zoneId).executeTakeFirst();
  if (live === undefined) return null;
  const changed = change(structuredClone(live.document as Doc));
  if (changed === null) return null;
  const version = live.version + 1;
  const document = { ...changed, version, publishedAt: now.toISOString() };
  checkDocument(doc, zone, document);
  const json = JSON.stringify(document);
  const row = { doc, zone_id: zoneId, version, document: json, published_at: now, published_by: by };
  await trx.updateTable("config_live").set(row).where("doc", "=", doc).where("zone_id", "=", zoneId).execute();
  await trx.insertInto("config_history").values({ ...row, approved_by: null, note }).execute();
  await notifyPublished(trx, doc, zoneId, version, document.publishedAt);
  const draft = await trx.selectFrom("config_drafts").select("document").where("doc", "=", doc).where("zone_id", "=", zoneId).executeTakeFirst();
  if (draft !== undefined && isObject(draft.document)) {
    const next = change(structuredClone(draft.document));
    if (next !== null) await trx.updateTable("config_drafts").set({ document: JSON.stringify(next), version: draftRow.version + 1, updated_at: now, updated_by: by }).where("doc", "=", doc).where("zone_id", "=", zoneId).execute();
  }
  return version;
}

export const PUBLISH_ACTION = "config.publish";

registerApprovalHandler(PUBLISH_ACTION, async (trx, payload, approvedBy, requestedBy, now) =>
  typeof payload["restoreVersion"] === "number"
    ? restoreVersion(trx, { doc: payload["doc"] as ConfigDoc, zoneId: payload["zoneId"] as string, version: payload["restoreVersion"], expectedVersion: payload["expectedVersion"] as number, note: payload["note"] as string | undefined, by: requestedBy }, now)
    : publishDraft(
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
