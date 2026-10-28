import type { Executor } from "../db/db.js";
import { requiredDocuments } from "./onboardingRules.js";

/**
 * Contract v0.10.1 (driverOnboarding.activation, owner decision 2026-10-28): which required documents still lack an
 * approved one. Items read "<scope>:<type>" (driver:terms, fleet:company_registration, vehicle:insurance).
 * Account activation and car approval are separate: a missing car never holds an account back.
 */
async function missing(ex: Executor, ownerKind: "driver" | "vehicle", ownerId: string, scope: "driver" | "fleet" | "vehicle", required: string[]): Promise<string[]> {
  if (required.length === 0) return [];
  const approved = await ex.selectFrom("documents").select("type")
    .where("owner_kind", "=", ownerKind).where("owner_id", "=", ownerId).where("status", "=", "approved")
    .where("type", "in", required).execute();
  const have = new Set(approved.map((r) => r.type));
  return required.filter((t) => !have.has(t)).map((t) => `${scope}:${t}`);
}

/** Activation: the person's driver documents; a fleet owner also the company's (requiredFleetDocuments). No car. */
export async function activationBlockers(ex: Executor, driver: { driver_id: string; country: string | null; account_type: string | null }): Promise<string[]> {
  const own = await missing(ex, "driver", driver.driver_id, "driver", requiredDocuments(driver.country, "driver"));
  const company = driver.account_type === "fleet" ? await missing(ex, "driver", driver.driver_id, "fleet", requiredDocuments(driver.country, "fleet")) : [];
  return [...own, ...company];
}

/** A car is picked or driven only when every required car document is approved (the country of its fleet, else its driver). */
export async function vehicleDocumentBlockers(ex: Executor, v: { vehicle_id: string; fleet_id: string | null; driver_id: string | null }): Promise<string[]> {
  let country: string | null = null;
  if (v.fleet_id) country = (await ex.selectFrom("fleets").select("country").where("fleet_id", "=", v.fleet_id).executeTakeFirst())?.country ?? null;
  else if (v.driver_id) country = (await ex.selectFrom("drivers").select("country").where("driver_id", "=", v.driver_id).executeTakeFirst())?.country ?? null;
  return missing(ex, "vehicle", v.vehicle_id, "vehicle", requiredDocuments(country, "vehicle"));
}
