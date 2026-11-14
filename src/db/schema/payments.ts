/** Fees, earnings, payouts, wallets and refunds. */
import type { ColumnType, Generated } from "kysely";
import type { Timestamp } from "./common.js";

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
  kind: "trip" | "pickup_pay" | "fee_share" | "adjustment" | "tip" | "bonus" | "paid_to_movera";
  currency: string;
  amount_minor: ColumnType<string, number | string, number | string>;
  gross_minor: ColumnType<string | null, number | string | null | undefined, number | string | null>;
  commission_minor: ColumnType<string | null, number | string | null | undefined, number | string | null>;
  cash_minor: ColumnType<string | null, number | string | null | undefined, number | string | null>;
  at: Timestamp;
  /** contract v0.9.0 §16: the payout that paid this entry (never two). */
  payout_id: ColumnType<string | null, string | null | undefined, string | null>;
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
  /** v0.18.39 A2 (owner Q4): pending_approval = a manual country's run waiting for an admin. */
  status: ColumnType<"pending" | "pending_approval" | "paid", "pending" | "pending_approval" | "paid" | undefined, "pending" | "pending_approval" | "paid">;
  approved_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  approved_by: ColumnType<string | null, string | null | undefined, string | null>;
  period_start: Timestamp;
  period_end: Timestamp;
  note: string | null;
  created_by: string | null;
  created_at: Timestamp;
  paid_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  paid_by: ColumnType<string | null, string | null | undefined, string | null>;
}

export interface WalletEntriesTable {
  entry_id: string;
  rider_id: string;
  kind: "topup" | "charge" | "refund" | "payout" | "adjustment" | "fee" | "debt_paid";
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
