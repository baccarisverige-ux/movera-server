/** Riders. */
import type { ColumnType, Generated } from "kysely";
import type { Timestamp, JsonDefault } from "./common.js";

export interface RidersTable {
  rider_id: string;
  phone: string;
  first_name: Generated<string>;
  email: string | null;
  /** G30 v0.18.76 (migration 0099): when the current e-mail was proven (code or Apple / Google); null = Not verified. */
  email_verified_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  status: Generated<"active" | "suspended">;
  language: string | null;
  outstanding_minor: ColumnType<string, number | string | undefined, number | string>;
  outstanding_source_trip_id: ColumnType<string | null, string | null | undefined, string | null>;
  /** v0.18.7 (Q3): the currency of outstanding_minor (the oldest owed fee's); null when nothing is owed. */
  outstanding_currency: ColumnType<string | null, string | null | undefined, string | null>;
  consents: JsonDefault;
  deletion_requested_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  /** v0.18.4 (G3-R4): the last map or price call and its zone, for riders online. */
  last_seen_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  last_seen_zone_id: ColumnType<string | null, string | null | undefined, string | null>;
  rating_sum: Generated<number>;
  rating_count: Generated<number>;
  wallet_minor: ColumnType<string, number | string | undefined, number | string>;
  /** v0.18.39 A2 (G16 Q16-2): Warn → Pause → Ban; paused / banned = status suspended. */
  moderation_level: Generated<"none" | "warning" | "paused" | "banned">;
  moderation_reason: string | null;
  moderation_until: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  moderation_set_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  version: Generated<number>;
  created_at: Timestamp;
  updated_at: Timestamp;
}
