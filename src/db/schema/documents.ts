/** Driver documents, legal texts and their acceptances. */
import type { ColumnType, Generated } from "kysely";
import type { Timestamp, Json, JsonDefault } from "./common.js";

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

export interface TermsAcceptancesTable {
  actor: "rider" | "driver";
  subject_id: string;
  zone_id: string;
  content_version: number;
  accepted_at: Date;
}
