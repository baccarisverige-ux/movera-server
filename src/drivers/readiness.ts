import type { Executor } from "../db/db.js";
import { liveRequiredDocuments, onboardingSettings, requiredOf } from "./onboardingSettings.js";

/**
 * Contract v0.14.0 (driverOnboarding.activation, owner decision 2026-10-28): which required documents still lack an
 * approved one. Items read "<scope>:<type>" (driver:terms, fleet:company_registration, vehicle:insurance).
 * Account activation and car approval are separate: a missing car never holds an account back.
 * v0.17.0 (§25): the lists are the country's onboarding settings; an approved document whose expiresAt has passed
 * counts as expired (before the hourly sweep marks it), and an expired one counts as done only where the admin turned
 * the block off (blockAtExpiry for people, autoHold for cars).
 */
async function missing(ex: Executor, ownerKind: "driver" | "vehicle", ownerId: string, scope: "driver" | "fleet" | "vehicle", required: string[], now: Date, expiredIsFine = false): Promise<string[]> {
  if (required.length === 0) return [];
  const rows = await ex.selectFrom("documents").select(["type", "status", "expires_at"])
    .where("owner_kind", "=", ownerKind).where("owner_id", "=", ownerId).where("status", "in", ["approved", "expired"])
    .where("type", "in", required).execute();
  const have = new Set(rows.filter((r) => (r.status === "approved" && (r.expires_at === null || r.expires_at > now)) || (expiredIsFine && (r.status === "expired" || r.status === "approved"))).map((r) => r.type));
  return required.filter((t) => !have.has(t)).map((t) => `${scope}:${t}`);
}

/** Activation: the person's driver documents; a fleet owner also the company's (requiredFleetDocuments). No car. */
export async function activationBlockers(ex: Executor, driver: { driver_id: string; country: string | null; account_type: string | null }, now: Date = new Date()): Promise<string[]> {
  const own = await missing(ex, "driver", driver.driver_id, "driver", await liveRequiredDocuments(ex, driver.country, "driver"), now);
  const company = driver.account_type === "fleet" ? await missing(ex, "driver", driver.driver_id, "fleet", await liveRequiredDocuments(ex, driver.country, "fleet"), now) : [];
  return [...own, ...company];
}

/**
 * v0.17.0 (owner items 1 and 3): an active account's required documents that expired. With blockAtExpiry on they keep
 * the driver offline (reason documents_expired); off, none.
 */
export async function expiredBlockers(ex: Executor, driver: { driver_id: string; country: string | null; account_type: string | null }, now: Date): Promise<string[]> {
  const settings = await onboardingSettings(ex, driver.country);
  if (!driver.country || !settings.expiry.blockAtExpiry) return [];
  const scopes: Array<"driver" | "fleet"> = driver.account_type === "fleet" ? ["driver", "fleet"] : ["driver"];
  const out: string[] = [];
  for (const scope of scopes) {
    const required = requiredOf(settings, scope);
    if (required.length === 0) continue;
    const rows = await ex.selectFrom("documents").select(["type"]).where("owner_kind", "=", "driver").where("owner_id", "=", driver.driver_id).where("type", "in", required)
      .where((eb) => eb.or([eb("status", "=", "expired"), eb.and([eb("status", "=", "approved"), eb("expires_at", "<=", now)])])).execute();
    out.push(...rows.map((r) => `${scope}:${r.type}`));
  }
  return out;
}

/** The country whose rules a car follows: its fleet's, else its driver's. */
export async function vehicleCountry(ex: Executor, v: { fleet_id: string | null; driver_id: string | null }): Promise<string | null> {
  if (v.fleet_id) return (await ex.selectFrom("fleets").select("country").where("fleet_id", "=", v.fleet_id).executeTakeFirst())?.country ?? null;
  if (v.driver_id) return (await ex.selectFrom("drivers").select("country").where("driver_id", "=", v.driver_id).executeTakeFirst())?.country ?? null;
  return null;
}

/** A car is picked or driven only when every required car document is approved (the country of its fleet, else its driver). */
export async function vehicleDocumentBlockers(ex: Executor, v: { vehicle_id: string; fleet_id: string | null; driver_id: string | null }, now: Date = new Date()): Promise<string[]> {
  const country = await vehicleCountry(ex, v);
  if (!country) return [];
  const settings = await onboardingSettings(ex, country);
  return missing(ex, "vehicle", v.vehicle_id, "vehicle", requiredOf(settings, "vehicle"), now, !settings.vehicles.autoHold);
}

/** v0.17.0 (owner item 9): the fleet's cars a driver could pick: approved, with every car document approved. */
export async function pickableCars(ex: Executor, fleetId: string, now: Date): Promise<string[]> {
  const cars = await ex.selectFrom("vehicles").select(["vehicle_id", "fleet_id", "driver_id"]).where("fleet_id", "=", fleetId).where("status", "=", "approved").execute();
  const out: string[] = [];
  for (const car of cars) if ((await vehicleDocumentBlockers(ex, car, now)).length === 0) out.push(car.vehicle_id);
  return out;
}
