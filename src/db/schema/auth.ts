/** Sign-in, sessions, devices, notices and other per-account plumbing. */
import type { ColumnType, Generated } from "kysely";
import type { Timestamp, Json, JsonDefault } from "./common.js";

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
  /** Deep fix 2026-11-02 (g1-g3 H2): the code was right (the per-number daily wrong-code lock counts the others). */
  verified: Generated<boolean>;
  /** Checker MED 3: an admin lifted the wrong-code lock (the row no longer counts). */
  unlocked_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
}

/** v0.18.14: a pending e-mail change (code sent to the new address). */
export interface EmailChangesTable {
  challenge_id: string;
  actor: "rider" | "driver";
  subject_id: string;
  email: string;
  code_sha256: string;
  attempts: number;
  expires_at: Timestamp;
  created_at: Timestamp;
}

/** Checker round: account change starts (rate limit) and notices waiting for an SMS / e-mail provider. */
export interface AccountChangeStartsTable { actor: "rider" | "driver"; subject_id: string; kind: "phone" | "email"; at: Timestamp }

export interface OutboundNoticesTable { notice_id: Generated<number>; channel: "sms" | "email"; to_address: string; kind: string; language: string; status: "pending_provider" | "sent"; created_at: Timestamp }

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
  /** v0.18.49 §71 (owner Q6): when this used token was accepted once more after the retry window (lost answer). */
  late_retry_at: Timestamp | null;
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
