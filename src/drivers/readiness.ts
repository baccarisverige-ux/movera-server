import type { Executor } from "../db/db.js";
import { PHOTO_TYPES, onboardingSettings, requiredOf } from "./onboardingSettings.js";

/**
 * Contract v0.14.0 (driverOnboarding.activation, owner decision 2026-10-28): which required documents still lack an
 * approved one. Items read "<scope>:<type>" (driver:terms, fleet:company_registration, vehicle:insurance).
 * Account activation and car approval are separate: a missing car never holds an account back.
 * v0.18.0 (§27): the lists are the country's onboarding settings; an approved document whose expiresAt has passed
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
  if (!driver.country) return [];
  // An expired document counts as done where the admin turned blockAtExpiry off (it still shows red to the driver).
  const settings = await onboardingSettings(ex, driver.country);
  const lenient = !settings.expiry.blockAtExpiry;
  const own = await missing(ex, "driver", driver.driver_id, "driver", requiredOf(settings, "driver"), now, lenient);
  const company = driver.account_type === "fleet" ? await missing(ex, "driver", driver.driver_id, "fleet", requiredOf(settings, "fleet"), now, lenient) : [];
  return [...own, ...company];
}

/**
 * v0.18.0 (owner items 1 and 3): an active account's required documents that expired. With blockAtExpiry on they keep
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
    // v0.18.5 (G2-D1): the approved document's own row decides; an upload waits apart as a renewal
    // (document_renewals), so uploading never unblocks: expired, or approved but past its end date, blocks.
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

/**
 * v0.18.0 (owner item 16: "keep approved account works for test only"): a test account (a driver-app number of
 * test_phones, the seeded test drivers among them) is not asked for the car photos.
 */
export async function isTestDriver(ex: Executor, driverId: string | null | undefined): Promise<boolean> {
  if (!driverId) return false;
  const row = await ex.selectFrom("drivers").innerJoin("test_phones", "test_phones.phone", "drivers.phone").select("drivers.driver_id")
    .where("drivers.driver_id", "=", driverId).where("test_phones.app", "=", "driver").executeTakeFirst();
  return row !== undefined;
}

/**
 * A car is picked or driven only when every required car document is approved (the country of its fleet, else its
 * driver). v0.18.0 (owner item 16): the four photos too, for every car, old or new; `forDriver` is the driver who
 * picks or drives it, and a test account is not asked for the photos.
 */
export async function vehicleDocumentBlockers(ex: Executor, v: { vehicle_id: string; fleet_id: string | null; driver_id: string | null }, now: Date = new Date(), forDriver?: string): Promise<string[]> {
  const country = await vehicleCountry(ex, v);
  if (!country) return [];
  const settings = await onboardingSettings(ex, country);
  const exempt = await isTestDriver(ex, forDriver);
  const required = requiredOf(settings, "vehicle").filter((t) => !(exempt && PHOTO_TYPES.includes(t)));
  return missing(ex, "vehicle", v.vehicle_id, "vehicle", required, now, !settings.vehicles.autoHold);
}

/** v0.18.0 (owner item 9): the fleet's cars a driver could pick: approved, with every car document approved. */
export async function pickableCars(ex: Executor, fleetId: string, now: Date, forDriver?: string): Promise<string[]> {
  const cars = await ex.selectFrom("vehicles").select(["vehicle_id", "fleet_id", "driver_id"]).where("fleet_id", "=", fleetId).where("status", "=", "approved").execute();
  const out: string[] = [];
  for (const car of cars) if ((await vehicleDocumentBlockers(ex, car, now, forDriver)).length === 0) out.push(car.vehicle_id);
  return out;
}
