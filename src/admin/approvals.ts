import { sql } from "kysely";
import type { Db, Trx } from "../db/db.js";
import type { ApprovalsTable } from "../db/schema.js";
import type { Principal } from "../auth/guard.js";
import { adminCoversZone } from "../auth/guard.js";
import { ApiError, badRequest } from "../http/errors.js";
import { newId } from "../ids.js";
import { audit } from "./audit.js";
import type { Selectable } from "kysely";

/**
 * The two-person rule (contract §3.1). A Super admin's big change runs at once and is audited (owner decision 14);
 * anyone else's waits as an approval that a different admin with the approve permission decides. The change runs
 * through a handler registered per action, inside the approver's transaction.
 */

export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

export type ApprovalHandler = (trx: Trx, payload: Record<string, unknown>, approvedBy: string | null, requestedBy: string, now: Date) => Promise<unknown>;

export type ApprovalRequest = {
  action: string;
  targetType: Selectable<ApprovalsTable>["target_type"];
  targetId: string;
  zoneId: string | null;
  payload: Record<string, unknown>;
  approvePermission: string;
};

export type PendingApproval = { status: "pending_approval"; approvalId: string; action: string; targetId: string; requestedAt: string };

export type RunOutcome<T> = { ran: true; result: T } | { ran: false; pending: PendingApproval };

const handlers = new Map<string, ApprovalHandler>();

export function registerApprovalHandler(action: string, handler: ApprovalHandler): void {
  handlers.set(action, handler);
}

export const isApprovalExempt = (who: Principal) => who.role === "super";

/** Runs the change now for an approval-exempt admin, otherwise files it for a second admin. */
export async function runOrRequest<T>(trx: Trx, who: Principal, request: ApprovalRequest, now: Date): Promise<RunOutcome<T>> {
  const handler = handlers.get(request.action);
  if (handler === undefined) throw new Error(`No approval handler for ${request.action}`);
  {
    if (isApprovalExempt(who)) {
      const result = (await handler(trx, request.payload, null, who.subjectId, now)) as T;
      await audit(trx, { adminId: who.subjectId, action: request.action, targetType: request.targetType, targetId: request.targetId, zoneId: request.zoneId, detail: { direct: true, ...request.payload }, at: now });
      return { ran: true as const, result };
    }
    const approvalId = newId("apr", now.getTime());
    await trx
      .insertInto("approvals")
      .values({
        approval_id: approvalId,
        action: request.action,
        target_type: request.targetType,
        target_id: request.targetId,
        payload: JSON.stringify(request.payload),
        approve_permission: request.approvePermission,
        zone_id: request.zoneId,
        requested_by: who.subjectId,
        requested_at: now,
        expires_at: new Date(now.getTime() + APPROVAL_TTL_MS),
        decided_by: null,
        decided_at: null,
        decision_note: null,
      })
      .execute();
    await audit(trx, { adminId: who.subjectId, action: `${request.action}.requested`, targetType: request.targetType, targetId: request.targetId, zoneId: request.zoneId, detail: { approvalId, ...request.payload }, at: now });
    return { ran: false as const, pending: { status: "pending_approval" as const, approvalId, action: request.action, targetId: request.targetId, requestedAt: now.toISOString() } };
  }
}

export type ApprovalView = {
  approvalId: string;
  action: string;
  targetType: string;
  targetId: string;
  status: "pending_approval" | "approved" | "rejected" | "expired";
  requestedBy: string;
  requestedAt: string;
  decidedBy?: string;
  decidedAt?: string;
  decisionNote?: string;
};

function view(row: Selectable<ApprovalsTable>, now: Date): ApprovalView {
  // A pending approval past its 24 h shows as expired, whether or not anything rewrote the row yet.
  const status = row.status === "pending_approval" && row.expires_at.getTime() <= now.getTime() ? "expired" : row.status;
  return {
    approvalId: row.approval_id,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    status,
    requestedBy: row.requested_by,
    requestedAt: row.requested_at.toISOString(),
    ...(row.decided_by ? { decidedBy: row.decided_by } : {}),
    ...(row.decided_at ? { decidedAt: row.decided_at.toISOString() } : {}),
    ...(row.decision_note ? { decisionNote: row.decision_note } : {}),
  };
}

export async function decideApproval(trx: Trx, who: Principal, approvalId: string, decision: "approve" | "reject", note: string | undefined, now: Date): Promise<ApprovalView> {
  {
    const row = await trx.selectFrom("approvals").selectAll().where("approval_id", "=", approvalId).forUpdate().executeTakeFirst();
    if (row === undefined) throw new ApiError("not_found", "No such approval.", { reason: "approval_not_found" });
    const current = view(row, now);
    if (current.status !== "pending_approval") throw new ApiError("conflict", `This approval is already ${current.status}.`, { reason: `approval_${current.status}` });
    if (row.requested_by === who.subjectId) throw new ApiError("forbidden", "A second admin must decide your own request.", { reason: "own_request" });
    if (!isApprovalExempt(who) && !(who.perms ?? []).includes(row.approve_permission)) {
      throw new ApiError("forbidden", "You do not have permission to decide this.", { reason: "missing_permission" });
    }
    if (row.zone_id !== null && !adminCoversZone(who, row.zone_id)) throw new ApiError("forbidden", "This zone is outside your scope.", { reason: "zone_out_of_scope" });
    if (decision === "approve") {
      const handler = handlers.get(row.action);
      if (handler === undefined) throw new Error(`No approval handler for ${row.action}`);
      await handler(trx, row.payload as Record<string, unknown>, who.subjectId, row.requested_by, now);
    }
    const status = decision === "approve" ? "approved" : "rejected";
    await trx
      .updateTable("approvals")
      .set({ status, decided_by: who.subjectId, decided_at: now, decision_note: note ?? null })
      .where("approval_id", "=", approvalId)
      .execute();
    await audit(trx, { adminId: who.subjectId, action: `${row.action}.${status}`, targetType: row.target_type, targetId: row.target_id, zoneId: row.zone_id, detail: { approvalId, note }, at: now });
    return view({ ...row, status, decided_by: who.subjectId, decided_at: now, decision_note: note ?? null }, now);
  }
}

const STATUSES = ["pending_approval", "approved", "rejected", "expired"] as const;

/** GET /admin/approvals: newest first, cursor = the last row's (requestedAt, approvalId). */
export async function listApprovals(
  db: Db,
  who: Principal,
  input: { statuses?: string[]; targetType?: string; cursor?: string; limit: number },
  now: Date,
): Promise<{ items: ApprovalView[]; nextCursor: string | null }> {
  const statuses = input.statuses ?? [];
  for (const status of statuses) if (!(STATUSES as readonly string[]).includes(status)) throw badRequest(`Unknown status ${status}.`, "invalid_query");
  let query = db.selectFrom("approvals").selectAll();
  // Like every admin list: only the admin's zones (an approval with no zone is for everyone who may decide).
  if (!who.zones.includes("*")) query = query.where((eb) => eb.or([eb("zone_id", "is", null), eb("zone_id", "in", who.zones.length ? who.zones : ["-"])]));
  if (input.targetType) query = query.where("target_type", "=", input.targetType as Selectable<ApprovalsTable>["target_type"]);
  if (statuses.length > 0) {
    const wantExpired = statuses.includes("expired");
    const wantPending = statuses.includes("pending_approval");
    const stored = statuses.filter((s) => s !== "expired" && s !== "pending_approval") as Array<"approved" | "rejected">;
    query = query.where((eb) =>
      eb.or([
        ...(stored.length ? [eb("status", "in", stored)] : []),
        ...(wantPending ? [eb.and([eb("status", "=", "pending_approval"), eb("expires_at", ">", now)])] : []),
        ...(wantExpired ? [eb("status", "=", "expired"), eb.and([eb("status", "=", "pending_approval"), eb("expires_at", "<=", now)])] : []),
      ]),
    );
  }
  if (input.cursor) {
    const [at, id] = Buffer.from(input.cursor, "base64url").toString("utf8").split("|");
    if (!at || !id || Number.isNaN(Date.parse(at))) throw badRequest("The cursor is not valid.", "invalid_cursor");
    query = query.where(sql<boolean>`(requested_at, approval_id) < (${new Date(at)}, ${id})`);
  }
  const rows = await query.orderBy("requested_at", "desc").orderBy("approval_id", "desc").limit(input.limit + 1).execute();
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    items: page.map((row) => view(row, now)),
    nextCursor: rows.length > input.limit && last ? Buffer.from(`${last.requested_at.toISOString()}|${last.approval_id}`).toString("base64url") : null,
  };
}
