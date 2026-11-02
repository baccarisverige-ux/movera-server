import { z } from "zod";
import type { Executor, Trx } from "../db/db.js";
import type { Principal } from "../auth/guard.js";
import { ApiError, badRequest, notFound } from "../http/errors.js";
import { parseBody } from "../http/validate.js";
import { reviewDocument } from "../documents/service.js";
import { carRuleProblems, categoryProblem, onboardingSettings, type Fuel } from "../drivers/onboardingSettings.js";
import { vehicleCountry, vehicleDocumentBlockers } from "../drivers/readiness.js";
import { driverView, loadDriver, vehicleFullView, type DriverRow, type VehicleRow } from "../drivers/service.js";
import { audit } from "./audit.js";

/**
 * Contract v0.18.0 (contract.json#driverOnboarding.adminActions; owner rule "every admin item of the group must work
 * on live"): Vehicles › Update and Link driver, Drivers › Category and Bank details. Audited, limited to the admin's
 * zones (checked before the body is read, so an admin outside them always gets 403).
 */

const ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const FUELS = ["petrol", "diesel", "hybrid", "electric"] as const;
const UpdateBody = z.object({
  expectedVersion: z.number().int().min(1),
  make: z.string().min(1).max(80).optional(),
  model: z.string().min(1).max(80).optional(),
  year: z.number().int().min(1950).max(2100).optional(),
  color: z.string().min(1).max(40).optional(),
  plate: z.string().min(1).max(20).optional(),
  seats: z.number().int().min(1).max(20).optional(),
  fuel: z.enum(FUELS).optional(),
  categoryIds: z.array(z.string().min(1).max(40)).max(20).optional(),
});
const LinkBody = z.object({ expectedVersion: z.number().int().min(1), driverId: ID.nullable() });
const CategoriesBody = z.object({ expectedVersion: z.number().int().min(1), categoryIds: z.array(z.string().min(1).max(40)).min(1).max(20) });
const BankBody = z.object({ decision: z.enum(["approved", "rejected"]), note: z.string().max(1000).optional() });

type Car = VehicleRow & { fuel: Fuel | null };
const covers = (who: Principal, zone: string | null | undefined) => who.zones.includes("*") || (zone !== null && zone !== undefined && who.zones.includes(zone));

async function zoneOfCar(ex: Executor, v: { fleet_id: string | null; driver_id: string | null }): Promise<string | null> {
  if (v.fleet_id) return (await ex.selectFrom("fleets").select("zone_id").where("fleet_id", "=", v.fleet_id).executeTakeFirst())?.zone_id ?? null;
  if (v.driver_id) return (await ex.selectFrom("drivers").select("zone_ids").where("driver_id", "=", v.driver_id).executeTakeFirst())?.zone_ids[0] ?? null;
  return null;
}

/** The car, locked, in the admin's zones (404 / 403), with its zone for the audit. */
export async function carInScope(ex: Executor, who: Principal, vehicleId: string, lock = false): Promise<{ car: Car; zone: string | null }> {
  let q = ex.selectFrom("vehicles").selectAll().where("vehicle_id", "=", vehicleId);
  if (lock) q = q.forUpdate();
  const car = (await q.executeTakeFirst()) as unknown as Car | undefined;
  if (car === undefined) throw notFound("No such vehicle.", "vehicle_not_found");
  const zone = await zoneOfCar(ex, car);
  if (!covers(who, zone)) throw new ApiError("forbidden", "This car is outside your zones.", { reason: "zone_out_of_scope" });
  return { car, zone };
}

/** The driver in the admin's zones (404 / 403). */
export async function driverOfAdmin(ex: Executor, who: Principal, driverId: string, lock = false): Promise<DriverRow> {
  const row = await loadDriver(ex, driverId, lock);
  if (!who.zones.includes("*") && !row.zone_ids.some((z) => who.zones.includes(z))) throw new ApiError("forbidden", "This driver is outside your zones.", { reason: "zone_out_of_scope" });
  return row;
}

/** "<category>:<problem>" for each category the car does not fit in its country (none when it has no country). */
async function carProblems(ex: Executor, car: { fleet_id: string | null; driver_id: string | null; year: number; seats: number; fuel: Fuel | null }, categoryIds: string[]): Promise<string[]> {
  const country = await vehicleCountry(ex, car);
  if (!country) return [];
  const settings = await onboardingSettings(ex, country);
  return categoryIds.flatMap((c) => {
    const problem = categoryProblem({ year: car.year, seats: car.seats, fuel: car.fuel }, settings, c);
    return problem === null ? [] : [`${c}:${problem}`];
  });
}

/** v0.18.3 (R2): the whole car against the rules (base year, every category, an extra alone). */
async function wholeCarProblems(ex: Executor, car: { fleet_id: string | null; driver_id: string | null; year: number; seats: number; fuel: Fuel | null }, categoryIds: string[]): Promise<string[]> {
  const country = await vehicleCountry(ex, car);
  if (!country) return [];
  return carRuleProblems({ year: car.year, seats: car.seats, fuel: car.fuel }, await onboardingSettings(ex, country), categoryIds);
}

/** PATCH /admin/vehicles/{vehicleId} (vehicles.edit). */
export async function adminUpdateVehicle(trx: Trx, who: Principal, vehicleId: string, rawBody: unknown, now: Date) {
  const { car, zone } = await carInScope(trx, who, vehicleId, true);
  const body = parseBody(UpdateBody, rawBody);
  if (car.version !== body.expectedVersion) throw new ApiError("version_mismatch", "The car changed since you last saw it.", { projection: await vehicleFullView(trx, car) });
  const next = { year: body.year ?? car.year, seats: body.seats ?? car.seats, fuel: body.fuel ?? car.fuel, category_ids: body.categoryIds ?? car.category_ids };
  const problems = await wholeCarProblems(trx, { ...car, ...next }, next.category_ids);
  if (problems.length > 0) throw new ApiError("invalid_request", "The car does not fit every category.", { reason: "category_not_allowed", details: problems });
  const changes = {
    ...(body.make !== undefined ? { make: body.make.trim() } : {}),
    ...(body.model !== undefined ? { model: body.model.trim() } : {}),
    ...(body.color !== undefined ? { color: body.color.trim() } : {}),
    ...(body.plate !== undefined ? { plate: body.plate.trim().toUpperCase() } : {}),
    ...(body.year !== undefined ? { year: body.year } : {}),
    ...(body.seats !== undefined ? { seats: body.seats } : {}),
    ...(body.fuel !== undefined ? { fuel: body.fuel } : {}),
    ...(body.categoryIds !== undefined ? { category_ids: body.categoryIds } : {}),
  };
  try {
    await trx.updateTable("vehicles").set({ ...changes, version: car.version + 1, updated_at: now }).where("vehicle_id", "=", vehicleId).execute();
  } catch (error) {
    if ((error as { constraint?: string }).constraint === "vehicles_plate") throw new ApiError("conflict", "A car with this plate is already registered.", { reason: "plate_taken" });
    throw error;
  }
  // A driver who has the car picked keeps only the categories it still has.
  if (body.categoryIds !== undefined) {
    const pickers = await trx.selectFrom("drivers").select(["driver_id", "category_ids", "version"]).where("vehicle_id", "=", vehicleId).execute();
    for (const p of pickers) {
      const kept = p.category_ids.filter((c) => body.categoryIds!.includes(c));
      if (kept.length !== p.category_ids.length) await trx.updateTable("drivers").set({ category_ids: kept, version: p.version + 1, updated_at: now }).where("driver_id", "=", p.driver_id).execute();
    }
  }
  const before = { make: car.make, model: car.model, year: car.year, color: car.color, plate: car.plate, seats: car.seats, fuel: car.fuel, categoryIds: car.category_ids };
  await audit(trx, { adminId: who.subjectId, action: "vehicle.update", targetType: "vehicle", targetId: vehicleId, zoneId: zone, detail: { before, changes: Object.keys(changes) }, at: now });
  const fresh = await trx.selectFrom("vehicles").selectAll().where("vehicle_id", "=", vehicleId).executeTakeFirstOrThrow();
  return vehicleFullView(trx, fresh as unknown as VehicleRow);
}

const busy = (status: string) => status !== "offline";

/** POST /admin/vehicles/{vehicleId}/driver (vehicles.edit): the car picked for a driver of its fleet, or freed. */
export async function adminLinkVehicleDriver(trx: Trx, who: Principal, vehicleId: string, rawBody: unknown, now: Date) {
  const { car, zone } = await carInScope(trx, who, vehicleId, true);
  const body = parseBody(LinkBody, rawBody);
  if (car.version !== body.expectedVersion) throw new ApiError("version_mismatch", "The car changed since you last saw it.", { projection: await vehicleFullView(trx, car) });
  const holder = car.driver_id ? await trx.selectFrom("drivers").select(["driver_id", "online_status", "vehicle_id", "version"]).where("driver_id", "=", car.driver_id).forUpdate().executeTakeFirst() : undefined;
  const holderHasIt = holder !== undefined && holder.vehicle_id === car.vehicle_id;
  if (body.driverId === null) {
    if (holderHasIt && busy(holder.online_status)) throw new ApiError("invalid_transition", "The driver is out with this car.", { reason: "driver_online" });
    if (holderHasIt) await trx.updateTable("drivers").set({ vehicle_id: null, version: holder.version + 1, updated_at: now }).where("driver_id", "=", holder.driver_id).execute();
  } else {
    const target = await loadDriver(trx, body.driverId, true);
    if (car.fleet_id === null || target.fleet_id !== car.fleet_id) throw badRequest("That driver is not in this car's fleet.", "driver_not_in_fleet");
    if (busy(target.online_status)) throw new ApiError("invalid_transition", "The driver is online; he picks a car while offline.", { reason: "driver_online" });
    if (car.status !== "approved") throw new ApiError("invalid_transition", "The car is not approved.", { reason: "vehicle_not_approved" });
    const missing = await vehicleDocumentBlockers(trx, car, now, target.driver_id);
    if (missing.length > 0) throw new ApiError("documents_not_approved", "The car's documents are not all approved.", { reason: "vehicle_documents_not_approved", details: missing });
    if (holderHasIt && holder.driver_id !== target.driver_id) {
      if (busy(holder.online_status)) throw new ApiError("conflict", "Another driver is driving this car right now.", { reason: "vehicle_in_use" });
      await trx.updateTable("drivers").set({ vehicle_id: null, version: holder.version + 1, updated_at: now }).where("driver_id", "=", holder.driver_id).execute();
    }
    // Any other car the driver had goes back to the fleet.
    await trx.updateTable("vehicles").set({ driver_id: null, updated_at: now }).where("driver_id", "=", target.driver_id).where("fleet_id", "is not", null).where("vehicle_id", "!=", vehicleId).execute();
    const categories = target.category_ids.length ? car.category_ids.filter((c) => target.category_ids.includes(c)) : car.category_ids;
    await trx.updateTable("drivers").set({ vehicle_id: vehicleId, category_ids: categories.length ? categories : car.category_ids, version: target.version + 1, updated_at: now }).where("driver_id", "=", target.driver_id).execute();
  }
  await trx.updateTable("vehicles").set({ driver_id: body.driverId, version: car.version + 1, updated_at: now }).where("vehicle_id", "=", vehicleId).execute();
  await audit(trx, { adminId: who.subjectId, action: "vehicle.link_driver", targetType: "vehicle", targetId: vehicleId, zoneId: zone, detail: { from: holderHasIt ? holder.driver_id : null, to: body.driverId }, at: now });
  const fresh = await trx.selectFrom("vehicles").selectAll().where("vehicle_id", "=", vehicleId).executeTakeFirstOrThrow();
  return vehicleFullView(trx, fresh as unknown as VehicleRow);
}

/** PUT /admin/drivers/{driverId}/categories (vehicles.edit): only categories of his car that the car fits. */
export async function adminSetDriverCategories(trx: Trx, who: Principal, driverId: string, rawBody: unknown, now: Date) {
  const row = await driverOfAdmin(trx, who, driverId, true);
  const body = parseBody(CategoriesBody, rawBody);
  if (row.version !== body.expectedVersion) throw new ApiError("version_mismatch", "The driver changed since you last saw them.", { projection: await driverView(trx, row, "admin", now) });
  if (row.vehicle_id === null) throw new ApiError("invalid_transition", "The driver has no car picked.", { reason: "no_vehicle" });
  const car = (await trx.selectFrom("vehicles").selectAll().where("vehicle_id", "=", row.vehicle_id).executeTakeFirstOrThrow()) as unknown as Car;
  const ids = [...new Set(body.categoryIds)];
  const notOnCar = ids.filter((c) => !car.category_ids.includes(c)).map((c) => `${c}:not_on_car`);
  const problems = [...notOnCar, ...(await carProblems(trx, car, ids.filter((c) => car.category_ids.includes(c))))];
  if (problems.length > 0) throw new ApiError("invalid_request", "The driver's car does not fit every category.", { reason: "category_not_allowed", details: problems });
  await trx.updateTable("drivers").set({ category_ids: ids, version: row.version + 1, updated_at: now }).where("driver_id", "=", driverId).execute();
  await audit(trx, { adminId: who.subjectId, action: "driver.categories", targetType: "driver", targetId: driverId, zoneId: row.zone_ids[0] ?? null, detail: { from: row.category_ids, to: ids }, at: now });
  return driverView(trx, await loadDriver(trx, driverId), "admin", now);
}

/** POST /admin/drivers/{driverId}/bank/review (documents.approve): the bank details document's review. */
export async function adminReviewBank(trx: Trx, who: Principal, driverId: string, rawBody: unknown, now: Date) {
  await driverOfAdmin(trx, who, driverId);
  const body = parseBody(BankBody, rawBody);
  if (body.decision === "rejected" && !body.note?.trim()) throw badRequest("Say why the bank details are rejected.", "note_required");
  const doc = await trx.selectFrom("documents").select("document_id").where("owner_kind", "=", "driver").where("owner_id", "=", driverId).where("type", "=", "bank_statement").executeTakeFirst();
  if (doc === undefined) throw notFound("No bank details are uploaded yet.", "bank_not_uploaded");
  // v0.18.5 (G2-D1): new bank details waiting as a renewal are the ones reviewed.
  const renewal = await trx.selectFrom("document_renewals").select("renewal_id").where("document_id", "=", doc.document_id).where("status", "=", "in_review").executeTakeFirst();
  return reviewDocument(trx, who, renewal?.renewal_id ?? doc.document_id, { decision: body.decision, ...(body.note ? { note: body.note } : {}) }, now);
}
