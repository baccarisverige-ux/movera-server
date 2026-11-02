import type { ColumnType, Generated, RawBuilder } from "kysely";

/** Kysely table types for migrations/*.sql. Keep in step with every migration. */

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type Json<T = unknown> = ColumnType<T, string | T, string | T>;
/** A json column with a database default: optional on insert. */
type JsonDefault<T = unknown> = ColumnType<T, string | T | undefined, string | T>;

export interface RidersTable {
  rider_id: string;
  phone: string;
  first_name: Generated<string>;
  email: string | null;
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
  version: Generated<number>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface DriversTable {
  driver_id: string;
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
  date_of_birth: ColumnType<Date | null, string | null | undefined, string | null>;
  email: ColumnType<string | null, string | null | undefined, string | null>;
  country: ColumnType<string | null, string | null | undefined, string | null>;
  city_id: ColumnType<string | null, string | null | undefined, string | null>;
  language: ColumnType<string | null, string | null | undefined, string | null>;
  terms_accepted_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  fleet_id: ColumnType<string | null, string | null | undefined, string | null>;
  fleet_linked_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  /** v0.18.6 (owner "Send the real reason"): why the server set him offline; cleared on going online. */
  offline_reason: ColumnType<OfflineReason | null, OfflineReason | null | undefined, OfflineReason | null>;
  offline_note: ColumnType<string | null, string | null | undefined, string | null>;
  offline_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
}

export type OfflineReason = "no_position" | "missed_offers" | "vehicle_blocked" | "fleet_removed" | "account_status" | "admin";

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

/** contract §11: app logs, analytics and crash reports, scrubbed, kept 30 days (audit Phase 4, P4-5). */
export interface TelemetryTable {
  telemetry_id: Generated<string>;
  kind: "log" | "analytics" | "crash";
  level: string | null;
  event: string | null;
  actor: string | null;
  subject_id: string | null;
  body: JsonDefault;
  at: Timestamp;
  /** contract v0.16.0: the error group of a kept crash or server error. */
  error_id: ColumnType<string | null, string | null | undefined, string | null>;
}

/** contract v0.16.0 §11 (owner 2026-10-29, Crashes & errors): crash and error reports grouped by fingerprint. */
export interface ErrorGroupsTable {
  error_id: string;
  fingerprint: string;
  app: "driver" | "rider" | "server";
  platform: "android" | "ios" | "web" | "server";
  kind: "crash" | "error";
  message: string;
  top_frame: string | null;
  app_versions: ColumnType<string[], string[] | undefined, string[]>;
  count: ColumnType<number, number | undefined, number>;
  first_seen: Timestamp;
  last_seen: Timestamp;
  status: ColumnType<"open" | "fixed", "open" | "fixed" | undefined, "open" | "fixed">;
  fixed_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
}

/** Distinct devices (hashed) per error group. */
export interface ErrorGroupDevicesTable {
  error_id: string;
  device: string;
  last_seen: Timestamp;
}

/** Audit Phase 4 (P4-2): document uploads started, for the per-driver hourly limit. */
export interface DocumentUploadAttemptsTable {
  driver_id: string;
  at: Timestamp;
}

export interface DocumentsTable {
  document_id: string;
  driver_id: string;
  owner_kind: "driver" | "vehicle";
  owner_id: string;
  type: string;
  status: Generated<"missing" | "in_review" | "approved" | "rejected" | "expired">;
  expires_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  file_name: ColumnType<string | null, string | null | undefined, string | null>;
  media_type: ColumnType<string | null, string | null | undefined, string | null>;
  file_size: ColumnType<number | null, number | null | undefined, number | null>;
  uploaded_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  reviewed_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  reviewed_by: ColumnType<string | null, string | null | undefined, string | null>;
  review_note: ColumnType<string | null, string | null | undefined, string | null>;
  version: Generated<number>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface DocumentFilesTable {
  document_id: string;
  key_id: string;
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
}

/** v0.18.5 (G2-D1, migration 0038): an upload that renews an approved document, waiting for review. */
export interface DocumentRenewalsTable {
  renewal_id: string;
  document_id: string;
  status: Generated<"in_review" | "rejected">;
  expires_at: Date | null;
  file_name: string;
  media_type: string;
  file_size: number;
  uploaded_at: Date;
  reviewed_at: Date | null;
  reviewed_by: string | null;
  review_note: string | null;
  version: Generated<number>;
  key_id: string;
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

/** v0.18.5 (G1-B2, migration 0038): published terms and privacy texts per country. */
export interface LegalTextsTable {
  country: string;
  version: number;
  terms: Json;
  privacy: Json;
  company: JsonDefault;
  reaccept: Generated<boolean>;
  published_at: Date;
  published_by: string;
}

export interface LegalAcceptancesTable {
  actor: "rider" | "driver";
  subject_id: string;
  country: string;
  version: number;
  accepted_at: Date;
}

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

export interface TripsTable {
  trip_id: string;
  rider_id: string;
  driver_id: string | null;
  vehicle_id: string | null;
  zone_id: string;
  kind: "live" | "scheduled";
  category_id: string;
  status: string;
  version: Generated<number>;
  /** bigint in PostgreSQL; pg returns it as a string. */
  sequence: ColumnType<string, number | string | undefined, number | string>;
  ended_by_command: string | null;
  scheduled_at: Timestamp | null;
  accepted_at: Timestamp | null;
  search_started_at: Timestamp | null;
  pickup: Json;
  dropoff: Json;
  stops: JsonDefault<unknown[]>;
  quote_id: string | null;
  currency: string;
  fare_minor: ColumnType<string, number | string, number | string>;
  fare_lines: JsonDefault<unknown[]>;
  booked_fare_minor: ColumnType<string, number | string, number | string>;
  offer_raised_minor: ColumnType<string, number | string | undefined, number | string>;
  driver_earnings_minor: ColumnType<string | null, number | string | null | undefined, number | string | null>;
  commission_minor: ColumnType<string | null, number | string | null | undefined, number | string | null>;
  pickup_pay_minor: ColumnType<string | null, number | string | null | undefined, number | string | null>;
  driver_bonus_minor: ColumnType<string | null, number | string | null | undefined, number | string | null>;
  priority: Generated<boolean>;
  /** Owner bug 2026-11-01: the admin's money per kind of offer (NULL = driver_bonus_minor / priority for both). */
  bonus_exclusive_minor: ColumnType<string | null, number | string | null | undefined, number | string | null>;
  bonus_radar_minor: ColumnType<string | null, number | string | null | undefined, number | string | null>;
  priority_exclusive: ColumnType<boolean | null, boolean | null | undefined, boolean | null>;
  priority_radar: ColumnType<boolean | null, boolean | null | undefined, boolean | null>;
  payment_method: string;
  payment_method_id: string | null;
  payment_status: string | null;
  rating_status: Generated<string>;
  waiting: Json | null;
  cancellation: Json | null;
  pin_required: Generated<boolean>;
  /** v0.18.8 (migration 0042, contract.json#arrivedWaiting.pin): the rider PIN, wrong tries in a row, lock and the right try. */
  pickup_pin: ColumnType<string | null, string | null | undefined, string | null>;
  pin_attempts: Generated<number>;
  pin_locked_until: ColumnType<Date | null, Date | null | undefined, Date | null>;
  pin_verified_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  pin_wrong_total: Generated<number>;
  pin_blocked: Generated<boolean>;
  /** v0.18.9 (migration 0043, contract.json#onTrip): the server ride check, its log per trigger, the measured route, the route change, the admin flag. */
  ride_check: ColumnType<unknown, string | null | undefined, string | null>;
  ride_check_log: JsonDefault<Record<string, string>>;
  planned_route: ColumnType<unknown, string | null | undefined, string | null>;
  route_change: ColumnType<unknown, string | null | undefined, string | null>;
  admin_flag: ColumnType<unknown, string | null | undefined, string | null>;
  /** v0.18.10 (migration 0045, contract.json#finish): the rider's tip, what ended the trip early, Movera's changes to the driver's pay, refunded money. */
  tip: ColumnType<unknown, string | null | undefined, string | null>;
  end_info: ColumnType<unknown, string | null | undefined, string | null>;
  driver_adjustments_minor: ColumnType<string, number | string | undefined, number | string>;
  refunded_minor: ColumnType<string, number | string | undefined, number | string>;
  config_versions: JsonDefault;
  distance_meters: ColumnType<number | null, number | null | undefined, number | null>;
  duration_seconds: ColumnType<number | null, number | null | undefined, number | null>;
  surge_multiplier: ColumnType<string, number | string | undefined, number | string>;
  /** v0.6.0: the quote's babySeats, childSeats, airportPickup, airportDropoff, fixedRouteId (priced again at the end). */
  price_extras: JsonDefault<Record<string, unknown>>;
  pricing_version: ColumnType<number | null, number | null | undefined, number | null>;
  /** v0.8.0: config scope of that pricing document (the zone id, or standard-<CC>); null before v0.8.0 = the zone. */
  pricing_scope: ColumnType<string | null, string | null | undefined, string | null>;
  /** v0.8.0 (contract.json#bookingSnapshot): the rules of booking time; null before v0.8.0 = the live settings. */
  booking_rules: ColumnType<unknown, string | null | undefined, string | null>;
  quote_expires_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  notes: ColumnType<string | null, string | null | undefined, string | null>;
  search_step: ColumnType<unknown, string | null | undefined, string | null>;
  /** The admin alert for a driver silent on board (owner decision 2026-10-26); see trips/ride.ts. */
  driver_silent_alert: ColumnType<unknown, string | null | undefined, string | null>;
  driver_summary: ColumnType<unknown, string | null | undefined, string | null>;
  /** v0.18.7 (Q1): RiderSummary for the driver and admin, set at accept. */
  rider_summary: ColumnType<unknown, string | null | undefined, string | null>;
  /** v0.18.7 (Q4): TripEta, the server's road-route ETA, refreshed by the eta timer (trips/eta.ts). */
  eta: ColumnType<unknown, string | null | undefined, string | null>;
  /** v0.18.13 (G5-8): the latest heading-to-pickup check. */
  heading_check: ColumnType<unknown, string | null | undefined, string | null>;
  /** v0.18.7 (status item 4): the pickup as booked, set on the first move; the move limit is measured from it. */
  booked_pickup: ColumnType<unknown, string | null | undefined, string | null>;
  arrived_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  boarded_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  started_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  ended_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  cash_collected_minor: ColumnType<string | null, number | string | null | undefined, number | string | null>;
  driver_rating_status: Generated<string>;
  accept_pickup_meters: ColumnType<number | null, number | null | undefined, number | null>;
  wallet_applied_minor: ColumnType<string, number | string | undefined, number | string>;
  cancelled_driver_ids: ColumnType<string[], string[] | undefined, string[] | RawBuilder<string[]>>;
  created_at: Timestamp;
  updated_at: Timestamp;
  stop_visits: JsonDefault<unknown[]>;
}

export interface TripEventsTable {
  trip_id: string;
  sequence: ColumnType<string, number | string, number | string>;
  event_id: string;
  kind: string;
  version: number;
  occurred_at: Timestamp;
  projection: Json | null;
  location: Json | null;
  eta_seconds: number | null;
  /** v0.18.7: TripEta on the ETA tick's location event. */
  eta: Json | null;
  cancel_fee: Json | null;
  message: Json | null;
}

export interface IdempotencyKeysTable {
  actor: string;
  subject_id: string;
  key: string;
  method: string;
  route: string;
  body_sha256: string;
  status_code: number;
  response: Json | null;
  created_at: Timestamp;
}

export interface TimersTable {
  timer_id: Generated<string>;
  kind: string;
  ref_id: string;
  due_at: Timestamp;
  payload: JsonDefault;
  attempts: Generated<number>;
  last_error: string | null;
  created_at: Timestamp;
}

export interface TestPhonesTable {
  phone: string;
  app: "rider" | "driver";
  note: Generated<string>;
  created_at: Timestamp;
}

/** v0.15.0 (migration 0031): numbers that asked to join after 403 sign_in_restricted. */
/** contract v0.18.1 §26: the frozen final price of a trip's latest complete-preview (migration 0034). */
export interface CompletePreviewsTable {
  trip_id: string;
  preview_id: string;
  driver_id: string;
  expires_at: Timestamp;
  early_end: boolean;
  fare_minor: ColumnType<string, number | string, number | string>;
  wallet_minor: ColumnType<string, number | string, number | string>;
  money: ColumnType<Record<string, unknown>, string, string>;
  created_at: Timestamp;
}

export interface SignInWaitlistTable {
  phone: string;
  app: "rider" | "driver";
  locale: "sv" | "fr" | "en" | null;
  ip: string | null;
  count: Generated<number>;
  first_at: Timestamp;
  last_at: Timestamp;
}

export interface SignInWaitlistAsksTable {
  ip: string;
  at: Timestamp;
}

export interface OtpSessionsTable {
  session_id: string;
  phone: string;
  app: "rider" | "driver";
  code_sha256: string;
  is_test: boolean;
  locale: string | null;
  ip: string | null;
  attempts: Generated<number>;
  max_attempts: number;
  expires_at: Timestamp;
  consumed_at: Timestamp | null;
  created_at: Timestamp;
}

export interface AuthSessionsTable {
  session_id: string;
  actor: "rider" | "driver" | "admin";
  subject_id: string;
  expires_at: Timestamp;
  revoked_at: Timestamp | null;
  revoked_reason: string | null;
  user_agent: string | null;
  ip: string | null;
  created_at: Timestamp;
  last_refresh_at: Timestamp | null;
}

export interface RefreshTokensTable {
  token_sha256: string;
  session_id: string;
  expires_at: Timestamp;
  used_at: Timestamp | null;
  replaced_by: string | null;
  created_at: Timestamp;
}

export interface PushDevicesTable {
  token: string;
  actor: "rider" | "driver";
  subject_id: string;
  session_id: string | null;
  provider: "fcm" | "apns";
  platform: "ios" | "android" | "web";
  app_version: string | null;
  locale: string | null;
  updated_at: Timestamp;
}

export interface AdminsTable {
  admin_id: string;
  email: string;
  name: string;
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

/** v0.18.0 (§27): expiry notices sent, one per document, expiry date and warning day (0 = expired). */
export interface DocumentNoticesTable {
  document_id: string;
  expires_at: Timestamp;
  warn_day: number;
  sent_at: Timestamp;
}

/** v0.18.0 (§27): 'Finish your sign-up' notices sent. */
export interface SignUpRemindersTable {
  driver_id: string;
  sent_at: Timestamp;
}

export interface TripLocationsTable {
  trip_id: string;
  driver_id: string;
  measured_at: Timestamp;
  lat: number;
  lng: number;
  accuracy: number;
  heading: number | null;
  speed_mps: number | null;
  moving: Generated<boolean>;
}

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

export interface DriverCancelsTable {
  trip_id: string;
  driver_id: string;
  at: Timestamp;
  from_status: string;
  reason_code: string;
  note: string | null;
}

export interface RiderFeesTable {
  trip_id: string;
  rider_id: string;
  kind: "cancel" | "no_show";
  currency: string;
  amount_minor: ColumnType<string, number | string, number | string>;
  status: "owed" | "paid" | "waived" | "refunded";
  carried_by: string | null;
  created_at: Timestamp;
  settled_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
}

export interface EarningsEntriesTable {
  entry_id: string;
  driver_id: string;
  trip_id: string | null;
  kind: "trip" | "pickup_pay" | "fee_share" | "adjustment" | "tip" | "bonus";
  currency: string;
  amount_minor: ColumnType<string, number | string, number | string>;
  gross_minor: ColumnType<string | null, number | string | null | undefined, number | string | null>;
  commission_minor: ColumnType<string | null, number | string | null | undefined, number | string | null>;
  cash_minor: ColumnType<string | null, number | string | null | undefined, number | string | null>;
  at: Timestamp;
  /** contract v0.9.0 §16: the payout that paid this entry (never two). */
  payout_id: ColumnType<string | null, string | null | undefined, string | null>;
}

export interface RatingsTable {
  trip_id: string;
  rater: "rider" | "driver";
  stars: number;
  tags: ColumnType<string[], string[] | undefined, string[]>;
  comment: string | null;
  at: Timestamp;
  /** contract v0.9.0 §16: hidden by an admin (not in the average nor the low-rating signal). */
  hidden: Generated<boolean>;
  hidden_by: ColumnType<string | null, string | null | undefined, string | null>;
  hidden_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  hide_reason: ColumnType<string | null, string | null | undefined, string | null>;
}

/** contract v0.9.0 §16 (migration 0022). */
export interface PayoutsTable {
  payout_id: string;
  driver_id: string;
  zone_id: string | null;
  currency: string;
  amount_minor: ColumnType<string, number | string, number | string>;
  lines: ColumnType<unknown, string, string>;
  trip_count: number;
  source: "weekly" | "manual";
  status: ColumnType<"pending" | "paid", "pending" | "paid" | undefined, "pending" | "paid">;
  period_start: Timestamp;
  period_end: Timestamp;
  note: string | null;
  created_by: string | null;
  created_at: Timestamp;
  paid_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  paid_by: ColumnType<string | null, string | null | undefined, string | null>;
}

export interface SupportTicketsTable {
  ticket_id: string;
  opened_by: "rider" | "driver" | "admin";
  /** v0.18.9 owner rule 16: a case opened by an admin that the person sees in their own list. */
  visible_to_person: ColumnType<boolean, boolean | undefined, boolean>;
  rider_id: string | null;
  driver_id: string | null;
  trip_id: string | null;
  zone_id: string | null;
  category: string;
  subject: string;
  status: ColumnType<"open" | "pending" | "resolved" | "closed", "open" | "pending" | "resolved" | "closed" | undefined, "open" | "pending" | "resolved" | "closed">;
  priority: ColumnType<"low" | "normal" | "high" | "urgent", "low" | "normal" | "high" | "urgent" | undefined, "low" | "normal" | "high" | "urgent">;
  created_at: Timestamp;
  updated_at: Timestamp;
  last_message_at: Timestamp;
  /** v0.18.15 support desk (migration 0049). */
  assigned_admin_id: ColumnType<string | null, string | null | undefined, string | null>;
  claimed_until: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  solved_by: ColumnType<string | null, string | null | undefined, string | null>;
  solved_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  incident_id: ColumnType<string | null, string | null | undefined, string | null>;
  first_reply_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
}

/** v0.18.15 (migration 0049): Admin › Support › Settings per country. */
export interface SupportSettingsTable {
  country: string;
  doc: ColumnType<unknown, string, string>;
  updated_at: Timestamp;
  updated_by: string | null;
}

export interface TicketMessagesTable {
  /** Write order (two messages can share a timestamp). */
  n: Generated<string>;
  message_id: string;
  ticket_id: string;
  sender: "rider" | "driver" | "support";
  admin_id: string | null;
  text: string;
  at: Timestamp;
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

export interface WalletEntriesTable {
  entry_id: string;
  rider_id: string;
  kind: "topup" | "charge" | "refund" | "payout" | "adjustment";
  currency: string;
  amount_minor: ColumnType<string, number | string, number | string>;
  trip_id: string | null;
  at: Timestamp;
}

export interface RefundsTable {
  refund_id: string;
  trip_id: string;
  rider_id: string;
  currency: string;
  amount_minor: ColumnType<string, number | string, number | string>;
  reason: string;
  status: "pending_approval" | "done" | "rejected";
  approval_id: string | null;
  from_driver: Generated<boolean>;
  destination: "wallet" | "swish" | "bank" | null;
  payout_to: ColumnType<unknown, string | null | undefined, string | null>;
  payout_status: "pending" | "paid" | null;
  paid_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  paid_by: string | null;
  created_by: string;
  created_at: Timestamp;
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

// contract Notification: in-app notices for riders and drivers (GET /notifications).
export interface TripMessagesTable {
  message_id: string;
  trip_id: string;
  /** The trip event (trip_events.sequence) that carried the message: the chat's order. bigint; pg returns a string. */
  sequence: ColumnType<string, number | string, number | string>;
  sender: "rider" | "driver" | "support";
  sender_id: string;
  text: string;
  created_at: Timestamp;
}

export interface NotificationsTable {
  notification_id: string;
  audience: "rider" | "driver";
  subject_id: string;
  kind: string;
  title: string;
  body: string;
  deep_link: ColumnType<string | null, string | null | undefined, string | null>;
  trip_id: ColumnType<string | null, string | null | undefined, string | null>;
  data: JsonDefault<Record<string, unknown>>;
  read_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  created_at: Timestamp;
  /** v0.18.3 (R7): when the push dispatcher took it (sent or skipped); NULL = waiting. */
  pushed_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  /** v0.18.6 (G4 decision 1): false = push only (a new-offer push), never in GET /notifications. */
  bell: ColumnType<boolean, boolean | undefined, boolean>;
  /** v0.18.6: not sent after this time (the offer's expiresAt); NULL = the dispatcher's usual age limit. */
  push_until: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
}

// Every SMS asked for; skipped while no provider is connected.
export interface SmsOutboxTable {
  sms_id: string;
  phone: string;
  text: string;
  kind: string;
  status: "queued" | "sent" | "failed" | "skipped";
  provider: ColumnType<string | null, string | null | undefined, string | null>;
  provider_ref: ColumnType<string | null, string | null | undefined, string | null>;
  error: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: Timestamp;
  sent_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
}

// contract §8: Apple / Google identities linked to accounts, and the PHONE_REQUIRED link tokens.
export interface AuthProviderLinksTable {
  provider: "apple" | "google";
  provider_subject: string;
  actor: "rider" | "driver";
  subject_id: string;
  email: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: Timestamp;
}

export interface AuthLinkTokensTable {
  token_sha256: string;
  provider: "apple" | "google";
  provider_subject: string;
  app: "rider" | "driver";
  first_name: ColumnType<string | null, string | null | undefined, string | null>;
  last_name: ColumnType<string | null, string | null | undefined, string | null>;
  email: ColumnType<string | null, string | null | undefined, string | null>;
  expires_at: Timestamp;
  used_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  created_at: Timestamp;
}

/** contract v0.7.0 §15: SOS and "car lost" incidents (migration 0021). */
export interface IncidentsTable {
  incident_id: string;
  trip_id: string | null;
  kind: string;
  severity: "low" | "medium" | "high" | "critical";
  status: Generated<"open" | "investigating" | "resolved" | "dismissed">;
  version: Generated<number>;
  raised_by: "rider" | "driver" | "system";
  zone_id: string | null;
  rider_id: string | null;
  driver_id: string | null;
  position: ColumnType<unknown, string | null | undefined, string | null>;
  driver_fix: ColumnType<unknown, string | null | undefined, string | null>;
  opened_at: Timestamp;
  updated_at: Timestamp;
  escalated_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  taken_by: ColumnType<string | null, string | null | undefined, string | null>;
  taken_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  resolved_by: ColumnType<string | null, string | null | undefined, string | null>;
  resolved_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  resolution: ColumnType<string | null, string | null | undefined, string | null>;
  /** v0.12.0 §22 (migration 0029): rings the admin alarm and escalates. */
  alarm: Generated<boolean>;
  /** v0.12.0 §22: Incident.rideCheck, kind ride_check only. */
  ride_check: ColumnType<unknown, string | null | undefined, string | null>;
}

/** contract v0.12.0 §22: one ride check an app reported (migration 0029). */
export interface RideChecksTable {
  trip_id: string;
  side: "rider" | "driver";
  check_id: string;
  trigger: string;
  subject_id: string;
  shown_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  answer: ColumnType<"ok" | "need_help" | null, "ok" | "need_help" | null | undefined, "ok" | "need_help" | null>;
  answered_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  no_answer_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  position: ColumnType<unknown, string | null | undefined, string | null>;
  incident_id: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: Timestamp;
  /** v0.18.9: app = the app opened the card; server = the server asked (contract.json#onTrip.rideCheck). */
  origin: Generated<"app" | "server">;
}

/** v0.18.9 (migration 0043): a priced route change of a trip (contract.json#onTrip.routeChange). */
export interface RouteQuotesTable {
  route_quote_id: string;
  trip_id: string;
  trip_version: number;
  /** The trip's latest route change when priced (null = none): another change since makes the price stale. */
  base_change_id: string | null;
  dropoff: ColumnType<unknown, string, string>;
  stops: ColumnType<unknown, string, string>;
  distance_meters: number;
  duration_seconds: number;
  currency: string;
  total_minor: ColumnType<string, number | string, number | string>;
  difference_minor: ColumnType<string, number | string, number | string>;
  fare_lines: ColumnType<unknown, string, string>;
  driver_earnings_minor: ColumnType<string, number | string, number | string>;
  /** v0.18.9 owner rule 16: the trip had a fixed price and the zone's fixedPriceTrips was switch_to_normal. */
  leaves_fixed_price: ColumnType<boolean, boolean | undefined, boolean>;
  expires_at: Timestamp;
  used_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  created_at: Timestamp;
}

/** v0.18.9 (migration 0043): an admin's note on a trip. */
export interface AdminTripNotesTable {
  note_id: string;
  trip_id: string;
  admin_id: string;
  text: string;
  at: Timestamp;
}

export interface IncidentEventsTable {
  sequence: ColumnType<string, number | string, number | string>;
  event_id: string;
  incident_id: string;
  kind: "incident_opened" | "incident_updated" | "incident_escalated" | "incident_closed";
  zone_id: string | null;
  incident: ColumnType<unknown, string, string>;
  occurred_at: Timestamp;
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

export interface Database {
  surge_schedules: SurgeSchedulesTable;
  smart_surge_state: SmartSurgeStateTable;
  categories: CategoriesTable;
  riders: RidersTable;
  drivers: DriversTable;
  driver_locations: DriverLocationsTable;
  trips: TripsTable;
  trip_events: TripEventsTable;
  trip_messages: TripMessagesTable;
  idempotency_keys: IdempotencyKeysTable;
  timers: TimersTable;
  test_phones: TestPhonesTable;
  otp_sessions: OtpSessionsTable;
  sign_in_waitlist: SignInWaitlistTable;
  complete_previews: CompletePreviewsTable;
  sign_in_waitlist_asks: SignInWaitlistAsksTable;
  auth_sessions: AuthSessionsTable;
  refresh_tokens: RefreshTokensTable;
  push_devices: PushDevicesTable;
  admins: AdminsTable;
  admin_setup_links: AdminSetupLinksTable;
  admin_sign_in_failures: AdminSignInFailuresTable;
  zones: ZonesTable;
  config_drafts: ConfigDraftsTable;
  config_live: ConfigLiveTable;
  config_history: ConfigHistoryTable;
  approvals: ApprovalsTable;
  admin_audit: AdminAuditTable;
  quotes: QuotesTable;
  surge_samples: SurgeSamplesTable;
  vehicles: VehiclesTable;
  fleets: FleetsTable;
  fleet_join_attempts: FleetJoinAttemptsTable;
  document_upload_attempts: DocumentUploadAttemptsTable;
  telemetry: TelemetryTable;
  error_groups: ErrorGroupsTable;
  error_group_devices: ErrorGroupDevicesTable;
  documents: DocumentsTable;
  document_files: DocumentFilesTable;
  document_renewals: DocumentRenewalsTable;
  legal_texts: LegalTextsTable;
  legal_acceptances: LegalAcceptancesTable;
  document_notices: DocumentNoticesTable;
  sign_up_reminders: SignUpRemindersTable;
  fleet_invitations: FleetInvitationsTable;
  notifications: NotificationsTable;
  sms_outbox: SmsOutboxTable;
  auth_provider_links: AuthProviderLinksTable;
  auth_link_tokens: AuthLinkTokensTable;
  trip_locations: TripLocationsTable;
  searches: SearchesTable;
  offers: OffersTable;
  offer_events: OfferEventsTable;
  dispatch_controls: DispatchControlsTable;
  driver_cancels: DriverCancelsTable;
  rider_fees: RiderFeesTable;
  earnings_entries: EarningsEntriesTable;
  ratings: RatingsTable;
  wallet_entries: WalletEntriesTable;
  refunds: RefundsTable;
  incidents: IncidentsTable;
  incident_events: IncidentEventsTable;
  ride_checks: RideChecksTable;
  payouts: PayoutsTable;
  support_tickets: SupportTicketsTable;
  ticket_messages: TicketMessagesTable;
  support_settings: SupportSettingsTable;
  dispatch_events: DispatchEventsTable;
  dispatch_presets: DispatchPresetsTable;
  driver_groups: DriverGroupsTable;
  radar_zones: RadarZonesTable;
  radar_zone_rules: RadarZoneRulesTable;
  radar_zone_sends: RadarZoneSendsTable;
  area_events: AreaEventsTable;
  kpi_days: KpiDaysTable;
  content_items: ContentItemsTable;
  terms_acceptances: TermsAcceptancesTable;
  route_quotes: RouteQuotesTable;
  admin_trip_notes: AdminTripNotesTable;
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

export interface TermsAcceptancesTable {
  actor: "rider" | "driver";
  subject_id: string;
  zone_id: string;
  content_version: number;
  accepted_at: Date;
}
