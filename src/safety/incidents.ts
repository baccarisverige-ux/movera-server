import { sql, type Selectable } from "kysely";
import { adminCoversZone, type Principal } from "../auth/guard.js";
import { contract } from "../contract/contract.js";
import type { Executor, Trx } from "../db/db.js";
import type { IncidentsTable } from "../db/schema.js";
import { audit } from "../admin/audit.js";
import { firstPageTotal, totalAfterPage, withTotal } from "../admin/listTotal.js";
import { ApiError, badRequest, notFound } from "../http/errors.js";
import { newId } from "../ids.js";
import { scheduleTimer, type TimerHandler } from "../jobs/timers.js";
import { ALERT_SWEEP, alertSweepHandler, pokeAlerts } from "../alerts/detector.js";
import { tripProjection } from "../trips/projection.js";
import { lockTrip, type TripRow } from "../db/tripLog.js";
import { writeSosSms, type SosContactsSms } from "./sosContactsSms.js";

/**
 * SOS and incidents (contract v0.7.0 §15, owner safety part 1 decisions 2026-10-27).
 *
 *  - The rider's or the driver's SOS opens the trip's one open `sos` incident (or returns it), with the phone's GPS
 *    and the car's latest position. The app has already opened the 112 call; afterwards it shows only "SOS sent".
 *  - The server's "car lost" alert (trips/ride.ts, driver silent 30 min with the rider on board) opens a
 *    `driver_silent` incident, and closes it itself (resolved, "position back") when positions come back.
 *  - Admins take, solve or dismiss (false alarm). Every change appends one event to the admin feed
 *    (incident_events, GET /admin/incidents/stream): first for the zone's admins with incidents.read; after
 *    escalateAfterSeconds without anyone taking it, for every signed-in admin.
 */

type Safety = {
  kindSeverity: Record<string, "low" | "medium" | "high" | "critical">;
  escalateAfterSeconds: number;
  alarmKinds: string[];
  sos: { riderStatuses: string[]; driverStatuses: string[] };
  driverSilent: { systemResolution: string };
};
export const SAFETY = (contract as unknown as { safety: Safety }).safety;
export const ESCALATE_MS = SAFETY.escalateAfterSeconds * 1000;
export const INCIDENT_ESCALATE = "incident_escalate";
/** The channel the admin incident feeds LISTEN on ({ sequence }). */
export const INCIDENT_EVENTS_CHANNEL = "movera_incident_events";
/** Serialises incident event numbering, so the feed has no gaps a reader could skip over. */
const EVENT_LOCK = 73_310_015;

export type IncidentRow = Selectable<IncidentsTable>;
type EventKind = "incident_opened" | "incident_updated" | "incident_escalated" | "incident_closed";
type Position = { lat: number; lng: number; accuracyM?: number; at: string };

const OPEN = ["open", "investigating"] as const;
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : undefined);

function geoFix(row: { lat: number; lng: number; accuracy: number; heading: number | null; speed_mps: number | null; moving: boolean; measured_at: Date }) {
  return {
    lat: row.lat,
    lng: row.lng,
    accuracy: row.accuracy,
    ...(row.heading !== null ? { heading: row.heading } : {}),
    ...(row.speed_mps !== null ? { speedMps: row.speed_mps } : {}),
    moving: row.moving,
    measuredAt: row.measured_at.toISOString(),
  };
}

async function latestFix(ex: Executor, driverId: string | null) {
  if (!driverId) return undefined;
  const row = await ex.selectFrom("driver_locations").selectAll().where("driver_id", "=", driverId).executeTakeFirst();
  return row ? geoFix(row) : undefined;
}

/** B1.26: the live positions of a page's drivers in one read (driver_locations is keyed by driver_id); none → no statement. */
async function latestFixes(ex: Executor, driverIds: (string | null)[]) {
  const ids = [...new Set(driverIds.filter((id): id is string => id !== null))];
  const fixes = new Map<string, ReturnType<typeof geoFix>>();
  if (!ids.length) return fixes;
  for (const row of await ex.selectFrom("driver_locations").selectAll().where("driver_id", "in", ids).execute()) fixes.set(row.driver_id, geoFix(row));
  return fixes;
}

/** contract Incident. `driverPosition` is the car's live position when given, else the one kept at opening. */
export function incidentView(row: IncidentRow, driverPosition?: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {
    incidentId: row.incident_id,
    kind: row.kind,
    severity: row.severity,
    status: row.status,
    version: row.version,
    reportedBy: row.raised_by === "system" ? "system" : row.raised_by,
    raisedBy: row.raised_by,
    openedAt: row.opened_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    alarm: row.alarm,
  };
  const optional: Record<string, unknown> = {
    tripId: row.trip_id ?? undefined,
    zoneId: row.zone_id ?? undefined,
    riderId: row.rider_id ?? undefined,
    driverId: row.driver_id ?? undefined,
    position: row.position ?? undefined,
    driverPosition: driverPosition ?? row.driver_fix ?? undefined,
    escalatedAt: iso(row.escalated_at),
    takenBy: row.taken_by ?? undefined,
    takenAt: iso(row.taken_at),
    resolvedBy: row.resolved_by ?? undefined,
    resolvedAt: iso(row.resolved_at),
    resolution: row.resolution ?? undefined,
    rideCheck: row.ride_check ?? undefined,
    // v0.18.101 §92: the SMS to the driver's emergency contacts of this case.
    contactsSms: row.contacts_sms ?? undefined,
  };
  for (const [k, v] of Object.entries(optional)) if (v !== undefined) out[k] = v;
  return out;
}

export async function appendIncidentEvent(trx: Trx, row: IncidentRow, kind: EventKind, now: Date): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(${EVENT_LOCK})`.execute(trx);
  const next = await trx.selectFrom("incident_events").select(sql<string>`coalesce(max(sequence), 0) + 1`.as("n")).executeTakeFirstOrThrow();
  const sequence = Number(next.n);
  await trx
    .insertInto("incident_events")
    .values({ sequence, event_id: newId("evt", now.getTime()), incident_id: row.incident_id, kind, zone_id: row.zone_id, incident: JSON.stringify(incidentView(row, await latestFix(trx, row.driver_id))), occurred_at: now })
    .execute();
  await sql`SELECT pg_notify(${INCIDENT_EVENTS_CHANNEL}, ${JSON.stringify({ sequence })})`.execute(trx);
}

export async function openIncident(
  trx: Trx,
  trip: TripRow,
  input: { kind: string; raisedBy: "rider" | "driver" | "system"; position?: Position | undefined; alarm?: boolean; rideCheck?: Record<string, unknown> },
  now: Date,
): Promise<IncidentRow> {
  const driverFix = await latestFix(trx, trip.driver_id);
  const row = await trx
    .insertInto("incidents")
    .values({
      incident_id: newId("inc", now.getTime()),
      trip_id: trip.trip_id,
      kind: input.kind,
      severity: SAFETY.kindSeverity[input.kind] ?? "critical",
      raised_by: input.raisedBy,
      zone_id: trip.zone_id,
      rider_id: trip.rider_id,
      driver_id: trip.driver_id,
      position: input.position ? JSON.stringify(input.position) : null,
      driver_fix: driverFix ? JSON.stringify(driverFix) : null,
      alarm: input.alarm ?? true,
      ride_check: input.rideCheck ? JSON.stringify(input.rideCheck) : null,
      opened_at: now,
      updated_at: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await appendIncidentEvent(trx, row, "incident_opened", now);
  if (row.alarm && SAFETY.alarmKinds.includes(input.kind)) await scheduleTimer(trx, { kind: INCIDENT_ESCALATE, refId: row.incident_id, dueAt: new Date(now.getTime() + ESCALATE_MS) });
  // v0.18.23: the admin alert (SOS, car lost, ride check) is found at once, not at the next 30 s sweep.
  await pokeAlerts(trx, now);
  await audit(trx, { adminId: null, action: "incident.open", targetType: "incident", targetId: row.incident_id, zoneId: row.zone_id, detail: { kind: row.kind, raisedBy: row.raised_by, tripId: row.trip_id }, at: now });
  return row;
}

export async function openOf(ex: Executor, tripId: string, kind: string): Promise<IncidentRow | undefined> {
  return ex.selectFrom("incidents").selectAll().where("trip_id", "=", tripId).where("kind", "=", kind).where("status", "in", [...OPEN]).executeTakeFirst();
}

/* ---------------------------------------------------------------- SOS */

export async function raiseSos(
  trx: Trx,
  who: { actor: "rider" | "driver"; subjectId: string },
  tripId: string,
  body: { at: string; position?: Position | undefined },
  now: Date,
  sms: { connected: boolean; queued?: string[]; warn?: (data: Record<string, unknown>, message: string) => void } = { connected: false },
) {
  const trip = await lockTrip(trx, tripId);
  const own = who.actor === "rider" ? trip.rider_id === who.subjectId : trip.driver_id === who.subjectId;
  if (!own) throw notFound("No such trip.", "trip_not_found");
  const live = who.actor === "rider" ? SAFETY.sos.riderStatuses : SAFETY.sos.driverStatuses;
  if (!live.includes(trip.status)) {
    throw new ApiError("invalid_transition", "SOS works only during a live trip.", { reason: "trip_not_live", projection: tripProjection(trip, who.actor) });
  }
  const row = (await openOf(trx, tripId, "sos")) ?? (await openIncident(trx, trip, { kind: "sos", raisedBy: who.actor, position: body.position }, now));
  if (who.actor === "rider") return { incidentId: row.incident_id, tripId, receivedAt: now.toISOString() };
  // v0.18.101 §92: the case's first driver SOS texts his emergency contacts (rows kept as skipped while no SMS company
  // is connected); later SOS answer the stored result. The SMS step never fails the SOS (own savepoint).
  let contactsSms = row.contacts_sms as SosContactsSms | null;
  if (contactsSms === null) {
    const written = await writeSosSms(trx, row, body.position ?? null, sms.connected, now, sms.warn);
    contactsSms = written.result;
    sms.queued?.push(...written.queued);
    await appendIncidentEvent(trx, { ...row, contacts_sms: contactsSms }, "incident_updated", now);
  }
  return { incidentId: row.incident_id, tripId, receivedAt: now.toISOString(), contactsSms };
}

/* ---------------------------------------------------------------- car lost (driver silent) */

/** The car-lost alert went up on the trip: open its driver_silent incident (once). */
export async function openDriverSilent(trx: Trx, trip: TripRow, now: Date): Promise<void> {
  if (await openOf(trx, trip.trip_id, "driver_silent")) return;
  await openIncident(trx, trip, { kind: "driver_silent", raisedBy: "system" }, now);
}

/** Positions came back: the open driver_silent incident closes itself. */
export async function closeDriverSilent(trx: Trx, tripId: string, now: Date): Promise<void> {
  const open = await openOf(trx, tripId, "driver_silent");
  if (!open) return;
  const row = await trx
    .updateTable("incidents")
    .set({ status: "resolved", version: sql`version + 1`, resolved_at: now, resolution: SAFETY.driverSilent.systemResolution, updated_at: now })
    .where("incident_id", "=", open.incident_id)
    .returningAll()
    .executeTakeFirstOrThrow();
  await appendIncidentEvent(trx, row, "incident_closed", now);
  await audit(trx, { adminId: null, action: "incident.resolve", targetType: "incident", targetId: row.incident_id, zoneId: row.zone_id, detail: { by: "system", resolution: row.resolution }, at: now });
}

/** Two minutes untaken: every signed-in admin is alerted from now on. */
export const escalateHandler: TimerHandler = async (trx, timer) => {
  const row = await trx.selectFrom("incidents").selectAll().where("incident_id", "=", timer.refId).forUpdate().executeTakeFirst();
  if (!row || row.status !== "open" || row.escalated_at || !row.alarm) return;
  const updated = await trx.updateTable("incidents").set({ escalated_at: timer.firedAt, updated_at: timer.firedAt }).where("incident_id", "=", row.incident_id).returningAll().executeTakeFirstOrThrow();
  await appendIncidentEvent(trx, updated, "incident_escalated", timer.firedAt);
};

// v0.18.23: the alert sweep rides along with the incident timers, so every worker that runs incidents also runs it.
export const incidentHandlers: Record<string, TimerHandler> = { [INCIDENT_ESCALATE]: escalateHandler, [ALERT_SWEEP]: alertSweepHandler };

/* ---------------------------------------------------------------- admin */

function checkZone(who: Principal, row: IncidentRow) {
  if (who.zones.includes("*")) return;
  if (row.zone_id === null || !adminCoversZone(who, row.zone_id)) throw new ApiError("forbidden", "This incident is outside your zones.", { reason: "zone_out_of_scope" });
}

export async function adminIncident(ex: Executor, who: Principal, incidentId: string) {
  const row = await ex.selectFrom("incidents").selectAll().where("incident_id", "=", incidentId).executeTakeFirst();
  if (!row) throw notFound("No such incident.", "incident_not_found");
  checkZone(who, row);
  return incidentView(row, await latestFix(ex, row.driver_id));
}

const MOVES = { take: { from: ["open"], to: "investigating" }, resolve: { from: ["open", "investigating"], to: "resolved" }, dismiss: { from: ["open", "investigating"], to: "dismissed" } } as const;
export type IncidentCommand = keyof typeof MOVES;

export async function adminIncidentCommand(trx: Trx, who: Principal, incidentId: string, command: IncidentCommand, body: { expectedVersion: number; note?: string | undefined }, now: Date) {
  const row = await trx.selectFrom("incidents").selectAll().where("incident_id", "=", incidentId).forUpdate().executeTakeFirst();
  if (!row) throw notFound("No such incident.", "incident_not_found");
  checkZone(who, row);
  const view = async () => incidentView(row, await latestFix(trx, row.driver_id));
  if (body.expectedVersion !== row.version) throw new ApiError("version_mismatch", "The incident changed since you last saw it.", { projection: await view() });
  const move = MOVES[command];
  if (!(move.from as readonly string[]).includes(row.status)) {
    throw new ApiError("invalid_transition", `An incident that is ${row.status} cannot be ${command === "take" ? "taken" : command === "resolve" ? "solved" : "dismissed"}.`, { projection: await view() });
  }
  const closing = command !== "take";
  const updated = await trx
    .updateTable("incidents")
    .set({
      status: move.to,
      version: sql`version + 1`,
      updated_at: now,
      ...(command === "take" ? { taken_by: who.subjectId, taken_at: now } : {}),
      ...(closing ? { resolved_by: who.subjectId, resolved_at: now, resolution: body.note ?? null } : {}),
    })
    .where("incident_id", "=", row.incident_id)
    .returningAll()
    .executeTakeFirstOrThrow();
  await appendIncidentEvent(trx, updated, closing ? "incident_closed" : "incident_updated", now);
  await audit(trx, { adminId: who.subjectId, action: `incident.${command}`, targetType: "incident", targetId: row.incident_id, zoneId: row.zone_id, detail: { from: row.status, to: move.to, ...(body.note ? { note: body.note } : {}) }, at: now });
  return incidentView(updated, await latestFix(trx, updated.driver_id));
}

/** v0.18.9 (contract.json#onTrip.adminTrip.new.incidentLevel): the admin changes an incident's level (severity). */
export async function adminIncidentLevel(trx: Trx, who: Principal, incidentId: string, body: { expectedVersion: number; severity: "low" | "medium" | "high" | "critical"; note?: string | undefined }, now: Date) {
  const row = await trx.selectFrom("incidents").selectAll().where("incident_id", "=", incidentId).forUpdate().executeTakeFirst();
  if (!row) throw notFound("No such incident.", "incident_not_found");
  checkZone(who, row);
  if (body.expectedVersion !== row.version) throw new ApiError("version_mismatch", "The incident changed since you last saw it.", { projection: incidentView(row, await latestFix(trx, row.driver_id)) });
  if (row.severity === body.severity) return incidentView(row, await latestFix(trx, row.driver_id));
  const updated = await trx.updateTable("incidents").set({ severity: body.severity, version: sql`version + 1`, updated_at: now }).where("incident_id", "=", incidentId).returningAll().executeTakeFirstOrThrow();
  await appendIncidentEvent(trx, updated, "incident_updated", now);
  await audit(trx, { adminId: who.subjectId, action: "incident.level", targetType: "incident", targetId: incidentId, zoneId: row.zone_id, detail: { from: row.severity, to: body.severity, ...(body.note ? { note: body.note } : {}) }, at: now });
  return incidentView(updated, await latestFix(trx, updated.driver_id));
}

const cursorOf = (at: Date, id: string) => Buffer.from(`${at.toISOString()}|${id}`).toString("base64url");
function readCursor(cursor: string): { at: Date; id: string } {
  const [at, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  if (!at || !id || Number.isNaN(Date.parse(at))) throw badRequest("The cursor is not valid.", "invalid_cursor");
  return { at: new Date(at), id };
}

export type IncidentQuery = { cursor?: string; limit: number; status?: string[]; severity?: string; kind?: string; tripId?: string; driverId?: string; riderId?: string; zoneId?: string; from?: string; to?: string; total?: boolean };

export async function listIncidents(ex: Executor, who: Principal, input: IncidentQuery) {
  let q = ex.selectFrom("incidents").selectAll();
  if (!who.zones.includes("*")) q = q.where("zone_id", "in", who.zones.length ? who.zones : ["-"]);
  if (input.status?.length) q = q.where("status", "in", input.status as never);
  if (input.severity) q = q.where("severity", "=", input.severity as never);
  if (input.kind) q = q.where("kind", "=", input.kind);
  if (input.tripId) q = q.where("trip_id", "=", input.tripId);
  // L78-S (v0.18.78 adminListFilters.incidentsByPerson): one driver's / rider's cases (both: AND), inside the zones above;
  // an id with no case is an empty page. Indexed by migration 0105 (driver_id / rider_id, opened_at, incident_id).
  if (input.driverId) q = q.where("driver_id", "=", input.driverId);
  if (input.riderId) q = q.where("rider_id", "=", input.riderId);
  if (input.zoneId) q = q.where("zone_id", "=", input.zoneId);
  if (input.from) q = q.where("opened_at", ">=", new Date(input.from));
  if (input.to) q = q.where("opened_at", "<", new Date(input.to));
  // L78-S (v0.18.78 adminListFilters.total).
  const filtered = q;
  if (input.cursor) {
    const c = readCursor(input.cursor);
    q = q.where(sql<boolean>`(opened_at, incident_id) < (${c.at}, ${c.id})`);
  }
  const reading = q.orderBy("opened_at", "desc").orderBy("incident_id", "desc").limit(input.limit + 1).execute();
  // The page asked first; the count follows it (L78-S, listTotal.ts).
  const counting = firstPageTotal(ex, filtered, input);
  const rows = await reading;
  const page = rows.slice(0, input.limit);
  const fixes = await latestFixes(ex, page.map((r) => r.driver_id));
  const items = page.map((r) => incidentView(r, r.driver_id ? fixes.get(r.driver_id) : undefined));
  const last = page[page.length - 1];
  return withTotal({ items, nextCursor: rows.length > input.limit && last ? cursorOf(last.opened_at, last.incident_id) : null }, await totalAfterPage(counting));
}

/* ---------------------------------------------------------------- the feed */

/** May this admin see this event? Zone admins with incidents.read first; everyone once it is escalated. */
export function mayHear(who: Principal, incident: Record<string, unknown>): boolean {
  if (typeof incident["escalatedAt"] === "string") return true;
  if (!(who.perms ?? []).includes("incidents.read")) return false;
  if (who.zones.includes("*")) return true;
  return typeof incident["zoneId"] === "string" && who.zones.includes(incident["zoneId"]);
}

export async function incidentEventsAfter(ex: Executor, after: number, limit: number) {
  return ex.selectFrom("incident_events").selectAll().where("sequence", ">", String(after)).orderBy("sequence", "asc").limit(limit).execute();
}

export function eventOf(row: { sequence: string; event_id: string; kind: string; incident: unknown; occurred_at: Date }, now: Date) {
  return { eventId: row.event_id, sequence: Number(row.sequence), kind: row.kind, incident: row.incident, occurredAt: row.occurred_at.toISOString(), serverTime: now.toISOString() };
}
