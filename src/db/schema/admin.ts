/** Admin accounts, config documents, approvals, audit, live events, KPIs and content. */
import type { ColumnType, Generated } from "kysely";
import type { Timestamp, Json, JsonDefault } from "./common.js";

export interface AdminsTable {
  admin_id: string;
  email: string;
  name: string;
  /** v0.18.18 (migration 0063): the first name set in Team; never an e-mail. */
  first_name: ColumnType<string | null, string | null | undefined, string | null>;
  role: string;
  zone_ids: string[] | null;
  countries: string[] | null;
  fleet_partner_id: string | null;
  language: string | null;
  active: Generated<boolean>;
  password_hash: string | null;
  idle_timeout_seconds: Generated<number>;
  version: Generated<number>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface AdminSetupLinksTable {
  token_sha256: string;
  admin_id: string;
  expires_at: Timestamp;
  used_at: Timestamp | null;
  created_by: string | null;
  created_at: Timestamp;
}

export interface AdminSignInFailuresTable {
  id: Generated<string>;
  email: string;
  ip: string | null;
  at: Timestamp;
}

export type ConfigDoc = "rider_app_config" | "driver_app_config" | "pricing" | "dispatch" | "country_rules" | "onboarding";

export interface ConfigDraftsTable {
  doc: ConfigDoc;
  zone_id: string;
  version: number;
  document: Json;
  updated_at: Timestamp;
  updated_by: string | null;
}

export interface ConfigLiveTable {
  doc: ConfigDoc;
  zone_id: string;
  version: number;
  document: Json;
  published_at: Timestamp;
  published_by: string | null;
}

export interface ConfigHistoryTable {
  doc: ConfigDoc;
  zone_id: string;
  version: number;
  document: Json;
  published_at: Timestamp;
  published_by: string | null;
  approved_by: string | null;
  note: string | null;
  action: Generated<"publish" | "restore">;
  restored_from: number | null;
}

export interface ApprovalsTable {
  approval_id: string;
  action: string;
  target_type: "trip" | "payment" | "refund" | "payout" | "config" | "driver" | "rider";
  target_id: string;
  payload: JsonDefault;
  approve_permission: string;
  zone_id: string | null;
  status: Generated<"pending_approval" | "approved" | "rejected" | "expired">;
  requested_by: string;
  requested_at: Timestamp;
  expires_at: Timestamp;
  decided_by: string | null;
  decided_at: Timestamp | null;
  decision_note: string | null;
}

export interface AdminAuditTable {
  audit_id: Generated<string>;
  admin_id: string | null;
  action: string;
  target_type: string;
  target_id: string;
  zone_id: string | null;
  detail: JsonDefault;
  at: Timestamp;
}

/** v0.18.22 (contract.json#adminLiveEvents): what changed, for the admin live updates stream (written by triggers). */
export interface AdminLiveEventsTable {
  sequence: Generated<string>;
  type: string;
  entity_id: string;
  zone_id: string | null;
  occurred_at: Timestamp;
}

export interface AdminLivePrunedTable {
  id: number;
  up_to: string;
}

export interface KpiDaysTable {
  zone_id: string;
  day: ColumnType<string, string, string>;
  currency: string;
  completed_trips: number;
  cancelled_trips: number;
  no_shows: number;
  gross_minor: ColumnType<string, number | string, number | string>;
  commission_minor: ColumnType<string, number | string, number | string>;
  driver_earnings_minor: ColumnType<string, number | string, number | string>;
  pickup_pay_minor: ColumnType<string, number | string, number | string>;
  driver_bonus_minor: ColumnType<string, number | string, number | string>;
  cash_collected_minor: ColumnType<string, number | string, number | string>;
  wallet_applied_minor: ColumnType<string, number | string, number | string>;
  new_riders: number;
  new_drivers: number;
  tips_minor: ColumnType<string, number | string, number | string>;
  refunds_minor: ColumnType<string, number | string, number | string>;
  fees_minor: ColumnType<string, number | string, number | string>;
  movera_earnings_minor: ColumnType<string, number | string, number | string>;
  computed_at: Timestamp;
}

export interface ContentItemsTable {
  slot: string;
  zone_id: string;
  version: number;
  title: string;
  text: ColumnType<Record<string, string>, string, string>;
  image: string | null;
  expires_at: Date | null;
  reaccept: boolean | null;
  versions: ColumnType<unknown, string | null, string | null>;
  published_at: Date;
  published_by: string;
  restored_from: number | null;
}
