import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { adminCoversZone, authenticateAdmin, type Principal } from "../auth/guard.js";
import type { Db, Trx } from "../db/db.js";
import { loadFleet, coversFleet } from "../drivers/fleets.js";
import { loadDriver } from "../drivers/service.js";
import { ApiError, notFound } from "../http/errors.js";
import { API_PREFIX } from "../http/prefix.js";
import { parseBody } from "../http/validate.js";
import { audit } from "./audit.js";
import { riderInZones, zonesOf } from "./lists.js";

/**
 * contract v0.18.54 §76 (owner 2026-11-09 Q40 / Q41, contract.json#adminMasking.reveal, .sosReveal): Reveal with a
 * reason — the full phone, e-mail and date of birth of one rider / driver, the owner e-mail of one fleet — for any
 * admin who may read that person, in the admin's zones, audited with the reason and never the values; and one click
 * on an OPEN safety case that reveals the rider's and the driver's numbers (incident.reveal_contacts). Like
 * POST /admin/trips/{tripId}/reveal-contact none of these answers is kept by the idempotency layer (it would store
 * the numbers): every call is a new read and a new audit row.
 */

export type RevealDeps = { db: Db; jwtSecret: string; clock?: () => Date };

const ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const reasonRequired = () => new ApiError("invalid_request", "Write why you need to see these values (3–200 characters).", { reason: "reason_required" });

/** `reason` 3–200 characters, else 400 invalid_request / reason_required (never a generic body error). */
function revealReason(raw: unknown): string {
  const body = (raw ?? {}) as { reason?: unknown };
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reason.length < 3 || reason.length > 200) throw reasonRequired();
  return reason;
}

export async function revealRider(trx: Trx, who: Principal, riderId: string, reason: string, now: Date) {
  const row = await trx.selectFrom("riders").select(["rider_id", "phone", "email"]).where("rider_id", "=", riderId).executeTakeFirst();
  if (!row) throw notFound("No such rider.", "rider_not_found");
  const zones = zonesOf(who);
  if (zones) {
    const seen = await trx.selectFrom("riders").select("rider_id").where("rider_id", "=", riderId).where(riderInZones(zones)).executeTakeFirst();
    if (!seen) throw new ApiError("forbidden", "This rider has not ridden in your zones.", { reason: "zone_out_of_scope" });
  }
  await audit(trx, { adminId: who.subjectId, action: "rider.reveal", targetType: "rider", targetId: riderId, detail: { reason }, at: now });
  return { riderId: row.rider_id, phone: row.phone, ...(row.email ? { email: row.email } : {}), revealedAt: now.toISOString() };
}

export async function revealDriver(trx: Trx, who: Principal, driverId: string, reason: string, now: Date) {
  const row = await loadDriver(trx, driverId);
  if (!who.zones.includes("*") && !row.zone_ids.some((z) => adminCoversZone(who, z))) throw new ApiError("forbidden", "This driver is outside your zones.", { reason: "zone_out_of_scope" });
  const dob = row.date_of_birth;
  await audit(trx, { adminId: who.subjectId, action: "driver.reveal", targetType: "driver", targetId: driverId, zoneId: row.zone_ids[0] ?? null, detail: { reason }, at: now });
  return {
    driverId: row.driver_id,
    ...(row.phone ? { phone: row.phone } : {}),
    ...(row.email ? { email: row.email } : {}),
    ...(dob ? { dateOfBirth: dob instanceof Date ? dob.toISOString().slice(0, 10) : String(dob) } : {}),
    revealedAt: now.toISOString(),
  };
}

export async function revealFleet(trx: Trx, who: Principal, fleetId: string, reason: string, now: Date) {
  const fleet = await loadFleet(trx, fleetId);
  coversFleet(who, fleet);
  const owner = await trx.selectFrom("drivers").select("email").where("driver_id", "=", fleet.owner_driver_id).executeTakeFirstOrThrow();
  await audit(trx, { adminId: who.subjectId, action: "fleet.reveal", targetType: "fleet", targetId: fleetId, zoneId: fleet.zone_id, detail: { reason }, at: now });
  return { fleetId: fleet.fleet_id, ownerEmail: owner.email ?? "", revealedAt: now.toISOString() };
}

/** Both numbers of an open SOS (owner Q41 "Yes, logged"): null for a side without an account; phone null when the record has none. */
export async function revealIncidentContacts(trx: Trx, who: Principal, incidentId: string, reason: string, now: Date) {
  const incident = await trx.selectFrom("incidents").select(["incident_id", "zone_id", "driver_id", "rider_id", "status"]).where("incident_id", "=", incidentId).executeTakeFirst();
  if (!incident) throw notFound("No such incident.", "incident_not_found");
  if (!who.zones.includes("*") && (incident.zone_id === null || !adminCoversZone(who, incident.zone_id))) {
    throw new ApiError("forbidden", "This incident is outside your zones.", { reason: "zone_out_of_scope" });
  }
  if (incident.status !== "open" && incident.status !== "investigating") {
    throw new ApiError("invalid_transition", "The numbers are shown only while the safety case is open.", { reason: "incident_closed" });
  }
  const rider = incident.rider_id ? await trx.selectFrom("riders").select("phone").where("rider_id", "=", incident.rider_id).executeTakeFirst() : undefined;
  const driver = incident.driver_id ? await trx.selectFrom("drivers").select("phone").where("driver_id", "=", incident.driver_id).executeTakeFirst() : undefined;
  await audit(trx, { adminId: who.subjectId, action: "incident.reveal_contacts", targetType: "incident", targetId: incident.incident_id, zoneId: incident.zone_id, detail: { reason }, at: now });
  return {
    incidentId: incident.incident_id,
    rider: rider ? { phone: rider.phone || null } : null,
    driver: driver ? { phone: driver.phone || null } : null,
    revealedAt: now.toISOString(),
  };
}

export async function revealRoutes(app: FastifyInstance, deps: RevealDeps): Promise<void> {
  const guard = { db: deps.db, jwtSecret: deps.jwtSecret, ...(deps.clock ? { clock: deps.clock } : {}) };
  const now = () => deps.clock?.() ?? new Date();
  const param = (request: FastifyRequest, name: string) => (parseBody(z.object({ [name]: ID }), request.params) as Record<string, string>)[name]!;

  app.post(`${API_PREFIX}/admin/riders/:riderId/reveal`, async (request) => {
    const who = await authenticateAdmin(request, guard, "riders.read");
    const riderId = param(request, "riderId");
    const reason = revealReason(request.body);
    return deps.db.transaction().execute((trx) => revealRider(trx, who, riderId, reason, now()));
  });
  app.post(`${API_PREFIX}/admin/drivers/:driverId/reveal`, async (request) => {
    const who = await authenticateAdmin(request, guard, "drivers.read");
    const driverId = param(request, "driverId");
    const reason = revealReason(request.body);
    return deps.db.transaction().execute((trx) => revealDriver(trx, who, driverId, reason, now()));
  });
  app.post(`${API_PREFIX}/admin/fleets/:fleetId/reveal`, async (request) => {
    const who = await authenticateAdmin(request, guard, "drivers.read");
    const fleetId = param(request, "fleetId");
    const reason = revealReason(request.body);
    return deps.db.transaction().execute((trx) => revealFleet(trx, who, fleetId, reason, now()));
  });
  // `reason` defaults to "SOS" (1–200 characters when sent).
  app.post(`${API_PREFIX}/admin/incidents/:incidentId/reveal-contacts`, async (request) => {
    const who = await authenticateAdmin(request, guard, "incidents.read");
    const incidentId = param(request, "incidentId");
    const body = parseBody(z.object({ reason: z.string().trim().min(1).max(200).optional() }), request.body ?? {});
    return deps.db.transaction().execute((trx) => revealIncidentContacts(trx, who, incidentId, body.reason ?? "SOS", now()));
  });
}
