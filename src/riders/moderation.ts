import { z } from "zod";
import type { Executor, Trx } from "../db/db.js";
import { ApiError, badRequest } from "../http/errors.js";

/**
 * v0.18.16 A2 (owner G16 Q16-1 + Q16-2 "Warn → Pause → Ban", contract.json#riderModeration): every level has a
 * reason; warning keeps the rider riding (they see the notice); paused (1..365 days, ends by itself) and banned
 * make riders.status suspended, so sign-in and booking answer 403 account_suspended with the moderation as
 * projection. Level none undoes it.
 */

export type ModerationLevel = "none" | "warning" | "paused" | "banned";
export const MODERATION_LEVELS = ["none", "warning", "paused", "banned"] as const;
export const PAUSE_DAYS = { min: 1, max: 365 } as const;
const DAY_MS = 24 * 60 * 60 * 1000;

type ModerationRow = {
  status?: string;
  moderation_level?: string | null;
  moderation_reason?: string | null;
  moderation_until?: Date | null;
  moderation_set_at?: Date | null;
};

/** Rider.moderation for the rider and admin views. */
export function moderationView(row: ModerationRow): { level: ModerationLevel; reason?: string; until: string | null; setAt?: string } {
  const level = (row.moderation_level ?? "none") as ModerationLevel;
  return {
    level,
    ...(row.moderation_reason ? { reason: row.moderation_reason } : {}),
    until: level === "paused" && row.moderation_until ? row.moderation_until.toISOString() : null,
    ...(row.moderation_set_at ? { setAt: row.moderation_set_at.toISOString() } : {}),
  };
}

/** True while the rider may not sign in or book: suspended, except a pause whose end has passed (the sweep clears it). */
export function riderBlocked(row: ModerationRow, now: Date): boolean {
  if (row.status !== "suspended") return false;
  if (row.moderation_level === "paused" && row.moderation_until && row.moderation_until.getTime() <= now.getTime()) return false;
  return true;
}

/** The 403 a blocked rider gets (sign-in and booking). */
export function suspendedError(row: ModerationRow): ApiError {
  return new ApiError("forbidden", "This account is suspended.", { reason: "account_suspended", projection: moderationView(row) });
}

export const ModerationBody = z.object({
  expectedVersion: z.number().int().min(1),
  level: z.enum(MODERATION_LEVELS),
  reason: z.string().trim().min(1).max(300),
  pauseDays: z.number().int().min(PAUSE_DAYS.min).max(PAUSE_DAYS.max).optional(),
});
export type ModerationInput = z.infer<typeof ModerationBody>;

/** The columns a level sets (status included). */
export function moderationColumns(input: { level: ModerationLevel; reason: string | null; pauseDays?: number }, now: Date) {
  if (input.level === "paused" && input.pauseDays === undefined) throw badRequest("Say for how many days the rider is paused.", "pause_days_required");
  if (input.level !== "paused" && input.pauseDays !== undefined) throw badRequest("Only a pause has a number of days.", "pause_days_not_allowed");
  const blocked = input.level === "paused" || input.level === "banned";
  return {
    status: (blocked ? "suspended" : "active") as "active" | "suspended",
    moderation_level: input.level,
    moderation_reason: input.level === "none" ? null : input.reason,
    moderation_until: input.level === "paused" ? new Date(now.getTime() + input.pauseDays! * DAY_MS) : null,
    moderation_set_at: input.level === "none" ? null : now,
  };
}

/** Hourly sweep: a pause that ended makes the rider active again (level none, written nowhere else). */
export async function liftEndedPauses(ex: Executor | Trx, now: Date): Promise<number> {
  const rows = await ex
    .updateTable("riders")
    .set((eb) => ({ status: "active", moderation_level: "none", moderation_reason: null, moderation_until: null, moderation_set_at: null, version: eb("version", "+", 1), updated_at: now }))
    .where("moderation_level", "=", "paused")
    .where("moderation_until", "<=", now)
    .returning("rider_id")
    .execute();
  return rows.length;
}
