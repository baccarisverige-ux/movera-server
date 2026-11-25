import type { Executor, Trx } from "../db/db.js";
import { ApiError, badRequest, notFound } from "../http/errors.js";
import { newId } from "../ids.js";
import { COUNTRY_TIME_ZONE, ONBOARDING, documentKind } from "../drivers/onboardingRules.js";
import { audit } from "../admin/audit.js";
import { onboardingSettings, ownerKindOf, typeInfo } from "../drivers/onboardingSettings.js";
import { noticeDocumentReview } from "../drivers/reviewNotices.js";
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

/** v0.18.5 (G2-D5.2, documents.upload.contentCheck): what the file's first bytes say it is, or null. */
export function sniffMediaType(bytes: Buffer): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString("latin1") === "ftyp" && HEIC_BRANDS.includes(bytes.subarray(8, 12).toString("latin1"))) return "image/heic";
  return null;
}
const HEIC_BRANDS = ["heic", "heix", "hevc", "hevx", "mif1", "msf1", "heim", "heis"];

/** v0.18.5 (G2-D5.8, documentExpiry.maxYearsAhead): an end date at most 15 years after today. */
export const EXPIRY_MAX_YEARS = (ONBOARDING as unknown as { documentExpiry: { maxYearsAhead: number } }).documentExpiry.maxYearsAhead;
export function assertExpiryWithin(expiresAt: Date, now: Date): void {
  const max = new Date(now.getTime());
  max.setUTCFullYear(max.getUTCFullYear() + EXPIRY_MAX_YEARS);
  if (expiresAt.getTime() > max.getTime()) throw badRequest(`The end date is more than ${EXPIRY_MAX_YEARS} years ahead. Check the end date.`, "expiry_too_far");
}

/** v0.18.5 (G2-D5.7, reviewReason): every rejection (or block) says why. */
export function assertReason(decision: string, note: string | undefined): void {
  if ((decision === "rejected" || decision === "blocked") && (note ?? "").trim() === "") throw badRequest("Write why, so the driver knows what to fix.", "note_required");
}

type RenewalRow = {
  renewal_id: string;
  document_id: string;
  status: "in_review" | "rejected";
  expires_at: Date | null;
  file_name: string;
  media_type: string;
  file_size: number;
  uploaded_at: Date;
  reviewed_at: Date | null;
  review_note: string | null;
  version: number;
};

/** v0.18.5 (G2-D1, documentRenewal): a renewal as a Document, renewalOf = the approved document it renews. */
function renewalView(r: RenewalRow, main: { owner_id: string; type: string }, viewer: "driver" | "admin") {
  return {
    documentId: r.renewal_id,
    ownerId: main.owner_id,
    type: main.type,
    status: r.status,
    ...(r.expires_at ? { expiresAt: r.expires_at.toISOString() } : {}),
    fileUrl: viewer === "admin" ? `/api/v1/admin/documents/${r.renewal_id}/file` : `/api/v1/driver/documents/${r.renewal_id}/file`,
    fileName: r.file_name,
    mediaType: r.media_type,
    uploadedAt: r.uploaded_at.toISOString(),
    ...(r.reviewed_at ? { reviewedAt: r.reviewed_at.toISOString() } : {}),
    ...(r.review_note !== null ? { reviewNote: r.review_note } : {}),
    version: r.version,
    renewalOf: r.document_id,
  };
}

const RENEWAL_FIELDS = ["renewal_id", "document_id", "status", "expires_at", "file_name", "media_type", "file_size", "uploaded_at", "reviewed_at", "review_note", "version"] as const;

/** The renewals of these documents, by document id. */
async function renewalsOf(ex: Executor, documentIds: string[]): Promise<Map<string, RenewalRow>> {
  if (documentIds.length === 0) return new Map();
  const rows = (await ex.selectFrom("document_renewals").select([...RENEWAL_FIELDS]).where("document_id", "in", documentIds).execute()) as RenewalRow[];
  return new Map(rows.map((r) => [r.document_id, r]));
}

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
  return (await documentSummariesOf(ex, ownerKind, [ownerId])).get(ownerId) ?? [];
}

/** S06 F9: documentSummaries of many owners in two queries (the documents, then their waiting renewals). */
export async function documentSummariesOf(ex: Executor, ownerKind: "driver" | "vehicle", ownerIds: string[]) {
  const out = new Map<string, Array<ReturnType<typeof documentSummary> | { documentId: string; type: string; status: string; expiresAt?: string; renewalOf: string }>>();
  if (ownerIds.length === 0) return out;
  const rows = await ex.selectFrom("documents").selectAll().where("owner_kind", "=", ownerKind).where("owner_id", "in", ownerIds).orderBy("created_at").orderBy("document_id").execute();
  const renewals = await renewalsOf(ex, rows.map((r) => r.document_id));
  // v0.18.5 (G2-D1): a waiting renewal is listed right after the document it renews.
  for (const r of rows) {
    const renewal = renewals.get(r.document_id);
    const own = documentSummary(r as DocumentRow);
    const list = out.get(r.owner_id) ?? [];
    list.push(own);
    if (renewal) list.push({ documentId: renewal.renewal_id, type: r.type, status: renewal.status, ...(renewal.expires_at ? { expiresAt: renewal.expires_at.toISOString() } : {}), renewalOf: r.document_id });
    out.set(r.owner_id, list);
  }
  return out;
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
  // v0.18.0 (owner decision 19): a member sees only his own documents, never a car's.
  const me = await ex.selectFrom("drivers").select(["account_type", "fleet_id"]).where("driver_id", "=", driverId).executeTakeFirst();
  if (me?.account_type === "driver") q = q.where("owner_kind", "=", "driver");
  const rows = await q.orderBy("created_at").execute();
  const renewals = await renewalsOf(ex, rows.map((r) => r.document_id));
  const keep = (status: string) => !statuses?.length || statuses.includes(status);
  // v0.18.5 (G2-D1): the approved document and, after it, its waiting renewal.
  const items = rows.flatMap((r) => {
    const renewal = renewals.get(r.document_id);
    return [
      ...(keep(r.status) ? [documentView(r as DocumentRow, "driver")] : []),
      ...(renewal && keep(renewal.status) ? [renewalView(renewal, r, "driver")] : []),
    ];
  });
  return { items, nextCursor: null };
}

/**
 * POST /driver/documents (multipart). The owner is the driver, or one of the account's cars (ownerId). A type the
 * contract does not know, a type of another kind than file, a bad media type or a file over the limit is 400.
 */
export async function uploadDocument(trx: Trx, key: DocumentKey, driverId: string, upload: Upload, now: Date) {
  // v0.18.0 (owner item 14): the types of the driver's country, the admin's own included.
  const country = (await trx.selectFrom("drivers").select("country").where("driver_id", "=", driverId).executeTakeFirst())?.country ?? null;
  const info = country ? typeInfo(await onboardingSettings(trx, country), upload.type) : undefined;
  const kind = info?.kind ?? documentKind(upload.type);
  if (kind === undefined) throw badRequest(`Unknown document type ${upload.type}.`, "unknown_document_type");
  if (kind !== "file") throw badRequest(`${upload.type} is not uploaded as a file.`, "not_a_file_document");
  if (!ONBOARDING.documents.upload.mediaTypes.includes(upload.mediaType)) throw badRequest("Send a JPEG, PNG, HEIC or PDF.", "unsupported_file_type");
  if (upload.truncated || upload.bytes.length > ONBOARDING.documents.upload.maxBytes) throw badRequest("The file is larger than 10 MB.", "file_too_large");
  if (upload.bytes.length === 0) throw badRequest("The file is empty.", "empty_file");
  // v0.18.5 (G2-D5.2): the content must be a real JPEG, PNG, HEIC or PDF; it is stored as what it is.
  const detected = sniffMediaType(upload.bytes);
  if (detected === null) throw badRequest("This file is not a photo or PDF.", "invalid_file_content");
  const expected = info ? ownerKindOf(info) : ONBOARDING.documents.types[upload.type]!.owner;
  let ownerKind: "driver" | "vehicle" = "driver";
  let ownerId = driverId;
  if (upload.ownerId !== undefined && upload.ownerId !== driverId) {
    const car = await trx.selectFrom("vehicles").select(["vehicle_id", "driver_id", "fleet_id"]).where("vehicle_id", "=", upload.ownerId).executeTakeFirst();
    if (car === undefined) throw badRequest("No such car.", "vehicle_not_found");
    const me = await trx.selectFrom("drivers").select(["fleet_id"]).where("driver_id", "=", driverId).executeTakeFirstOrThrow();
    const owns = car.fleet_id !== null ? await isFleetOwner(trx, driverId, car.fleet_id) : car.driver_id === driverId;
    // v0.18.0 (owner decision 19): a member of the car's fleet is refused; only its owner uploads car documents.
    if (!owns && car.fleet_id !== null && me.fleet_id === car.fleet_id) throw new ApiError("forbidden", "Only the fleet owner handles the cars' documents.", { reason: "fleet_owner_only" });
    if (!owns) throw badRequest("That car is not yours.", "vehicle_not_found");
    void me;
    ownerKind = "vehicle";
    ownerId = car.vehicle_id;
  }
  if (expected !== ownerKind) throw badRequest(`${upload.type} belongs to a ${expected === "vehicle" ? "car" : "person"}.`, "wrong_document_owner");
  const expiresAt = upload.expiresAt ? new Date(upload.expiresAt) : null;
  if (expiresAt !== null && Number.isNaN(expiresAt.getTime())) throw badRequest("expiresAt is not a date.", "invalid_expires_at");
  if (expiresAt !== null) assertExpiryWithin(expiresAt, now);

  const existing = await trx.selectFrom("documents").select(["document_id", "version", "status", "owner_id", "type"]).where("owner_kind", "=", ownerKind).where("owner_id", "=", ownerId).where("type", "=", upload.type).forUpdate().executeTakeFirst();
  // v0.18.5 (G2-D1, documentRenewal): an approved (or expired) document is never touched by an upload; the new file
  // waits as its renewal (one per document, a new upload replaces it) until an admin approves it.
  if (existing && (existing.status === "approved" || existing.status === "expired")) {
    const sealed = sealFile(key, upload.bytes);
    const fields = { status: "in_review" as const, expires_at: expiresAt, file_name: upload.fileName.slice(0, 200), media_type: detected, file_size: upload.bytes.length, uploaded_at: now, reviewed_at: null, reviewed_by: null, review_note: null, updated_at: now, ...sealed };
    const prev = await trx.selectFrom("document_renewals").select(["renewal_id", "version"]).where("document_id", "=", existing.document_id).forUpdate().executeTakeFirst();
    if (prev) await trx.updateTable("document_renewals").set({ ...fields, version: prev.version + 1 }).where("renewal_id", "=", prev.renewal_id).execute();
    else await trx.insertInto("document_renewals").values({ renewal_id: newId("drn", now.getTime()), document_id: existing.document_id, created_at: now, ...fields }).execute();
    const renewal = (await trx.selectFrom("document_renewals").select([...RENEWAL_FIELDS]).where("document_id", "=", existing.document_id).executeTakeFirstOrThrow()) as RenewalRow;
    return renewalView(renewal, existing, "driver");
  }
  const documentId = existing?.document_id ?? newId("doc", now.getTime());
  const fields = { file_name: upload.fileName.slice(0, 200), media_type: detected, file_size: upload.bytes.length, uploaded_at: now, expires_at: expiresAt, status: "in_review" as const, reviewed_at: null, reviewed_by: null, review_note: null, updated_at: now };
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

/**
 * GET /driver/documents/{id}/file: the account's own files and, for a fleet owner, his cars'. v0.18.5 (G2-D2,
 * ownerPrivacy): never his drivers' documents. A renewal's id opens the renewal's file (G2-D1).
 */
export async function driverDocumentFile(ex: Executor, key: DocumentKey, driverId: string, documentId: string): Promise<{ mediaType: string; fileName: string; bytes: Buffer }> {
  const renewal = (await ex.selectFrom("document_renewals").selectAll().where("renewal_id", "=", documentId).executeTakeFirst()) as (RenewalRow & { key_id: string; iv: Buffer; tag: Buffer; ciphertext: Buffer }) | undefined;
  const row = (await ex.selectFrom("documents").selectAll().where("document_id", "=", renewal?.document_id ?? documentId).executeTakeFirst()) as DocumentRow | undefined;
  if (row === undefined) throw notFound("No such document.", "document_not_found");
  // v0.18.0 (owner decision 19): a car's document only for the owner of the car's fleet.
  if (row.owner_kind === "vehicle") {
    const car = await ex.selectFrom("vehicles").select(["fleet_id", "driver_id"]).where("vehicle_id", "=", row.owner_id).executeTakeFirst();
    const owns = car?.fleet_id ? await isFleetOwner(ex, driverId, car.fleet_id) : car?.driver_id === driverId;
    if (!owns) {
      const me = await ex.selectFrom("drivers").select("fleet_id").where("driver_id", "=", driverId).executeTakeFirst();
      if (car?.fleet_id && me?.fleet_id === car.fleet_id) throw new ApiError("forbidden", "Only the fleet owner handles the cars' documents.", { reason: "fleet_owner_only" });
      throw notFound("No such document.", "document_not_found");
    }
  } else if (row.driver_id !== driverId) {
    // v0.18.5 (G2-D2): a fleet owner sees nothing of his drivers' documents.
    throw notFound("No such document.", "document_not_found");
  }
  if (renewal) return { mediaType: renewal.media_type, fileName: renewal.file_name, bytes: openFile(key, renewal) };
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

/** `date` plus whole calendar months (the last day of a shorter month when the day does not exist there), in UTC. */
export function addMonths(date: Date, months: number): Date {
  const out = new Date(date.getTime());
  const day = out.getUTCDate();
  out.setUTCDate(1);
  out.setUTCMonth(out.getUTCMonth() + months);
  const last = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(day, last));
  return out;
}

type ReviewBody = { decision: "approved" | "rejected"; expiresAt?: string | undefined; issuedAt?: string | undefined; note?: string | undefined };

/** Doc dates: is the issue day (its UTC calendar day, as the admin sends it) after today in the country's own zone? */
export function issuedDayInFuture(issued: Date, now: Date, country: string | null): boolean {
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: COUNTRY_TIME_ZONE[country ?? ""] ?? "Europe/Stockholm", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  return issued.toISOString().slice(0, 10) > today;
}

/** The expiry an approval sets: the admin's date, else issuedAt + validMonths, else `fallback`; checked (items 1, R9, D5.8). */
async function approvalExpiry(trx: Trx, row: DocumentRow, body: ReviewBody, fallback: Date | null, now: Date): Promise<Date | null> {
  // v0.18.0 (owner item 1, contract.json#driverOnboarding.documentExpiry): the admin types the expiry date when
  // approving a type of the country's expiringTypes; the admin's date wins over the one the driver sent.
  let typed = body.expiresAt ? new Date(body.expiresAt) : null;
  if (typed !== null && Number.isNaN(typed.getTime())) throw badRequest("expiresAt is not a date.", "invalid_expires_at");
  if (body.decision !== "approved") return typed ?? fallback;
  const country = await countryOfDocument(trx, row);
  const settings = await onboardingSettings(trx, country);
  // v0.18.3 (R9, settings.validMonths): the issue date plus the type's valid months, unless the admin typed the date.
  if (body.issuedAt !== undefined) {
    const issued = new Date(body.issuedAt);
    if (Number.isNaN(issued.getTime())) throw badRequest("issuedAt is not a date.", "invalid_issued_at");
    // Doc dates (2026-11-24): the issue date is a calendar day; it is compared with today in the document's country
    // (Stockholm 00:30 is still the day before in UTC), and it is checked whether or not the admin typed the end date.
    if (issuedDayInFuture(issued, now, country)) throw badRequest("The issue date cannot be in the future.", "issued_in_future");
    const months = settings.validMonths?.[row.type];
    if (typed === null && months !== undefined) typed = addMonths(issued, months);
  }
  if (settings.expiringTypes.includes(row.type) && typed === null) throw badRequest("Type the expiry date to approve this document.", "expiry_required");
  if (typed !== null && typed.getTime() <= now.getTime()) throw badRequest("The expiry date must be in the future.", "expiry_in_past");
  // v0.18.5 (G2-D5.8): at most 15 years ahead.
  if (typed !== null) assertExpiryWithin(typed, now);
  return typed ?? fallback;
}

/**
 * POST /admin/documents/{id}/review (documents.approve): approved or rejected, with a note and an expiry. v0.18.5: a
 * rejection needs a note (G2-D5.7); a renewal's id reviews the renewal (G2-D1): approving it puts its file and end date
 * on the document (same documentId), rejecting it leaves the approved document as it was.
 */
export async function reviewDocument(trx: Trx, who: { subjectId: string; zones: string[] }, documentId: string, body: ReviewBody, now: Date) {
  const renewal = (await trx.selectFrom("document_renewals").selectAll().where("renewal_id", "=", documentId).forUpdate().executeTakeFirst()) as (RenewalRow & { key_id: string; iv: Buffer; tag: Buffer; ciphertext: Buffer }) | undefined;
  if (renewal) return reviewRenewal(trx, who, renewal, body, now);
  const row = await loadForAdmin(trx, who, documentId, true);
  assertReason(body.decision, body.note);
  // v0.18.164 (owner 2026-11-25 "Yes, fix all 3", upload safety): a file document with no file is never approved.
  if (body.decision === "approved" && (await documentKindIn(trx, row)) === "file") {
    const file = row.file_name === null ? undefined : await trx.selectFrom("document_files").select("document_id").where("document_id", "=", row.document_id).executeTakeFirst();
    if (file === undefined) throw badRequest("This document has no file yet; it cannot be approved.", "no_file");
  }
  const expiresAt = await approvalExpiry(trx, row, body, row.expires_at, now);
  await trx
    .updateTable("documents")
    .set({ status: body.decision, expires_at: expiresAt, reviewed_at: now, reviewed_by: who.subjectId, review_note: body.note ?? null, version: row.version + 1, updated_at: now })
    .where("document_id", "=", documentId)
    .execute();
  // v0.18.3 (R6): the bell notice, with the reason.
  await noticeDocumentReview(trx, row, body.decision, body.note ?? null, now);
  await audit(trx, { adminId: who.subjectId, action: "document.review", targetType: "document", targetId: documentId, zoneId: await zoneOfDocument(trx, row), detail: { driverId: row.driver_id, type: row.type, from: row.status, to: body.decision, note: body.note ?? null }, at: now });
  const fresh = await trx.selectFrom("documents").selectAll().where("document_id", "=", documentId).executeTakeFirstOrThrow();
  return documentView(fresh as DocumentRow, "admin");
}

async function reviewRenewal(trx: Trx, who: { subjectId: string; zones: string[] }, renewal: RenewalRow & { key_id: string; iv: Buffer; tag: Buffer; ciphertext: Buffer }, body: ReviewBody, now: Date) {
  const row = await loadForAdmin(trx, who, renewal.document_id, true);
  assertReason(body.decision, body.note);
  const zoneId = await zoneOfDocument(trx, row);
  const detail = { driverId: row.driver_id, type: row.type, renewalId: renewal.renewal_id, from: renewal.status, to: body.decision, note: body.note ?? null };
  if (body.decision === "rejected") {
    await trx.updateTable("document_renewals").set({ status: "rejected", reviewed_at: now, reviewed_by: who.subjectId, review_note: body.note ?? null, version: renewal.version + 1, updated_at: now }).where("renewal_id", "=", renewal.renewal_id).execute();
    await noticeDocumentReview(trx, row, "rejected", body.note ?? null, now);
    await audit(trx, { adminId: who.subjectId, action: "document.review", targetType: "document", targetId: row.document_id, zoneId, detail, at: now });
    const fresh = (await trx.selectFrom("document_renewals").select([...RENEWAL_FIELDS]).where("renewal_id", "=", renewal.renewal_id).executeTakeFirstOrThrow()) as RenewalRow;
    return renewalView(fresh, row, "admin");
  }
  const expiresAt = await approvalExpiry(trx, row, body, renewal.expires_at, now);
  const sealed = { key_id: renewal.key_id, iv: renewal.iv, tag: renewal.tag, ciphertext: renewal.ciphertext };
  await trx
    .updateTable("documents")
    .set({ status: "approved", expires_at: expiresAt, file_name: renewal.file_name, media_type: renewal.media_type, file_size: renewal.file_size, uploaded_at: renewal.uploaded_at, reviewed_at: now, reviewed_by: who.subjectId, review_note: body.note ?? null, version: row.version + 1, updated_at: now })
    .where("document_id", "=", row.document_id)
    .execute();
  await trx.insertInto("document_files").values({ document_id: row.document_id, ...sealed }).onConflict((c) => c.column("document_id").doUpdateSet(sealed)).execute();
  await trx.deleteFrom("document_renewals").where("renewal_id", "=", renewal.renewal_id).execute();
  await noticeDocumentReview(trx, row, "approved", body.note ?? null, now);
  await audit(trx, { adminId: who.subjectId, action: "document.review", targetType: "document", targetId: row.document_id, zoneId, detail, at: now });
  const fresh = await trx.selectFrom("documents").selectAll().where("document_id", "=", row.document_id).executeTakeFirstOrThrow();
  return documentView(fresh as DocumentRow, "admin");
}

/** v0.18.164: the kind of a document's type in its country (the country's custom type, else the contract's). */
async function documentKindIn(trx: Trx, row: DocumentRow): Promise<string | undefined> {
  const settings = await onboardingSettings(trx, await countryOfDocument(trx, row));
  return typeInfo(settings, row.type)?.kind ?? documentKind(row.type);
}

/** The driver, or 404; 403 when he is outside the admin's zones. */
export async function driverInScope(ex: Executor, who: { zones: string[] }, driverId: string) {
  const driver = await ex.selectFrom("drivers").select(["driver_id", "country", "zone_ids"]).where("driver_id", "=", driverId).executeTakeFirst();
  if (driver === undefined) throw notFound("No such driver.", "driver_not_found");
  if (!who.zones.includes("*") && !driver.zone_ids.some((z) => who.zones.includes(z))) throw new ApiError("forbidden", "This driver is outside your zones.", { reason: "zone_out_of_scope" });
  return driver;
}

/**
 * POST /admin/drivers/{driverId}/documents/{type}/check (documents.approve, contract v0.18.0 settings.adminCheck,
 * owner items 8 and 13): an admin marks a kind admin_check document (the info session, or one of the admin's own).
 */
export async function checkDocument(trx: Trx, who: { subjectId: string; zones: string[] }, driverId: string, type: string, body: { decision: "approved" | "rejected"; note?: string | undefined }, now: Date) {
  const driver = await driverInScope(trx, who, driverId);
  assertReason(body.decision, body.note);
  const info = driver.country ? typeInfo(await onboardingSettings(trx, driver.country), type) : undefined;
  if (info?.kind !== "admin_check") throw badRequest(`${type} is not marked by an admin.`, "not_an_admin_check");
  const existing = await trx.selectFrom("documents").select(["document_id", "version", "status"]).where("owner_kind", "=", "driver").where("owner_id", "=", driverId).where("type", "=", type).executeTakeFirst();
  const fields = { status: body.decision, reviewed_at: now, reviewed_by: who.subjectId, review_note: body.note ?? null, updated_at: now };
  const documentId = existing?.document_id ?? newId("doc", now.getTime());
  if (existing) await trx.updateTable("documents").set({ ...fields, version: existing.version + 1 }).where("document_id", "=", documentId).execute();
  else await trx.insertInto("documents").values({ document_id: documentId, driver_id: driverId, owner_kind: "driver", owner_id: driverId, type, created_at: now, ...fields }).execute();
  // v0.18.3 (R6): the bell notice (info session held, or not).
  await noticeDocumentReview(trx, { document_id: documentId, driver_id: driverId, owner_kind: "driver", owner_id: driverId, type }, body.decision, body.note ?? null, now);
  await audit(trx, { adminId: who.subjectId, action: "document.check", targetType: "document", targetId: documentId, zoneId: driver.zone_ids[0] ?? null, detail: { driverId, type, from: existing?.status ?? null, to: body.decision, note: body.note ?? null }, at: now });
  const row = await trx.selectFrom("documents").selectAll().where("document_id", "=", documentId).executeTakeFirstOrThrow();
  return documentView(row as DocumentRow, "admin");
}

/** GET /admin/documents/{id}/file (documents.approve): the file, and an audit line that it was read. */
export async function adminDocumentFile(trx: Trx, key: DocumentKey, who: { subjectId: string; zones: string[] }, documentId: string, now: Date) {
  // v0.18.5 (G2-D1): a renewal's id opens the renewal's file.
  const renewal = (await trx.selectFrom("document_renewals").selectAll().where("renewal_id", "=", documentId).executeTakeFirst()) as (RenewalRow & { key_id: string; iv: Buffer; tag: Buffer; ciphertext: Buffer }) | undefined;
  const row = await loadForAdmin(trx, who, renewal?.document_id ?? documentId);
  const file = renewal ? { mediaType: renewal.media_type, fileName: renewal.file_name, bytes: openFile(key, renewal) } : await readFile(trx, key, row);
  await audit(trx, { adminId: who.subjectId, action: "document.file", targetType: "document", targetId: documentId, zoneId: await zoneOfDocument(trx, row), detail: { driverId: row.driver_id, type: row.type }, at: now });
  return file;
}
