import type { Executor } from "../db/db.js";
import { ApiError, notFound } from "../http/errors.js";

/** The fleet row and the small lookups both the fleet commands and the invitations use (contract v0.5.3 §14). */

export type FleetRow = {
  fleet_id: string;
  name: string;
  org_number: string;
  address: string;
  country: string;
  city_id: string;
  zone_id: string;
  owner_driver_id: string;
  status: "pending" | "approved" | "rejected" | "blocked";
  code: string | null;
  review_note: string | null;
  version: number;
  created_at: Date;
};

export type Admin = { subjectId: string; zones: string[] };

export async function loadFleet(ex: Executor, fleetId: string, lock = false): Promise<FleetRow> {
  let q = ex.selectFrom("fleets").selectAll().where("fleet_id", "=", fleetId);
  if (lock) q = q.forUpdate();
  const row = await q.executeTakeFirst();
  if (row === undefined) throw notFound("No such fleet.", "fleet_not_found");
  return row as unknown as FleetRow;
}

/** The fleet `driverId` owns, or 403. */
export async function ownedFleet(ex: Executor, driverId: string, lock = false): Promise<FleetRow> {
  let q = ex.selectFrom("fleets").selectAll().where("owner_driver_id", "=", driverId);
  if (lock) q = q.forUpdate();
  const fleet = await q.executeTakeFirst();
  if (fleet === undefined) throw new ApiError("forbidden", "Only a fleet owner can do that.", { reason: "not_fleet_owner" });
  return fleet as unknown as FleetRow;
}

export function coversFleet(who: Admin, fleet: FleetRow): void {
  if (!who.zones.includes("*") && !who.zones.includes(fleet.zone_id)) throw new ApiError("forbidden", "This fleet is outside your zones.", { reason: "zone_out_of_scope" });
}
