/** Fleets and how drivers join them. */
import type { ColumnType, Generated } from "kysely";
import type { Timestamp } from "./common.js";

export interface FleetsTable {
  fleet_id: string;
  name: string;
  org_number: string;
  address: Generated<string>;
  country: string;
  city_id: string;
  zone_id: string;
  owner_driver_id: string;
  status: Generated<"pending" | "approved" | "rejected" | "blocked">;
  code: ColumnType<string | null, string | null | undefined, string | null>;
  review_note: ColumnType<string | null, string | null | undefined, string | null>;
  reviewed_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  reviewed_by: ColumnType<string | null, string | null | undefined, string | null>;
  version: Generated<number>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface FleetJoinAttemptsTable {
  driver_id: string;
  at: Timestamp;
}

// v0.5.3 (§14): joining a fleet is a two-sided invitation (contract.json#driverOnboarding.fleetInvitations).
export interface FleetInvitationsTable {
  invitation_id: string;
  fleet_id: string;
  direction: "driver_request" | "owner_invite";
  driver_id: ColumnType<string | null, string | null | undefined, string | null>;
  phone: ColumnType<string | null, string | null | undefined, string | null>;
  status: Generated<"pending" | "accepted" | "declined" | "cancelled" | "expired">;
  decided_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  decided_by: ColumnType<string | null, string | null | undefined, string | null>;
  expires_at: Timestamp;
  version: Generated<number>;
  created_at: Timestamp;
  updated_at: Timestamp;
}
