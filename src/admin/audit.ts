import type { Executor } from "../db/db.js";

/** Append one line to the admin audit (who changed what). Written in the same transaction as the change. */
export async function audit(
  ex: Executor,
  entry: { adminId: string | null; action: string; targetType: string; targetId: string; zoneId?: string | null; detail?: unknown; at?: Date },
): Promise<void> {
  await ex
    .insertInto("admin_audit")
    .values({
      admin_id: entry.adminId,
      action: entry.action,
      target_type: entry.targetType,
      target_id: entry.targetId,
      zone_id: entry.zoneId ?? null,
      detail: JSON.stringify(entry.detail ?? {}),
      at: entry.at ?? new Date(),
    })
    .execute();
}
