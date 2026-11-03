import type { Principal } from "../auth/guard.js";
import type { Executor, Trx } from "../db/db.js";
import { ApiError, badRequest } from "../http/errors.js";
import { audit } from "../admin/audit.js";
import { adminIncident } from "./incidents.js";
import { assertCountry } from "../admin/alerts.js";

/**
 * Incidents (contract v0.18.15, contract.json#incidentDesk): the incident settings every admin uses, and an audit line
 * for each case report download. Calls stay "coming soon" until a call company (owner G9 Q6).
 */

const MAX_BYTES = 64 * 1024;

export async function incidentSettings(ex: Executor, who: Principal, country: string) {
  await assertCountry(ex, who, country);
  const row = await ex.selectFrom("admin_incident_settings").selectAll().where("country", "=", country).executeTakeFirst();
  if (!row) return { country, rev: 1, settings: {} };
  return { country, rev: row.rev, settings: row.settings ?? {}, ...(row.updated_at ? { updatedAt: row.updated_at.toISOString() } : {}), ...(row.updated_by ? { updatedBy: row.updated_by } : {}) };
}

export async function saveIncidentSettings(trx: Trx, who: Principal, body: { country: string; expectedRev: number; settings: Record<string, unknown> }, now: Date) {
  if (JSON.stringify(body.settings).length > MAX_BYTES) throw badRequest("Too large.", "invalid_body");
  await assertCountry(trx, who, body.country);
  await trx.insertInto("admin_incident_settings").values({ country: body.country }).onConflict((oc) => oc.column("country").doNothing()).execute();
  const row = await trx.selectFrom("admin_incident_settings").selectAll().where("country", "=", body.country).forUpdate().executeTakeFirstOrThrow();
  if (row.rev !== body.expectedRev) throw new ApiError("version_mismatch", "Someone saved the incident settings first. Load them again.");
  await trx.updateTable("admin_incident_settings").set({ settings: JSON.stringify(body.settings), rev: row.rev + 1, updated_at: now, updated_by: who.subjectId }).where("country", "=", body.country).execute();
  await audit(trx, { adminId: who.subjectId, action: "incident.settings", targetType: "incident_settings", targetId: body.country, detail: { rev: row.rev + 1 }, at: now });
  return incidentSettings(trx, who, body.country);
}

export async function recordReport(trx: Trx, who: Principal, incidentId: string, now: Date): Promise<void> {
  const incident = await adminIncident(trx, who, incidentId);
  await audit(trx, { adminId: who.subjectId, action: "incident.report", targetType: "incident", targetId: incidentId, zoneId: (incident as { zoneId?: string }).zoneId ?? null, detail: {}, at: now });
}
