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

export const CONFIG_DOCS: readonly ConfigDoc[] = ["rider_app_config", "driver_app_config", "pricing", "dispatch"];
export const APP_DOCS: readonly ConfigDoc[] = ["rider_app_config", "driver_app_config"];

const SCHEMA: Record<ConfigDoc, string> = {
  rider_app_config: "RiderAppConfig",
  driver_app_config: "DriverAppConfig",
  pricing: "PricingDocument",
  dispatch: "DispatchDocument",
};

/** x-permission-by-doc in openapi.yaml, and who approves a publish by an admin who is not approval-exempt. */
export const EDIT_PERMISSION: Record<ConfigDoc, string> = { rider_app_config: "settings.edit", driver_app_config: "settings.edit", pricing: "settings.edit", dispatch: "dispatch.edit" };
export const PUBLISH_PERMISSION: Record<ConfigDoc, string> = { rider_app_config: "settings.publish", driver_app_config: "settings.publish", pricing: "settings.publish", dispatch: "dispatch.edit" };
export const APPROVE_PERMISSION: Record<ConfigDoc, string> = { rider_app_config: "approval.decide", driver_app_config: "approval.decide", pricing: "approval.decide", dispatch: "dispatch.approve" };

/** The channel apps' config streams LISTEN on (config_published). */
export const CONFIG_CHANNEL = "movera_config_published";

export type Zone = { zoneId: string; name: string; country: string; currency: string; timeZone: string; kind: string; open: boolean; center: { lat: number; lng: number } };

export async function getZone(ex: Executor, zoneId: string): Promise<Zone> {
  const row = await ex.selectFrom("zones").selectAll().where("zone_id", "=", zoneId).executeTakeFirst();
  if (row === undefined) throw new ApiError("not_found", "No such zone.", { reason: "zone_not_found" });
  return { zoneId: row.zone_id, name: row.name, country: row.country, currency: row.currency, timeZone: row.time_zone, kind: row.kind, open: row.open, center: { lat: row.center_lat, lng: row.center_lng } };
}

export type ConfigDraftView = { doc: ConfigDoc; zoneId: string; version: number; liveVersion: number; document: unknown; updatedAt: string; updatedBy?: string };

/** A document must pass the contract schema and belong to the zone it is saved for. */
export function checkDocument(doc: ConfigDoc, zone: Zone, document: unknown): void {
  const problem = schemaProblem(SCHEMA[doc], document);
  if (problem !== null) throw badRequest(`The ${doc} document is not valid: ${problem}.`, "invalid_document");
  const own = document as { zoneId?: string; currency?: string; country?: string; timeZone?: string };
  if (own.zoneId !== zone.zoneId) throw badRequest(`The document is for zone ${own.zoneId}, not ${zone.zoneId}.`, "zone_mismatch");
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

/**
 * GET /admin/config/{doc}. A zone with no draft yet starts from its live document (draft version 1); with neither,
 * 404 config_not_found, and the first PUT is made with expectedVersion 1.
 */
export async function getDraft(db: Executor, doc: ConfigDoc, zoneId: string): Promise<ConfigDraftView> {
  await getZone(db, zoneId);
  const draft = await db.selectFrom("config_drafts").selectAll().where("doc", "=", doc).where("zone_id", "=", zoneId).executeTakeFirst();
  const live = await db.selectFrom("config_live").selectAll().where("doc", "=", doc).where("zone_id", "=", zoneId).executeTakeFirst();
  if (draft !== undefined) {
    return { doc, zoneId, version: draft.version, liveVersion: live?.version ?? 0, document: draft.document, updatedAt: draft.updated_at.toISOString(), ...(draft.updated_by ? { updatedBy: draft.updated_by } : {}) };
  }
  if (live !== undefined) {
    return { doc, zoneId, version: 1, liveVersion: live.version, document: live.document, updatedAt: live.published_at.toISOString(), ...(live.published_by ? { updatedBy: live.published_by } : {}) };
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
  const zone = await getZone(trx, input.zoneId);
  checkDocument(input.doc, zone, input.document);
  const current = await lockDraftVersion(trx, input.doc, input.zoneId);
  if (current.version !== input.expectedVersion) {
    const projection = await getDraft(trx, input.doc, input.zoneId).catch(() => undefined);
    throw new ApiError("version_mismatch", "The settings changed since you last saw them.", projection === undefined ? {} : { projection });
  }
  const version = current.version + 1;
  const values = { doc: input.doc, zone_id: input.zoneId, version, document: JSON.stringify(input.document), updated_at: now, updated_by: input.adminId };
  await trx.insertInto("config_drafts").values(values).onConflict((c) => c.columns(["doc", "zone_id"]).doUpdateSet(values)).execute();
  await audit(trx, { adminId: input.adminId, action: "config.draft", targetType: "config", targetId: input.doc, zoneId: input.zoneId, detail: { version }, at: now });
  return getDraft(trx, input.doc, input.zoneId);
}

export type Publication = { doc: ConfigDoc; zoneId: string; version: number; publishedAt: string };

/**
 * Makes the draft live: next live version, publishedAt stamped into the document, history row, and a
 * config_published notification sent on commit. Runs directly for a Super admin or when a second admin approves.
 */
export async function publishDraft(trx: Trx, input: { doc: ConfigDoc; zoneId: string; expectedVersion: number; note?: string | undefined; publishedBy: string; approvedBy: string | null }, now: Date): Promise<Publication> {
  const zone = await getZone(trx, input.zoneId);
  const current = await lockDraftVersion(trx, input.doc, input.zoneId);
  if (current.version !== input.expectedVersion) {
    throw new ApiError("version_mismatch", "The settings changed since this publish was asked for.", { reason: "draft_changed" });
  }
  if (current.document === null) throw new ApiError("not_found", "There is no draft to publish.", { reason: "config_not_found" });
  const version = (await liveVersion(trx, input.doc, input.zoneId)) + 1;
  const publishedAt = now.toISOString();
  const document = { ...(current.document as Record<string, unknown>), version, publishedAt };
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
  await sql`SELECT pg_notify(${CONFIG_CHANNEL}, ${JSON.stringify({ doc: input.doc, zoneId: input.zoneId, version, publishedAt })})`.execute(trx);
  if (input.doc === "pricing") await keepAppDocsInStep(trx, zone, document as unknown as PricingForApps, { publishedBy: input.publishedBy, approvedBy: input.approvedBy, pricingVersion: version }, now);
  return { doc: input.doc, zoneId: input.zoneId, version, publishedAt };
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
 * contract.json#configDocs.publishPricing (v0.6.0, owner 2026-10-27): publishing pricing rewrites the zone's live
 * rider and driver documents with its waiting, no-show and rider pickup fee, as the next version with
 * config_published; a document already equal stays as it is; a zone with no app document gets none. A draft takes
 * the same values and its version goes up by 1, so a later app publish does not undo them.
 */
async function keepAppDocsInStep(trx: Trx, zone: Zone, pricing: PricingForApps, by: { publishedBy: string; approvedBy: string | null; pricingVersion: number }, now: Date): Promise<void> {
  for (const doc of APP_DOCS) {
    const draftRow = await lockDraftVersion(trx, doc, zone.zoneId);
    const live = await trx.selectFrom("config_live").select(["version", "document"]).where("doc", "=", doc).where("zone_id", "=", zone.zoneId).executeTakeFirst();
    if (live === undefined) continue;
    const current = live.document as Doc;
    const synced = appDocWithPricing(doc, current, pricing);
    if (JSON.stringify(synced) !== JSON.stringify(current)) {
      const version = live.version + 1;
      const document = { ...synced, version, publishedAt: now.toISOString() };
      checkDocument(doc, zone, document);
      const json = JSON.stringify(document);
      const row = { doc, zone_id: zone.zoneId, version, document: json, published_at: now, published_by: by.publishedBy };
      await trx.updateTable("config_live").set(row).where("doc", "=", doc).where("zone_id", "=", zone.zoneId).execute();
      await trx.insertInto("config_history").values({ ...row, approved_by: by.approvedBy, note: `pricing v${by.pricingVersion}: waiting, no-show and pickup fee` }).execute();
      await sql`SELECT pg_notify(${CONFIG_CHANNEL}, ${JSON.stringify({ doc, zoneId: zone.zoneId, version, publishedAt: document.publishedAt })})`.execute(trx);
    }
    const draft = await trx.selectFrom("config_drafts").select(["document"]).where("doc", "=", doc).where("zone_id", "=", zone.zoneId).executeTakeFirst();
    if (draft !== undefined && isObject(draft.document)) {
      const next = appDocWithPricing(doc, draft.document, pricing);
      if (JSON.stringify(next) !== JSON.stringify(draft.document)) {
        await trx.updateTable("config_drafts").set({ document: JSON.stringify(next), version: draftRow.version + 1, updated_at: now, updated_by: by.publishedBy }).where("doc", "=", doc).where("zone_id", "=", zone.zoneId).execute();
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

/** The live document, or null (the apps keep their own seed; the server treats pricing/dispatch as required). */
export async function liveDocument<T = Record<string, unknown>>(ex: Executor, doc: ConfigDoc, zoneId: string): Promise<{ version: number; document: T } | null> {
  const row = await ex.selectFrom("config_live").select(["version", "document"]).where("doc", "=", doc).where("zone_id", "=", zoneId).executeTakeFirst();
  return row === undefined ? null : { version: row.version, document: row.document as T };
}
