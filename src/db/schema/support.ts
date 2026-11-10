/** Support tickets, alerts, reviews and incidents. */
import type { ColumnType, Generated } from "kysely";
import type { Timestamp } from "./common.js";

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
  solved_by: ColumnType<string | null, string | null | undefined, string | null>;
  solved_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  incident_id: ColumnType<string | null, string | null | undefined, string | null>;
  first_reply_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  /** Owner 2026-11-03: the ticket's country (zone's, else the person's phone prefix). */
  country: ColumnType<string | null, string | null | undefined, string | null>;
  feedback_text: ColumnType<string | null, string | null | undefined, string | null>;
  feedback_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
}

/** v0.18.15 (migration 0049): Admin › Support › Settings per country. */
export interface SupportSettingsTable {
  country: string;
  rev: Generated<number>;
  doc: ColumnType<unknown, string, string>;
  updated_at: Timestamp;
  updated_by: string | null;
}

/** v0.18.15 alerts full flow (migration 0049). */
export interface AdminAlertBookTable {
  country: string;
  rev: Generated<number>;
  settings: ColumnType<unknown, string | undefined, string>;
  rules: ColumnType<unknown, string | undefined, string>;
  mutes: ColumnType<unknown, string | undefined, string>;
  updated_at: Generated<Date>;
}

export interface AdminAlertRecordsTable {
  alert_id: string;
  kind: string;
  level: "critical" | "important" | "info";
  title: string;
  zone_id: string | null;
  since: Timestamp;
  status: "new" | "taken" | "done" | "snoozed";
  owner: string | null;
  snooze_until: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  events: ColumnType<unknown, string, string>;
  updated_at: Timestamp;
}

export interface AdminAlertQuietTable {
  admin_id: string;
  quiet_on: boolean;
  from_hm: string;
  to_hm: string;
  updated_at: Timestamp;
}

/** v0.18.15 (migration 0049): Admin › Incidents › Settings. */
export interface AdminIncidentSettingsTable {
  country: string;
  rev: Generated<number>;
  settings: ColumnType<unknown, string | undefined, string>;
  updated_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  updated_by: string | null;
}

/** v0.18.15 (migration 0049): review rules per country and where each rated person stands. */
export interface ReviewRulesTable {
  country: string;
  doc: ColumnType<unknown, string, string>;
  updated_at: Timestamp;
  updated_by: string | null;
}

export interface ReviewPeopleTable {
  who: "driver" | "rider";
  person_id: string;
  country: string | null;
  level: "warn" | "review";
  average: ColumnType<string, number, number>;
  count: number;
  since: Timestamp;
  queued: ColumnType<boolean, boolean | undefined, boolean>;
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

export interface IncidentEventsTable {
  sequence: ColumnType<string, number | string, number | string>;
  event_id: string;
  incident_id: string;
  kind: "incident_opened" | "incident_updated" | "incident_escalated" | "incident_closed";
  zone_id: string | null;
  incident: ColumnType<unknown, string, string>;
  occurred_at: Timestamp;
}
