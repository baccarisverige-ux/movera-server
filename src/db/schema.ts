import type { ColumnType, Generated } from "kysely";

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
  consents: JsonDefault;
  deletion_requested_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  rating_sum: Generated<number>;
  rating_count: Generated<number>;
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
  payment_method: string;
  payment_method_id: string | null;
  payment_status: string | null;
  rating_status: Generated<string>;
  waiting: Json | null;
  cancellation: Json | null;
  pin_required: Generated<boolean>;
  config_versions: JsonDefault;
  distance_meters: ColumnType<number | null, number | null | undefined, number | null>;
  duration_seconds: ColumnType<number | null, number | null | undefined, number | null>;
  surge_multiplier: ColumnType<string, number | string | undefined, number | string>;
  pricing_version: ColumnType<number | null, number | null | undefined, number | null>;
  quote_expires_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  notes: ColumnType<string | null, string | null | undefined, string | null>;
  search_step: ColumnType<unknown, string | null | undefined, string | null>;
  created_at: Timestamp;
  updated_at: Timestamp;
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
}

export type ConfigDoc = "rider_app_config" | "driver_app_config" | "pricing" | "dispatch";

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
  currency: string;
  total_minor: ColumnType<string, number | string, number | string>;
  fare_lines: Json;
  driver_earnings_minor: ColumnType<string, number | string, number | string>;
  pricing_version: number;
  payment_method: string | null;
  expires_at: Timestamp;
  used_at: Timestamp | null;
  created_at: Timestamp;
}

export interface VehiclesTable {
  vehicle_id: string;
  driver_id: string;
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

export interface Database {
  riders: RidersTable;
  drivers: DriversTable;
  driver_locations: DriverLocationsTable;
  trips: TripsTable;
  trip_events: TripEventsTable;
  idempotency_keys: IdempotencyKeysTable;
  timers: TimersTable;
  test_phones: TestPhonesTable;
  otp_sessions: OtpSessionsTable;
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
  vehicles: VehiclesTable;
  trip_locations: TripLocationsTable;
}
