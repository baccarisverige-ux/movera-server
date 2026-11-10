/** Zones, categories, quotes and surge. */
import type { ColumnType, Generated } from "kysely";
import type { Timestamp, Json, JsonDefault } from "./common.js";

export interface ZonesTable {
  zone_id: string;
  name: string;
  country: string;
  currency: string;
  time_zone: string;
  kind: Generated<"operating" | "airport">;
  center_lat: number;
  center_lng: number;
  open: Generated<boolean>;
  created_at: Timestamp;
  south: number;
  west: number;
  north: number;
  east: number;
  /** v0.11.0 §20: { sv, fr, en }. */
  names: Json;
  /** v0.11.0 §20: the outline, [[lat, lng], ...]; south..east are its bounding box. */
  polygon: Json;
  version: Generated<number>;
  updated_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  updated_by: ColumnType<string | null, string | null | undefined, string | null>;
}

/** v0.7.2 (contract.json#surgeLive.samples): one row per open zone and minute. */
export interface SurgeSamplesTable {
  zone_id: string;
  at: Timestamp;
  requests: number;
  free_drivers: number;
  /** numeric comes back as a string. */
  ratio: ColumnType<string, number | string, number | string>;
  multiplier: ColumnType<string, number | string, number | string>;
  source: "manual" | "scheduled" | "smart" | "off";
}

export interface QuotesTable {
  quote_id: string;
  rider_id: string;
  zone_id: string;
  category_id: string;
  kind: "live" | "scheduled";
  scheduled_at: Timestamp | null;
  pickup: Json;
  dropoff: Json;
  stops: JsonDefault<unknown[]>;
  distance_meters: number;
  duration_seconds: number;
  route_source: "osrm" | "estimate";
  /** numeric comes back as a string. */
  surge_multiplier: ColumnType<string, number | string | undefined, number | string>;
  /** v0.6.0: babySeats, childSeats, airportPickup, airportDropoff, fixedRouteId as the rider sent them. */
  price_extras: JsonDefault<Record<string, unknown>>;
  currency: string;
  total_minor: ColumnType<string, number | string, number | string>;
  fare_lines: Json;
  driver_earnings_minor: ColumnType<string, number | string, number | string>;
  pricing_version: number;
  /** v0.8.0: the zone id, or standard-<CC> when the country standard priced the quote. */
  pricing_scope: ColumnType<string | null, string | null | undefined, string | null>;
  payment_method: string | null;
  expires_at: Timestamp;
  used_at: Timestamp | null;
  created_at: Timestamp;
}

export interface SurgeSchedulesTable {
  schedule_id: string;
  zone_id: string;
  category_ids: string[];
  start_at: Date;
  end_at: Date;
  step_minutes: number;
  cap: ColumnType<string, number | string, number | string>;
  points: ColumnType<unknown, string, string>;
  status: "scheduled" | "active" | "ended" | "cancelled";
  version: number;
  created_by: string;
  created_at: Date;
  ended_at: Date | null;
}

export interface SmartSurgeStateTable {
  zone_id: string;
  multiplier: ColumnType<string, number | string | undefined, number | string>;
  up_since: Date | null;
  low_since: Date | null;
  last_change: Date | null;
  checked_at: Date | null;
  ratio: ColumnType<string, number | string | undefined, number | string>;
  profile_id: string | null;
}

export interface CategoriesTable {
  category_id: string;
  label: string;
  line: ColumnType<Record<string, string>, string | undefined, string>;
  seats: number;
  built_in: Generated<boolean>;
  sort: Generated<number>;
  archived_at: Date | null;
  archived_by: string | null;
  archive_reason: string | null;
  updated_at: Generated<Date>;
}
