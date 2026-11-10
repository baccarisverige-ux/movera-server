/** Searches, offers and the dispatch controls, radar zones and airport queues. */
import type { ColumnType, Generated } from "kysely";
import type { Timestamp, Json, JsonDefault } from "./common.js";

export interface SearchesTable {
  trip_id: string;
  started_at: Timestamp;
  start_mode: "radar" | "exclusive" | null;
  busy: ColumnType<string, number | string, number | string>;
  document: Json;
  doc_version: number;
  state: ColumnType<unknown, string | null, string | null>;
  end_at: Timestamp;
  steps: JsonDefault<unknown[]>;
  fired: JsonDefault<unknown[]>;
  answered: JsonDefault<unknown[]>;
  rounds: Generated<number>;
  updated_at: Timestamp;
}

export interface OffersTable {
  offer_id: string;
  trip_id: string;
  driver_id: string;
  kind: "radar" | "exclusive" | "assigned" | "reservation" | "next_trip";
  status: Generated<"open" | "claimed" | "claimed_elsewhere" | "declined" | "expired" | "withdrawn">;
  version: Generated<number>;
  round: number;
  source: Generated<"system" | "admin">;
  group_id: string | null;
  reason_code: string | null;
  currency: string;
  fare_minor: ColumnType<string, number | string, number | string>;
  driver_earnings_minor: ColumnType<string, number | string, number | string>;
  pickup_pay_minor: ColumnType<string, number | string | undefined, number | string>;
  pickup_meters: number;
  pickup_eta_seconds: number;
  sent_at: Timestamp;
  expires_at: Timestamp;
  answered_at: Timestamp | null;
  decline_reason: string | null;
  /** v0.8.0: the driver was on a trip when the offer was sent (a trigger sets it); such a miss never counts for auto-offline. */
  driver_on_trip: Generated<boolean>;
  /** v0.18.6 (G4 decision 3): the rider's rating when the offer was sent; NULL = none (no rating, or the zone's switch is off). */
  rider_rating: ColumnType<number | null, number | null | undefined, number | null>;
}

export interface OfferEventsTable {
  driver_id: string;
  sequence: ColumnType<string, number | string, number | string>;
  event_id: string;
  kind: "offer_created" | "offer_updated" | "offer_withdrawn";
  offer: Json;
  occurred_at: Timestamp;
}

export interface DispatchControlsTable {
  zone_id: string;
  paused: boolean;
  mode: "radar" | "exclusive" | null;
  by: string | null;
  at: Timestamp;
  version: number;
}

export interface DispatchEventsTable {
  sequence: Generated<string>;
  event_id: Generated<string>;
  kind: "offer_sent" | "offer_declined" | "offer_expired" | "offer_withdrawn" | "offer_accepted" | "assignment_locked" | "driver_bonus_added";
  trip_id: string;
  zone_id: string | null;
  offer_id: string | null;
  group_id: string | null;
  occurred_at: Timestamp;
}

export interface DispatchPresetsTable { preset_id: string; country: string; name: string; values: Json; version: Generated<number>; created_by: string | null; created_at: Timestamp; updated_by: string | null; updated_at: Timestamp }

export interface DriverGroupsTable { group_id: string; country: string; name: string; driver_ids: Generated<string[]>; version: Generated<number>; created_by: string | null; created_at: Timestamp; updated_by: string | null; updated_at: Timestamp }

export interface RadarZonesTable { radar_zone_id: string; country: string; zone_id: string; name: string; polygon: Json; version: Generated<number>; created_by: string | null; created_at: Timestamp; updated_by: string | null; updated_at: Timestamp }

export interface RadarZoneRulesTable { rule_id: string; country: string; name: string; radar_zone_ids: Json; seconds: number; max_drivers: number; repeat: Generated<boolean>; version: Generated<number>; created_by: string | null; created_at: Timestamp; updated_by: string | null; updated_at: Timestamp }

export interface RadarZoneSendsTable {
  send_id: string; trip_id: string; radar_zone_id: string; rule_id: string; seconds: number; max_drivers: number; repeat: boolean; active: Generated<boolean>; rounds: Generated<number>;
  started_by: string | null; started_at: Timestamp; stopped_at: Timestamp | null; stopped_by: string | null; stop_reason: "admin" | "accepted" | "search_ended" | "trip_over" | "replaced" | null;
}

export interface AreaEventsTable {
  event_id: string; country: string; name: string; lat: number; lng: number; polygon: Json | null; starts_at: Timestamp; ends_at: Timestamp; is_on: Generated<boolean>; details: Json;
  version: Generated<number>; created_by: string | null; created_at: Timestamp; updated_by: string | null; updated_at: Timestamp;
}

/** v0.18.19 (owner, bookLater.liveFixes.includedWaiting): the all-zones reservation policy (one row). */
export interface ReservationPolicyTable {
  id: Generated<number>;
  included_waiting_min: number;
  rev: number;
  updated_at: Generated<Date>;
  updated_by: string | null;
}

/** v0.18.36 §60 (fix job 9, migration 0086): an airport zone's queue area. */
export interface AirportQueueAreasTable {
  area_id: string;
  airport_zone_id: string;
  polygon: unknown;
  south: number;
  west: number;
  north: number;
  east: number;
  is_on: Generated<boolean>;
  leave_grace_min: Generated<number>;
  offer_seconds: Generated<number>;
  max_queue_offers: Generated<number>;
  keep_place_after_decline: Generated<boolean>;
  updated_at: Date;
  updated_by: string | null;
}

/** v0.18.36 §60: one stay of a driver in an airport queue (open while left_at is null). */
export interface AirportQueueEntriesTable {
  entry_id: Generated<string>;
  area_id: string;
  driver_id: string;
  joined_at: Date;
  outside_since: Date | null;
  left_at: Date | null;
  left_reason: string | null;
}
