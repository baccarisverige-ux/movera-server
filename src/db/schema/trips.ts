/** Trips and everything recorded on one trip. */
import type { ColumnType, Generated, RawBuilder } from "kysely";
import type { Timestamp, Json, JsonDefault } from "./common.js";

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
  /** Deep fix 2026-11-02: the sum of every accepted route change's price difference (the early-end cap moves with it). */
  route_delta_minor: ColumnType<string, number | string | undefined, number | string>;
  offer_raised_minor: ColumnType<string, number | string | undefined, number | string>;
  driver_earnings_minor: ColumnType<string | null, number | string | null | undefined, number | string | null>;
  commission_minor: ColumnType<string | null, number | string | null | undefined, number | string | null>;
  pickup_pay_minor: ColumnType<string | null, number | string | null | undefined, number | string | null>;
  driver_bonus_minor: ColumnType<string | null, number | string | null | undefined, number | string | null>;
  /** v0.18.90 BQ-M21 (moneyBase.lostDriverPaid): what Movera paid on this trip to the driver(s) who lost it (admin reassign / cancel driverBonus). */
  lost_driver_paid_minor: ColumnType<string, number | string | undefined, number | string>;
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
  /** v0.18.17 (contract.json#bookLater): the booked ride's plan (reservations/service.ts ReservationState). */
  reservation: ColumnType<unknown, string | null | undefined, string | null>;
  /** v0.18.7 (status item 4): the pickup as booked, set on the first move; the move limit is measured from it. */
  booked_pickup: ColumnType<unknown, string | null | undefined, string | null>;
  arrived_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  boarded_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  started_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  ended_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  cash_collected_minor: ColumnType<string | null, number | string | null | undefined, number | string | null>;
  driver_rating_status: Generated<string>;
  accept_pickup_meters: ColumnType<number | null, number | null | undefined, number | null>;
  /** v0.18.33 (migration 0082): a live trip queued behind this driver's current trip, until it ends. */
  next_after_trip_id: ColumnType<string | null, string | null | undefined, string | null>;
  /** v0.18.33 (migration 0082, owner Q5): the trip was queued behind the driver's previous trip. */
  chained: ColumnType<boolean, boolean | undefined, boolean>;
  /** v0.18.33 (owner Q5): accept + lateFreeCancelMin of a chained trip. */
  chain_free_cancel_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
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
  /** v0.18.38 §62 (migration 0085): the CallView of a call_* event, or the relayed signal of call_signal. */
  call: ColumnType<unknown, string | null | undefined, string | null>;
}

/** v0.18.38 §62 (migration 0085): one in-app call between a trip's rider and driver. */
export interface TripCallsTable {
  call_id: string;
  trip_id: string;
  caller: "rider" | "driver";
  callee: "rider" | "driver";
  state: "ringing" | "answered" | "ended" | "missed";
  started_at: Timestamp;
  answered_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  ended_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  ended_reason: ColumnType<string | null, string | null | undefined, string | null>;
}

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

/** Owner decision 2026-11-10 (migration 0092): the road metres of a gap in a trip's trace (null: no road answer). */
export interface TripGapRoadsTable {
  trip_id: string;
  from_ts: Timestamp;
  to_ts: Timestamp;
  road_m: number | null;
  created_at: Timestamp;
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
  /** v0.18.56 §78 (migration 0090): the chip id when sent from a quick reply. */
  quick_reply_id: ColumnType<string | null, string | null | undefined, string | null>;
  /** v0.18.56 §78: arrived | on_my_way for the automatic messages (one of each per trip). */
  auto: ColumnType<"arrived" | "on_my_way" | null, "arrived" | "on_my_way" | null | undefined, "arrived" | "on_my_way" | null>;
  /** v0.18.64 §85 (migration 0097): Message.lang, the language the text was written in (sv | fr | en). */
  lang: ColumnType<"sv" | "fr" | "en" | null, "sv" | "fr" | "en" | null | undefined, "sv" | "fr" | "en" | null>;
}

/** v0.18.64 §85 (chat.autoTranslate.cache, migration 0097): one kept translation per message and target language. */
export interface TripMessageTranslationsTable {
  message_id: string;
  lang: "sv" | "fr" | "en";
  text: string;
  created_at: Timestamp;
}

/** v0.18.56 §78 (inAppCalls.push, migration 0090): the trip streams open right now on any server copy. */
export interface TripStreamPresenceTable {
  stream_id: string;
  trip_id: string;
  actor: string;
  subject_id: string;
  seen_at: Timestamp;
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

/** v0.18.43 §64 (fix job 10, migration 0087): a rider and a driver never matched again (active while removed_at is null). */
export interface BlockedPairsTable {
  pair_id: string;
  rider_id: string;
  driver_id: string;
  blocked_by: "admin" | "rider" | "driver";
  reason: string | null;
  trip_id: string | null;
  admin_id: string | null;
  at: Date;
  removed_at: Date | null;
  removed_by: string | null;
}
