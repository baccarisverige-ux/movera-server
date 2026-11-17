import "./schema.js";
import { sql } from "kysely";
import type { Executor, Trx } from "../db/db.js";
import { ApiError, badRequest, notFound } from "../http/errors.js";
import { newId } from "../ids.js";
import { adminCoversZone, type Principal } from "../auth/guard.js";
import { audit } from "../admin/audit.js";
import { contract } from "../contract/contract.js";
import { riderInZones, zonesOf } from "../admin/lists.js";
import { COUNTRY_LIMITS, countryLimitsFor, countryOfPhone } from "../config/countryLimits.js";

/**
 * BASE B13 (contract v0.18.26 §47, contract.json#phoneDataToServer; owner 2026-11-03 "Phone-only data: Yes, all to
 * server"): the rider's saved places, the driver's ride preferences and emergency contacts. Every function takes the
 * owner's own id from the signed-in token, so nobody reads or changes another person's rows; an admin reads a driver's
 * emergency contacts only through one of his safety incidents, and that read is audited.
 */

/**
 * Owner 2026-11-04: the limits are an admin setting per country, per person (contract.json#countryLimits
 * savedPlacesPerPerson, emergencyContactsPerPerson; defaults 50 and 10). The bodies are capped at the ranges' top.
 */
export const MAX_PLACES_CAP: number = COUNTRY_LIMITS.ranges.savedPlacesPerPerson[1];
export const MAX_CONTACTS_CAP: number = COUNTRY_LIMITS.ranges.emergencyContactsPerPerson[1];
void contract;

async function riderCountry(ex: Executor, riderId: string): Promise<string | null> {
  const row = await ex.selectFrom("riders").select("phone").where("rider_id", "=", riderId).executeTakeFirst();
  return row?.phone ? countryOfPhone(row.phone) : null;
}
export async function driverCountry(ex: Executor, driverId: string): Promise<string | null> {
  const row = await ex.selectFrom("drivers").select(["country", "phone"]).where("driver_id", "=", driverId).executeTakeFirst();
  return row?.country ?? (row?.phone ? countryOfPhone(row.phone) : null);
}

export type PlaceInput = { label: string; kind: "home" | "work" | "other"; type?: string | undefined; place: { address: string; lat?: number | undefined; lng?: number | undefined } };
/** v0.18.116 §94: shareTrips = "Share trips with this contact" (rider lists only; contract.json#shareTrip.contacts). */
export type ContactInput = { name: string; phone: string; relation?: string | undefined; shareTrips?: boolean | undefined };

type PlaceRow = { place_id: string; kind: "home" | "work" | "other"; type: string | null; label: string; address: string; lat: number | null; lng: number | null; created_at: Date; updated_at: Date };

const placeView = (r: PlaceRow) => ({
  placeId: r.place_id,
  label: r.label,
  kind: r.kind,
  ...(r.type !== null ? { type: r.type } : {}),
  place: { address: r.address, ...(r.lat !== null && r.lng !== null ? { lat: r.lat, lng: r.lng } : {}) },
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

const PLACE_COLUMNS = ["place_id", "kind", "type", "label", "address", "lat", "lng", "created_at", "updated_at"] as const;

export async function listPlaces(ex: Executor, riderId: string) {
  const rows = await ex.selectFrom("rider_places").select(PLACE_COLUMNS).where("rider_id", "=", riderId)
    // Home, then Work, then the others in the order they were saved.
    .orderBy(sql`CASE kind WHEN 'home' THEN 0 WHEN 'work' THEN 1 ELSE 2 END`)
    .orderBy("created_at")
    .orderBy("place_id")
    .execute();
  return { items: rows.map(placeView), nextCursor: null };
}

const values = (p: PlaceInput) => ({
  kind: p.kind,
  type: p.kind === "other" ? (p.type ?? null) : null,
  label: p.label.trim(),
  address: p.place.address.trim(),
  lat: p.place.lat !== undefined && p.place.lng !== undefined ? p.place.lat : null,
  lng: p.place.lat !== undefined && p.place.lng !== undefined ? p.place.lng : null,
});

/** POST: home / work replace the one there (same placeId); other is added while under MAX_PLACES. */
export async function savePlace(trx: Trx, riderId: string, input: PlaceInput, now: Date) {
  // One rider's writes in a row, so two saves at once cannot pass the limit or make two homes.
  await trx.selectFrom("riders").select("rider_id").where("rider_id", "=", riderId).forUpdate().executeTakeFirstOrThrow();
  const v = values(input);
  if (v.label === "" || v.address === "") throw badRequest("A place needs a name and an address.", "place_incomplete");
  if (v.kind !== "other") {
    const old = await trx.selectFrom("rider_places").select("place_id").where("rider_id", "=", riderId).where("kind", "=", v.kind).executeTakeFirst();
    if (old) {
      const row = await trx.updateTable("rider_places").set({ ...v, updated_at: now }).where("place_id", "=", old.place_id).returning(PLACE_COLUMNS).executeTakeFirstOrThrow();
      return placeView(row);
    }
  }
  const count = await trx.selectFrom("rider_places").select((eb) => eb.fn.countAll<string>().as("n")).where("rider_id", "=", riderId).executeTakeFirstOrThrow();
  const max = (await countryLimitsFor(trx, await riderCountry(trx, riderId))).savedPlacesPerPerson;
  if (Number(count.n) >= max) throw new ApiError("conflict", `At most ${max} saved places per person.`, { reason: "too_many_places" });
  const row = await trx.insertInto("rider_places").values({ place_id: newId("plc", now.getTime()), rider_id: riderId, ...v, created_at: now, updated_at: now }).returning(PLACE_COLUMNS).executeTakeFirstOrThrow();
  return placeView(row);
}

async function ownPlace(ex: Executor, riderId: string, placeId: string) {
  const row = await ex.selectFrom("rider_places").select(PLACE_COLUMNS).where("place_id", "=", placeId).where("rider_id", "=", riderId).executeTakeFirst();
  // Someone else's place answers exactly like a missing one.
  if (!row) throw notFound("No such saved place.", "place_not_found");
  return row;
}

export async function updatePlace(trx: Trx, riderId: string, placeId: string, input: PlaceInput, now: Date) {
  await trx.selectFrom("riders").select("rider_id").where("rider_id", "=", riderId).forUpdate().executeTakeFirstOrThrow();
  await ownPlace(trx, riderId, placeId);
  const v = values(input);
  if (v.label === "" || v.address === "") throw badRequest("A place needs a name and an address.", "place_incomplete");
  if (v.kind !== "other") {
    // Becoming the home (or work): the old one of that kind goes, so there is still one each.
    await trx.deleteFrom("rider_places").where("rider_id", "=", riderId).where("kind", "=", v.kind).where("place_id", "!=", placeId).execute();
  }
  const row = await trx.updateTable("rider_places").set({ ...v, updated_at: now }).where("place_id", "=", placeId).returning(PLACE_COLUMNS).executeTakeFirstOrThrow();
  return placeView(row);
}

export async function deletePlace(trx: Trx, riderId: string, placeId: string) {
  await ownPlace(trx, riderId, placeId);
  await trx.deleteFrom("rider_places").where("place_id", "=", placeId).where("rider_id", "=", riderId).execute();
}

/** The one-time upload of the phone's places: applied the first time only; places past the country limit are dropped. */
export async function importPlaces(trx: Trx, riderId: string, items: PlaceInput[], now: Date) {
  await trx.selectFrom("riders").select("rider_id").where("rider_id", "=", riderId).forUpdate().executeTakeFirstOrThrow();
  const done = await trx.selectFrom("rider_places_imported").select("rider_id").where("rider_id", "=", riderId).executeTakeFirst();
  if (!done) {
    for (const [index, item] of items.entries()) {
      try {
        // One millisecond apart, so the list keeps the phone's order.
        await savePlace(trx, riderId, item, new Date(now.getTime() + index));
      } catch (error) {
        if (error instanceof ApiError && ((error.options.reason === "too_many_places" || error.options.reason === "place_incomplete"))) continue;
        throw error;
      }
    }
    await trx.insertInto("rider_places_imported").values({ rider_id: riderId, imported_at: now }).execute();
  }
  return listPlaces(trx, riderId);
}

/* ------------------------------------------------------------------ driver */

const ensureRow = (trx: Trx, driverId: string) =>
  trx.insertInto("driver_phone_data").values({ driver_id: driverId }).onConflict((c) => c.column("driver_id").doNothing()).execute();

export async function driverPreferences(ex: Executor, driverId: string) {
  const row = await ex.selectFrom("driver_phone_data").select(["categories_off", "preferences_at"]).where("driver_id", "=", driverId).executeTakeFirst();
  return { categoriesOff: row?.categories_off ?? [], updatedAt: row?.preferences_at?.toISOString() ?? null };
}

export async function saveDriverPreferences(trx: Trx, driverId: string, categoriesOff: string[], now: Date) {
  const off = [...new Set(categoriesOff)];
  if (off.length) {
    const known = await trx.selectFrom("categories").select("category_id").where("category_id", "in", off).execute();
    const unknown = off.filter((c) => !known.some((k) => k.category_id === c));
    if (unknown.length) throw new ApiError("invalid_request", "Unknown ride category.", { reason: "unknown_category", details: unknown });
  }
  await ensureRow(trx, driverId);
  await trx.updateTable("driver_phone_data").set({ categories_off: off, preferences_at: now }).where("driver_id", "=", driverId).execute();
  return driverPreferences(trx, driverId);
}

const contactsOf = (raw: unknown): ContactInput[] => (Array.isArray(raw) ? (raw as ContactInput[]) : []);

export async function driverContacts(ex: Executor, driverId: string) {
  const row = await ex.selectFrom("driver_phone_data").select(["emergency_contacts", "contacts_at"]).where("driver_id", "=", driverId).executeTakeFirst();
  return { items: contactsOf(row?.emergency_contacts), updatedAt: row?.contacts_at?.toISOString() ?? null };
}

/** Owner 2026-11-04 "Yes, same as drivers": the rider's own emergency contacts. */
export async function riderContacts(ex: Executor, riderId: string) {
  const row = await ex.selectFrom("rider_phone_data").select(["emergency_contacts", "contacts_at"]).where("rider_id", "=", riderId).executeTakeFirst();
  return { items: contactsOf(row?.emergency_contacts), updatedAt: row?.contacts_at?.toISOString() ?? null };
}

async function cleanContacts(ex: Executor, country: string | null, items: ContactInput[], keepShareTrips = false) {
  const max = (await countryLimitsFor(ex, country)).emergencyContactsPerPerson;
  if (items.length > max) throw badRequest(`At most ${max} emergency contacts per person.`, "too_many_contacts");
  // v0.18.116 §94: the rider's list keeps shareTrips (true / false); a driver's list never holds it.
  const clean = items.map((c) => ({ name: c.name.trim(), phone: c.phone, ...(c.relation?.trim() ? { relation: c.relation.trim() } : {}), ...(keepShareTrips && typeof c.shareTrips === "boolean" ? { shareTrips: c.shareTrips } : {}) }));
  if (clean.some((c) => c.name === "")) throw badRequest("Every contact needs a name.", "contact_incomplete");
  return clean;
}

export async function saveDriverContacts(trx: Trx, driverId: string, items: ContactInput[], now: Date) {
  const clean = await cleanContacts(trx, await driverCountry(trx, driverId), items);
  await ensureRow(trx, driverId);
  await trx.updateTable("driver_phone_data").set({ emergency_contacts: JSON.stringify(clean), contacts_at: now }).where("driver_id", "=", driverId).execute();
  return driverContacts(trx, driverId);
}

export async function saveRiderContacts(trx: Trx, riderId: string, items: ContactInput[], now: Date) {
  const clean = await cleanContacts(trx, await riderCountry(trx, riderId), items, true);
  await trx.insertInto("rider_phone_data").values({ rider_id: riderId, emergency_contacts: JSON.stringify(clean), contacts_at: now })
    .onConflict((c) => c.column("rider_id").doUpdateSet({ emergency_contacts: JSON.stringify(clean), contacts_at: now })).execute();
  return riderContacts(trx, riderId);
}

/** Admin, read-only: the emergency contacts of the incident's driver, in the admin's zones, written to the audit. */
export async function incidentEmergencyContacts(trx: Trx, who: Principal, incidentId: string, now: Date) {
  const incident = await trx.selectFrom("incidents").select(["incident_id", "zone_id", "driver_id", "rider_id", "status"]).where("incident_id", "=", incidentId).executeTakeFirst();
  if (!incident) throw notFound("No such incident.", "incident_not_found");
  if (!who.zones.includes("*") && (incident.zone_id === null || !adminCoversZone(who, incident.zone_id))) {
    throw new ApiError("forbidden", "This incident is outside your zones.", { reason: "zone_out_of_scope" });
  }
  // Owner 2026-11-04 "Yes, during a safety case": only while the case is open (open or being worked on).
  if (incident.status !== "open" && incident.status !== "investigating") {
    throw new ApiError("invalid_transition", "Emergency contacts are shown only while the safety case is open.", { reason: "incident_closed" });
  }
  const contacts = incident.driver_id ? await driverContacts(trx, incident.driver_id) : { items: [], updatedAt: null };
  // Owner 2026-11-04 "Yes, same as drivers": the rider's contacts of the same open case.
  const rider = incident.rider_id ? { riderId: incident.rider_id, ...(await riderContacts(trx, incident.rider_id)) } : null;
  // Who looked, when and at which incident; never the names or numbers.
  await audit(trx, { adminId: who.subjectId, action: "incident.emergency_contacts_viewed", targetType: "incident", targetId: incident.incident_id, zoneId: incident.zone_id, detail: { driverId: incident.driver_id, riderId: incident.rider_id, count: contacts.items.length + (rider?.items.length ?? 0) }, at: now });
  return { incidentId: incident.incident_id, driverId: incident.driver_id, ...contacts, rider };
}

/** Dispatch (contract.json#phoneDataToServer.driverPreferences.dispatch): drivers who switched [categoryId] off. */
export async function driversWithCategoryOff(ex: Executor, driverIds: string[], categoryId: string): Promise<Set<string>> {
  if (driverIds.length === 0) return new Set();
  const rows = await ex.selectFrom("driver_phone_data").select("driver_id").where("driver_id", "in", driverIds).where(sql<boolean>`${categoryId} = ANY(categories_off)`).execute();
  return new Set(rows.map((r) => r.driver_id));
}

/* ---------------------------------------------------- admin profile pages */

/** Owner 2026-11-04 "Read-only on profile": a rider's saved places on his admin page (riders.read), audited. */
export async function adminRiderPlaces(trx: Trx, who: Principal, riderId: string, now: Date) {
  const zones = zonesOf(who);
  let q = trx.selectFrom("riders").select("rider_id").where("rider_id", "=", riderId);
  if (zones) q = q.where(riderInZones(zones));
  if (!(await q.executeTakeFirst())) {
    const exists = await trx.selectFrom("riders").select("rider_id").where("rider_id", "=", riderId).executeTakeFirst();
    if (!exists) throw notFound("No such rider.", "rider_not_found");
    throw new ApiError("forbidden", "This rider has not ridden in your zones.", { reason: "zone_out_of_scope" });
  }
  const page = await listPlaces(trx, riderId);
  await audit(trx, { adminId: who.subjectId, action: "rider.saved_places_viewed", targetType: "rider", targetId: riderId, detail: { count: page.items.length }, at: now });
  return { riderId, items: page.items };
}

/** Owner 2026-11-04 "Read-only on profile": a driver's ride preferences on his admin page (drivers.read), audited. */
export async function adminDriverPreferences(trx: Trx, who: Principal, driverId: string, now: Date) {
  const row = await trx.selectFrom("drivers").select(["driver_id", "zone_ids"]).where("driver_id", "=", driverId).executeTakeFirst();
  if (!row) throw notFound("No such driver.", "driver_not_found");
  if (!who.zones.includes("*") && !row.zone_ids.some((z) => adminCoversZone(who, z))) throw new ApiError("forbidden", "This driver is outside your zones.", { reason: "zone_out_of_scope" });
  const prefs = await driverPreferences(trx, driverId);
  await audit(trx, { adminId: who.subjectId, action: "driver.preferences_viewed", targetType: "driver", targetId: driverId, detail: { count: prefs.categoriesOff.length }, at: now });
  return { driverId, ...prefs };
}
