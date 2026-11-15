/** v0.18.103 BQ-V44 bonus campaigns (migration 0110, contract.json#bonusCampaigns). */
import type { ColumnType } from "kysely";
import type { Timestamp } from "./common.js";

type Nullable<T> = ColumnType<T | null, T | null | undefined, T | null>;

export interface BonusCampaignsTable {
  bonus_id: string;
  zone_id: string;
  names: ColumnType<{ sv: string; fr: string; en: string }, string, string>;
  measure: "trips" | "online_hours";
  target: number;
  amount_minor: ColumnType<string, number | string, number | string>;
  currency: string;
  start_date: ColumnType<Date, string, string>;
  end_date: ColumnType<Date, string, string>;
  starts_at: Timestamp;
  ends_at: Timestamp;
  polygon: ColumnType<Array<[number, number]>, string, string>;
  south: number;
  west: number;
  north: number;
  east: number;
  status: ColumnType<"active" | "paused" | "ended", "active" | "paused" | "ended" | undefined, "active" | "paused" | "ended">;
  pauses: ColumnType<Array<[string, string | null]>, string | undefined, string>;
  ended_at: Nullable<Date>;
  version: ColumnType<number, number | undefined, number>;
  created_by: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface BonusProgressTable {
  bonus_id: string;
  driver_id: string;
  trips: ColumnType<number, number | undefined, number>;
  online_seconds: ColumnType<number, number | undefined, number>;
  last_inside_at: Nullable<Date>;
  last_received_at: Nullable<Date>;
  last_lat: Nullable<number>;
  last_lng: Nullable<number>;
  earned_at: Nullable<Date>;
  entry_id: Nullable<string>;
  opened_at: Nullable<Date>;
  updated_at: Timestamp;
}

export interface BonusTripsCountedTable {
  bonus_id: string;
  trip_id: string;
  counted_at: Timestamp;
}

export interface BonusRiderDaysTable {
  bonus_id: string;
  driver_id: string;
  rider_id: string;
  local_day: ColumnType<Date, string, string>;
}
