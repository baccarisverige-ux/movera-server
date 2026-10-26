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
  consents: JsonDefault;
  deletion_requested_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
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
}

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
  /** The admin alert for a driver silent on board (owner decision 2026-10-26); see trips/ride.ts. */
  driver_silent_alert: ColumnType<unknown, string | null | undefined, string | null>;
  driver_summary: ColumnType<unknown, string | null | undefined, string | null>;
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
  status: "owed" | "paid" | "waived";
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
}

export interface RatingsTable {
  trip_id: string;
  rater: "rider" | "driver";
  stars: number;
  tags: ColumnType<string[], string[] | undefined, string[]>;
  comment: string | null;
  at: Timestamp;
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

export interface Database {
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
  fleets: FleetsTable;
  fleet_join_attempts: FleetJoinAttemptsTable;
  documents: DocumentsTable;
  document_files: DocumentFilesTable;
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
}
