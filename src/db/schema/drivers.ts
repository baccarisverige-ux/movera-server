/** Drivers, their positions, vehicles and cancels. */
import type { ColumnType, Generated } from "kysely";
import type { Timestamp, Json } from "./common.js";

export interface DriversTable {
  driver_id: string;
  /** v0.18.39 A2 (owner Q4): this driver's scheduled payouts are paused. */
  payout_hold_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  payout_hold_reason: string | null;
  payout_hold_by: string | null;
  phone: string;
  first_name: Generated<string>;
  account_status: Generated<"pending" | "active" | "on_hold" | "suspended">;
  online_status: Generated<"offline" | "going_online" | "online" | "on_trip" | "suspended">;
  online_since: Timestamp | null;
  /** v0.18.13 (driving-time limits): when the driver last went offline (any way); when his counted driving time started. */
  went_offline_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  driving_since: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  zone_ids: Generated<string[]>;
  category_ids: Generated<string[]>;
  vehicle_id: string | null;
  scheduled_rides: Json | null;
  missed_exclusive: Generated<number>;
  offer_seq: Generated<string>;
  last_free_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  rating_sum: Generated<number>;
  rating_count: Generated<number>;
  version: Generated<number>;
  created_at: Timestamp;
  updated_at: Timestamp;
  // v0.5.3 (§14): the sign-up details; NULL account_type = a driver from before v0.5.3 (old rules).
  account_type: ColumnType<"driver" | "fleet" | null, "driver" | "fleet" | null | undefined, "driver" | "fleet" | null>;
  last_name: Generated<string>;
  /** v0.18.134 (migration 0123, contract.json#accountDeletion): the request; set last by account_erase. */
  deletion_requested_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  erased_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  date_of_birth: ColumnType<Date | null, string | null | undefined, string | null>;
  /** v0.18.166 (signupV2, migration 0139): Swedish personnummer YYYYMMDD-XXXX; masked for admins without drivers.viewSensitive. */
  personal_number: ColumnType<string | null, string | null | undefined, string | null>;
  /** v0.18.166 (signupV2, migration 0139): the number on the Taxiförarlegitimation. */
  taxi_license_number: ColumnType<string | null, string | null | undefined, string | null>;
  /** v0.18.166 (signupV2.address, migration 0139): the home address (DAC7, invoices). */
  address_street: ColumnType<string | null, string | null | undefined, string | null>;
  address_postal_code: ColumnType<string | null, string | null | undefined, string | null>;
  address_city: ColumnType<string | null, string | null | undefined, string | null>;
  email: ColumnType<string | null, string | null | undefined, string | null>;
  /** G30 v0.18.76 (migration 0099): when the current e-mail was proven (code or Apple / Google); null = Not verified. */
  email_verified_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  /** G30 v0.18.76 (migration 0099, contract.json#emailVerified.neverActive): first time account_status became active; never cleared, never sent. */
  first_activated_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  country: ColumnType<string | null, string | null | undefined, string | null>;
  city_id: ColumnType<string | null, string | null | undefined, string | null>;
  language: ColumnType<string | null, string | null | undefined, string | null>;
  /** v0.18.17 (owner BL-Q4): HomeArea { lat, lng, label? }. */
  home_area: ColumnType<unknown, string | null | undefined, string | null>;
  /** v0.18.172 (contract.json#preferredAreas, migration 0141): area ids; order only, never visibility. */
  preferred_area_ids: Generated<string[]>;
  terms_accepted_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  fleet_id: ColumnType<string | null, string | null | undefined, string | null>;
  fleet_linked_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  /** v0.18.6 (owner "Send the real reason"): why the server set him offline; cleared on going online. */
  offline_reason: ColumnType<OfflineReason | null, OfflineReason | null | undefined, OfflineReason | null>;
  offline_note: ColumnType<string | null, string | null | undefined, string | null>;
  offline_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  /** v0.18.37 §61 (migration 0084): he tapped Go offline during a trip; offline when his last trip ends. */
  offline_after_trip: Generated<boolean>;
  offline_after_trip_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  /** v0.18.65 §86 (migration 0098): next-trip offers stopped for his current trip (trip sheet radar). */
  next_trips_off: Generated<boolean>;
}

export type OfflineReason = "no_position" | "missed_offers" | "vehicle_blocked" | "fleet_removed" | "account_status" | "admin" | "documents_expired" | "after_trip";

export interface DriverLocationsTable {
  driver_id: string;
  lat: number;
  lng: number;
  accuracy: number;
  heading: number | null;
  speed_mps: number | null;
  moving: Generated<boolean>;
  measured_at: Timestamp;
  received_at: Timestamp;
  zone_id: ColumnType<string | null, string | null | undefined, string | null>;
}

export interface VehiclesTable {
  vehicle_id: string;
  /** v0.5.3: who has the car picked (NULL = free); for a car from before v0.5.3, its owner. */
  driver_id: string | null;
  /** v0.5.3: the fleet that owns the car; NULL for a car from before v0.5.3. */
  fleet_id: ColumnType<string | null, string | null | undefined, string | null>;
  make: string;
  model: string;
  year: number;
  color: string;
  plate: string;
  seats: Generated<number>;
  category_ids: Generated<string[]>;
  status: Generated<"pending" | "approved" | "rejected" | "blocked">;
  version: Generated<number>;
  created_at: Timestamp;
  updated_at: Timestamp;
  /** v0.18.0 (§27): petrol, diesel, hybrid or electric; NULL for a car registered before. */
  fuel: ColumnType<"petrol" | "diesel" | "hybrid" | "electric" | null, "petrol" | "diesel" | "hybrid" | "electric" | null | undefined, "petrol" | "diesel" | "hybrid" | "electric" | null>;
}

export interface DriverCancelsTable {
  trip_id: string;
  driver_id: string;
  at: Timestamp;
  from_status: string;
  reason_code: string;
  note: string | null;
}

/** v0.18.155 (migration 0134, contract.json#driverProfile): what the driver shows on his public profile. */
export interface DriverPublicProfilesTable {
  driver_id: string;
  languages: ColumnType<string[], string[] | undefined, string[]>;
  show_city: Generated<boolean>;
  show_years: Generated<boolean>;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

/** v0.18.155 (migration 0134): one count per driver and compliment code, raised in the rating transaction. */
export interface DriverComplimentCountsTable {
  driver_id: string;
  code: string;
  count: Generated<number>;
}

/** v0.18.155 (migration 0134): a short review; no rider id, phone or address (trip_id only for one per trip, never sent). */
export interface DriverReviewsTable {
  review_id: string;
  driver_id: string;
  trip_id: string;
  zone_id: string;
  stars: number;
  text: string;
  name: string | null;
  month: string;
  status: Generated<"pending" | "approved" | "hidden">;
  created_at: ColumnType<Date, Date | string, Date | string>;
  moderated_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  moderated_by: ColumnType<string | null, string | null | undefined, string | null>;
}
