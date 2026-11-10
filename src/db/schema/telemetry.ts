/** App telemetry, crash and error reports. */
import type { ColumnType, Generated } from "kysely";
import type { Timestamp, JsonDefault } from "./common.js";

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
