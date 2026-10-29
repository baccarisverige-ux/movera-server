import type { Executor, Trx } from "../db/db.js";
import { ApiError, badRequest, notFound } from "../http/errors.js";
import { newId } from "../ids.js";
import { ONBOARDING, documentKind } from "../drivers/onboardingRules.js";
import { audit } from "../admin/audit.js";
import { onboardingSettings, ownerKindOf, typeInfo } from "../drivers/onboardingSettings.js";
import { openFile, sealFile, type DocumentKey } from "./files.js";

/**
 * Driver and car documents (contract v0.5.3 §14). One row per owner and type; a new upload replaces it (back
 * to in_review). The file is sealed before it is stored and opened only for the two file endpoints; the admin's
 * reads are written in the audit.
 */
type DocumentRow = {
  document_id: string;
  driver_id: string;
  owner_kind: "driver" | "vehicle";
  owner_id: string;
  type: string;
  status: string;
  expires_at: Date | null;
  file_name: string | null;
  media_type: string | null;
  file_size: number | null;
  uploaded_at: Date | null;
  reviewed_at: Date | null;
  reviewed_by: string | null;
  review_note: string | null;
  version: number;
};

export type Upload = { type: string; ownerId?: string | undefined; expiresAt?: string | undefined; fileName: string; mediaType: string; bytes: Buffer; truncated?: boolean };

const fileUrl = (row: DocumentRow, viewer: "driver" | "admin") =>
  row.file_name === null ? {} : { fileUrl: viewer === "admin" ? `/api/v1/admin/documents/${row.document_id}/file` : `/api/v1/driver/documents/${row.document_id}/file` };

export function documentView(row: DocumentRow, viewer: "driver" | "admin") {
  return {
    documentId: row.document_id,
    ownerId: row.owner_id,
    type: row.type,
    status: row.status,
    ...(row.expires_at ? { expiresAt: row.expires_at.toISOString() } : {}),
    ...fileUrl(row, viewer),
    ...(row.file_name !== null ? { fileName: row.file_name } : {}),
    ...(row.media_type !== null ? { mediaType: row.media_type } : {}),
    ...(row.uploaded_at ? { uploadedAt: row.uploaded_at.toISOString() } : {}),
    ...(row.reviewed_at ? { reviewedAt: row.reviewed_at.toISOString() } : {}),
    ...(row.review_note !== null ? { reviewNote: row.review_note } : {}),
    version: row.version,
  };
}

export const documentSummary = (row: DocumentRow) => ({
  documentId: row.document_id,
  type: row.type,
  status: row.status,
  ...(row.expires_at ? { expiresAt: row.expires_at.toISOString() } : {}),
});

/** DocumentSummary[] of one owner (a driver or a car), oldest first. */
export async function documentSummaries(ex: Executor, ownerKind: "driver" | "vehicle", ownerId: string) {
  const rows = await ex.selectFrom("documents").selectAll().where("owner_kind", "=", ownerKind).where("owner_id", "=", ownerId).orderBy("created_at").execute();
  return rows.map((r) => documentSummary(r as DocumentRow));
}

/** The terms, accepted on onboarding: a document of kind acceptance, approved at once. */
export async function recordAcceptance(trx: Trx, driverId: string, type: string, now: Date): Promise<void> {
  await trx
    .insertInto("documents")
    .values({ document_id: newId("doc", now.getTime()), driver_id: driverId, owner_kind: "driver", owner_id: driverId, type, status: "approved", reviewed_at: now, created_at: now, updated_at: now })
    .onConflict((c) => c.columns(["owner_kind", "owner_id", "type"]).doUpdateSet({ status: "approved", reviewed_at: now, updated_at: now }))
    .execute();
}

/** GET /driver/documents: the account's own documents and its cars' (DocumentPage). */
export async function listDocuments(ex: Executor, driverId: string, statuses?: string[]) {
  let q = ex.selectFrom("documents").selectAll().where("driver_id", "=", driverId);
  if (statuses?.length) q = q.where("status", "in", statuses as never);
  const rows = await q.orderBy("created_at").execute();
  return { items: rows.map((r) => documentView(r as DocumentRow, "driver")), nextCursor: null };
}

/**
 * POST /driver/documents (multipart). The owner is the driver, or one of the account's cars (ownerId). A type the
 * contract does not know, a type of another kind than file, a bad media type or a file over the limit is 400.
 */
export async function uploadDocument(trx: Trx, key: DocumentKey, driverId: string, upload: Upload, now: Date) {
  // v0.17.0 (owner item 14): the types of the driver's country, the admin's own included.
  const country = (await trx.selectFrom("drivers").select("country").where("driver_id", "=", driverId).executeTakeFirst())?.country ?? null;
  const info = country ? typeInfo(await onboardingSettings(trx, country), upload.type) : undefined;
  const kind = info?.kind ?? documentKind(upload.type);
  if (kind === undefined) throw badRequest(`Unknown document type ${upload.type}.`, "unknown_document_type");
  if (kind !== "file") throw badRequest(`${upload.type} is not uploaded as a file.`, "not_a_file_document");
  if (!ONBOARDING.documents.upload.mediaTypes.includes(upload.mediaType)) throw badRequest("Send a JPEG, PNG, HEIC or PDF.", "unsupported_file_type");
  if (upload.truncated || upload.bytes.length > ONBOARDING.documents.upload.maxBytes) throw badRequest("The file is larger than 10 MB.", "file_too_large");
  if (upload.bytes.length === 0) throw badRequest("The file is empty.", "empty_file");
  const expected = info ? ownerKindOf(info) : ONBOARDING.documents.types[upload.type]!.owner;
  let ownerKind: "driver" | "vehicle" = "driver";
  let ownerId = driverId;
  if (upload.ownerId !== undefined && upload.ownerId !== driverId) {
    const car = await trx.selectFrom("vehicles").select(["vehicle_id", "driver_id", "fleet_id"]).where("vehicle_id", "=", upload.ownerId).executeTakeFirst();
    if (car === undefined) throw badRequest("No such car.", "vehicle_not_found");
    const me = await trx.selectFrom("drivers").select(["fleet_id"]).where("driver_id", "=", driverId).executeTakeFirstOrThrow();
    const owns = car.fleet_id !== null ? await isFleetOwner(trx, driverId, car.fleet_id) : car.driver_id === driverId;
    if (!owns) throw badRequest("That car is not yours.", "vehicle_not_found");
    void me;
    ownerKind = "vehicle";
    ownerId = car.vehicle_id;
  }
  if (expected !== ownerKind) throw badRequest(`${upload.type} belongs to a ${expected === "vehicle" ? "car" : "person"}.`, "wrong_document_owner");
  const expiresAt = upload.expiresAt ? new Date(upload.expiresAt) : null;
  if (expiresAt !== null && Number.isNaN(expiresAt.getTime())) throw badRequest("expiresAt is not a date.", "invalid_expires_at");

  const existing = await trx.selectFrom("documents").select(["document_id", "version"]).where("owner_kind", "=", ownerKind).where("owner_id", "=", ownerId).where("type", "=", upload.type).executeTakeFirst();
  const documentId = existing?.document_id ?? newId("doc", now.getTime());
  const fields = { file_name: upload.fileName.slice(0, 200), media_type: upload.mediaType, file_size: upload.bytes.length, uploaded_at: now, expires_at: expiresAt, status: "in_review" as const, reviewed_at: null, reviewed_by: null, review_note: null, updated_at: now };
  if (existing) await trx.updateTable("documents").set({ ...fields, version: existing.version + 1 }).where("document_id", "=", documentId).execute();
  else await trx.insertInto("documents").values({ document_id: documentId, driver_id: driverId, owner_kind: ownerKind, owner_id: ownerId, type: upload.type, created_at: now, ...fields }).execute();
  const sealed = sealFile(key, upload.bytes);
  await trx
    .insertInto("document_files")
    .values({ document_id: documentId, ...sealed })
    .onConflict((c) => c.column("document_id").doUpdateSet(sealed))
    .execute();
  const row = await trx.selectFrom("documents").selectAll().where("document_id", "=", documentId).executeTakeFirstOrThrow();
  return documentView(row as DocumentRow, "driver");
}

async function isFleetOwner(ex: Executor, driverId: string, fleetId: string): Promise<boolean> {
  const fleet = await ex.selectFrom("fleets").select("owner_driver_id").where("fleet_id", "=", fleetId).executeTakeFirst();
  return fleet?.owner_driver_id === driverId;
}

/** GET /driver/documents/{id}/file: the account's own files and, for a fleet owner, his drivers' and cars'. */
export async function driverDocumentFile(ex: Executor, key: DocumentKey, driverId: string, documentId: string): Promise<{ mediaType: string; fileName: string; bytes: Buffer }> {
  const row = (await ex.selectFrom("documents").selectAll().where("document_id", "=", documentId).executeTakeFirst()) as DocumentRow | undefined;
  if (row === undefined) throw notFound("No such document.", "document_not_found");
  let allowed = row.driver_id === driverId;
  if (!allowed) {
    const owner = await ex.selectFrom("drivers").select("fleet_id").where("driver_id", "=", row.driver_id).executeTakeFirst();
    allowed = owner?.fleet_id ? await isFleetOwner(ex, driverId, owner.fleet_id) : false;
  }
  if (!allowed) throw notFound("No such document.", "document_not_found");
  return readFile(ex, key, row);
}

async function readFile(ex: Executor, key: DocumentKey, row: DocumentRow) {
  const sealed = await ex.selectFrom("document_files").selectAll().where("document_id", "=", row.document_id).executeTakeFirst();
  if (sealed === undefined || row.media_type === null) throw notFound("This document has no file.", "no_file");
  return { mediaType: row.media_type, fileName: row.file_name ?? row.type, bytes: openFile(key, sealed) };
}

/* ---------------------------------------------------------------- admin */

/** The zone an admin must cover to see a document: its account's first zone. */
async function zoneOfDocument(ex: Executor, row: DocumentRow): Promise<string | null> {
  const driver = await ex.selectFrom("drivers").select("zone_ids").where("driver_id", "=", row.driver_id).executeTakeFirst();
  return driver?.zone_ids[0] ?? null;
}

async function loadForAdmin(ex: Executor, who: { zones: string[] }, documentId: string, lock = false): Promise<DocumentRow> {
  let q = ex.selectFrom("documents").selectAll().where("document_id", "=", documentId);
  if (lock) q = q.forUpdate();
  const row = (await q.executeTakeFirst()) as DocumentRow | undefined;
  if (row === undefined) throw notFound("No such document.", "document_not_found");
  const zone = await zoneOfDocument(ex, row);
  if (!who.zones.includes("*") && (zone === null || !who.zones.includes(zone))) throw new ApiError("forbidden", "This driver is outside your zones.", { reason: "zone_out_of_scope" });
  return row;
}

/** The country whose settings a document follows: a car's fleet's, else its account's. */
async function countryOfDocument(ex: Executor, row: DocumentRow): Promise<string | null> {
  if (row.owner_kind === "vehicle") {
    const car = await ex.selectFrom("vehicles").select("fleet_id").where("vehicle_id", "=", row.owner_id).executeTakeFirst();
    if (car?.fleet_id) return (await ex.selectFrom("fleets").select("country").where("fleet_id", "=", car.fleet_id).executeTakeFirst())?.country ?? null;
  }
  return (await ex.selectFrom("drivers").select("country").where("driver_id", "=", row.driver_id).executeTakeFirst())?.country ?? null;
}

/** POST /admin/documents/{id}/review (documents.approve): approved or rejected, with a note and an expiry. */
export async function reviewDocument(trx: Trx, who: { subjectId: string; zones: string[] }, documentId: string, body: { decision: "approved" | "rejected"; expiresAt?: string | undefined; note?: string | undefined }, now: Date) {
  const row = await loadForAdmin(trx, who, documentId, true);
  // v0.17.0 (owner item 1, contract.json#driverOnboarding.documentExpiry): the admin types the expiry date when
  // approving a type of the country's expiringTypes; the admin's date wins over the one the driver sent.
  const typed = body.expiresAt ? new Date(body.expiresAt) : null;
  if (typed !== null && Number.isNaN(typed.getTime())) throw badRequest("expiresAt is not a date.", "invalid_expires_at");
  if (body.decision === "approved") {
    const settings = await onboardingSettings(trx, await countryOfDocument(trx, row));
    if (settings.expiringTypes.includes(row.type) && typed === null) throw badRequest("Type the expiry date to approve this document.", "expiry_required");
    if (typed !== null && typed.getTime() <= now.getTime()) throw badRequest("The expiry date must be in the future.", "expiry_in_past");
  }
  const expiresAt = typed ?? row.expires_at;
  await trx
    .updateTable("documents")
    .set({ status: body.decision, expires_at: expiresAt, reviewed_at: now, reviewed_by: who.subjectId, review_note: body.note ?? null, version: row.version + 1, updated_at: now })
    .where("document_id", "=", documentId)
    .execute();
  await audit(trx, { adminId: who.subjectId, action: "document.review", targetType: "document", targetId: documentId, zoneId: await zoneOfDocument(trx, row), detail: { driverId: row.driver_id, type: row.type, from: row.status, to: body.decision, note: body.note ?? null }, at: now });
  const fresh = await trx.selectFrom("documents").selectAll().where("document_id", "=", documentId).executeTakeFirstOrThrow();
  return documentView(fresh as DocumentRow, "admin");
}

/** The driver, or 404; 403 when he is outside the admin's zones. */
export async function driverInScope(ex: Executor, who: { zones: string[] }, driverId: string) {
  const driver = await ex.selectFrom("drivers").select(["driver_id", "country", "zone_ids"]).where("driver_id", "=", driverId).executeTakeFirst();
  if (driver === undefined) throw notFound("No such driver.", "driver_not_found");
  if (!who.zones.includes("*") && !driver.zone_ids.some((z) => who.zones.includes(z))) throw new ApiError("forbidden", "This driver is outside your zones.", { reason: "zone_out_of_scope" });
  return driver;
}

/**
 * POST /admin/drivers/{driverId}/documents/{type}/check (documents.approve, contract v0.17.0 settings.adminCheck,
 * owner items 8 and 13): an admin marks a kind admin_check document (the info session, or one of the admin's own).
 */
export async function checkDocument(trx: Trx, who: { subjectId: string; zones: string[] }, driverId: string, type: string, body: { decision: "approved" | "rejected"; note?: string | undefined }, now: Date) {
  const driver = await driverInScope(trx, who, driverId);
  const info = driver.country ? typeInfo(await onboardingSettings(trx, driver.country), type) : undefined;
  if (info?.kind !== "admin_check") throw badRequest(`${type} is not marked by an admin.`, "not_an_admin_check");
  const existing = await trx.selectFrom("documents").select(["document_id", "version", "status"]).where("owner_kind", "=", "driver").where("owner_id", "=", driverId).where("type", "=", type).executeTakeFirst();
  const fields = { status: body.decision, reviewed_at: now, reviewed_by: who.subjectId, review_note: body.note ?? null, updated_at: now };
  const documentId = existing?.document_id ?? newId("doc", now.getTime());
  if (existing) await trx.updateTable("documents").set({ ...fields, version: existing.version + 1 }).where("document_id", "=", documentId).execute();
  else await trx.insertInto("documents").values({ document_id: documentId, driver_id: driverId, owner_kind: "driver", owner_id: driverId, type, created_at: now, ...fields }).execute();
  await audit(trx, { adminId: who.subjectId, action: "document.check", targetType: "document", targetId: documentId, zoneId: driver.zone_ids[0] ?? null, detail: { driverId, type, from: existing?.status ?? null, to: body.decision, note: body.note ?? null }, at: now });
  const row = await trx.selectFrom("documents").selectAll().where("document_id", "=", documentId).executeTakeFirstOrThrow();
  return documentView(row as DocumentRow, "admin");
}

/** GET /admin/documents/{id}/file (documents.approve): the file, and an audit line that it was read. */
export async function adminDocumentFile(trx: Trx, key: DocumentKey, who: { subjectId: string; zones: string[] }, documentId: string, now: Date) {
  const row = await loadForAdmin(trx, who, documentId);
  const file = await readFile(trx, key, row);
  await audit(trx, { adminId: who.subjectId, action: "document.file", targetType: "document", targetId: documentId, zoneId: await zoneOfDocument(trx, row), detail: { driverId: row.driver_id, type: row.type }, at: now });
  return file;
}
