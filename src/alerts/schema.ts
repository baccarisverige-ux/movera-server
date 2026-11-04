import type { ColumnType } from "kysely";

/**
 * v0.18.20 (migration 0066, contract.json#alertDesk.serverDetection): the tables of the server's alert detector. Kept
 * out of db/schema.ts on purpose (Rules rule 25: schema.ts is waiting for its split), added to Database here.
 */
type Json = ColumnType<unknown, string, string>;
type JsonOpt = ColumnType<unknown, string | null | undefined, string | null>;

export interface AdminAlertsLiveTable {
  alert_id: string;
  cause_key: string;
  kind: string;
  country: string;
  zone_id: string | null;
  level: "critical" | "important" | "info";
  title: string;
  title_t: Json;
  detail: ColumnType<string, string | undefined, string>;
  detail_t: JsonOpt;
  since: ColumnType<Date, Date, Date>;
  state: "open" | "solved" | "closed";
  cause_live: ColumnType<boolean, boolean | undefined, boolean>;
  solved_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  solved_t: JsonOpt;
  ref: ColumnType<unknown, string | undefined, string>;
  seen_at: ColumnType<Date, Date, Date>;
  updated_at: ColumnType<Date, Date, Date>;
}

export interface AdminAlertRuleStateTable {
  rule_key: string;
  holding_since: ColumnType<Date, Date, Date>;
}

declare module "../db/schema.js" {
  interface Database {
    admin_alerts_live: AdminAlertsLiveTable;
    admin_alert_rule_state: AdminAlertRuleStateTable;
  }
}
