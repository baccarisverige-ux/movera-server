import { createHash } from "node:crypto";
import { sql } from "kysely";
import { cursorOf, readCursor } from "../admin/lists.js";
import { audit } from "../admin/audit.js";
import type { Principal } from "../auth/guard.js";
import { contract } from "../contract/contract.js";
import type { Db, Executor, Trx } from "../db/db.js";
import { notFound } from "../http/errors.js";
import { newId } from "../ids.js";
import { scrub, scrubText } from "./scrub.js";

/**
 * Crashes & errors (contract v0.16.0 §11, `contract.json#telemetry.errorGroups`; owner 2026-10-29: "Want section on
 * dispatch to show all crash droids and bugs detected from server"). Crash reports from the apps and the server's own
 * unhandled 5xx errors are grouped by fingerprint: app + platform + normalized message + top stack frame. A group
 * marked fixed that occurs again is open again. At most maxEventsPerGroup reports are kept per group; the count goes on.
 */

type ErrorGroupsContract = { apps: string[]; platforms: string[]; statuses: string[]; maxEventsPerGroup: number };
const GROUPS = (contract as unknown as { telemetry: { errorGroups: ErrorGroupsContract } }).telemetry.errorGroups;

export const MAX_EVENTS_PER_GROUP = GROUPS.maxEventsPerGroup;
export const MAX_VERSIONS_PER_GROUP = 20;

export type ErrorApp = "driver" | "rider" | "server";
export type ErrorPlatform = "android" | "ios" | "web" | "server";
export type ErrorKind = "crash" | "error";
export type ErrorStatus = "open" | "fixed";

export type ErrorReport = {
  app: ErrorApp;
  platform: ErrorPlatform;
  kind: ErrorKind;
  /** Already scrubbed. */
  message: string;
  stack?: string | undefined;
  appVersion?: string | undefined;
  /** Who sent it (account or address); only its hash is kept. */
  device?: string | undefined;
  /** The scrubbed report as stored in telemetry. */
  body: Record<string, unknown>;
  actor?: string | null;
  subjectId?: string | null;
  at: Date;
};

/** The message with ids, numbers and hex replaced, so the same bug with other values is one group. */
export function normalizeMessage(message: string): string {
  const first = message.split("\n").find((line) => line.trim() !== "") ?? "";
  return first
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
    .replace(/\b[a-z]{3}_[0-9A-Z]{20,}\b/g, "<id>")
    .replace(/\b0x[0-9a-f]+\b/gi, "<hex>")
    .replace(/\b[0-9a-f]{8,}\b/gi, (m) => (/[a-f]/i.test(m) && /\d/.test(m) ? "<hex>" : m))
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

const FRAME = /^(at\s|#\d+\s)/;
const FILE = /\.(dart|js|mjs|cjs|ts|tsx|kt|java|swift|m)\b/;

/** The first stack line that names code, without its line and column numbers. Null when there is none. */
export function topFrame(stack: string | undefined): string | null {
  if (stack === undefined) return null;
  for (const raw of stack.split("\n")) {
    const line = raw.trim();
    if (line === "" || !(FRAME.test(line) || FILE.test(line))) continue;
    const frame = line
      .replace(/^#\d+\s+/, "")
      .replace(/:\d+(:\d+)?/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300);
    if (frame !== "") return frame;
  }
  return null;
}

export function fingerprint(app: string, platform: string, message: string, stack?: string): string {
  return createHash("sha256")
    .update([app, platform, normalizeMessage(message), topFrame(stack) ?? ""].join("\u0000"))
    .digest("hex");
}

const hash = (value: string) => createHash("sha256").update(`movera-error-device:${value}`).digest("hex").slice(0, 32);

/** Groups one report and keeps it (unless its group already keeps MAX_EVENTS_PER_GROUP reports). */
export async function recordError(db: Db, report: ErrorReport): Promise<string> {
  const message = report.message.slice(0, 1000) || "(no message)";
  const frame = topFrame(report.stack);
  const print = fingerprint(report.app, report.platform, message, report.stack);
  const version = report.appVersion?.trim() || null;
  return db.transaction().execute(async (trx) => {
    const versions = version === null ? sql<string[]>`error_groups.app_versions` : sql<string[]>`(array_prepend(${version}::text, array_remove(error_groups.app_versions, ${version}::text)))[1:${MAX_VERSIONS_PER_GROUP}]`;
    const row = await trx
      .insertInto("error_groups")
      .values({
        error_id: newId("err", report.at.getTime()),
        fingerprint: print,
        app: report.app,
        platform: report.platform,
        kind: report.kind,
        message,
        top_frame: frame,
        app_versions: version === null ? [] : [version],
        first_seen: report.at,
        last_seen: report.at,
      })
      .onConflict((c) =>
        c.column("fingerprint").doUpdateSet({
          count: sql<number>`error_groups.count + 1`,
          last_seen: sql<Date>`greatest(error_groups.last_seen, excluded.last_seen)`,
          message: sql<string>`excluded.message`,
          kind: sql<ErrorKind>`excluded.kind`,
          app_versions: versions,
          // A group marked fixed that occurs again is open again.
          status: "open",
          fixed_at: null,
        }),
      )
      .returning(["error_id"])
      .executeTakeFirstOrThrow();
    if (report.device !== undefined) {
      await trx
        .insertInto("error_group_devices")
        .values({ error_id: row.error_id, device: hash(report.device), last_seen: report.at })
        .onConflict((c) => c.columns(["error_id", "device"]).doUpdateSet({ last_seen: report.at }))
        .execute();
    }
    const kept = await trx.selectFrom("telemetry").select((eb) => eb.fn.countAll<string>().as("n")).where("error_id", "=", row.error_id).executeTakeFirstOrThrow();
    if (Number(kept.n) < MAX_EVENTS_PER_GROUP) {
      await trx
        .insertInto("telemetry")
        .values({ kind: "crash", level: null, event: null, actor: report.actor ?? null, subject_id: report.subjectId ?? null, body: JSON.stringify(report.body), at: report.at, error_id: row.error_id })
        .execute();
    }
    return row.error_id;
  });
}

/** The server's own unhandled error (app and platform server), scrubbed like an app's report. */
export async function recordServerError(db: Db, error: Error, context: { method: string; route: string; ip?: string; at: Date }): Promise<string> {
  const message = scrubText(`${error.name}: ${error.message}`);
  const stack = typeof error.stack === "string" ? scrubText(error.stack).slice(0, 12000) : undefined;
  const screen = `${context.method} ${context.route}`.slice(0, 200);
  return recordError(db, {
    app: "server",
    platform: "server",
    kind: "error",
    message,
    stack,
    ...(context.ip !== undefined ? { device: `ip:${context.ip}` } : {}),
    body: scrub({ error: message, ...(stack !== undefined ? { stack } : {}), app: "server", platform: "server", kind: "error", screen }) as Record<string, unknown>,
    at: context.at,
  });
}

export type ErrorGroupView = {
  id: string;
  app: ErrorApp;
  platform: ErrorPlatform;
  appVersions: string[];
  message: string;
  topFrame?: string;
  kind: ErrorKind;
  count: number;
  devices: number;
  firstSeen: string;
  lastSeen: string;
  status: ErrorStatus;
  fixedAt: string | null;
};

function groups(ex: Executor) {
  return ex
    .selectFrom("error_groups as g")
    .selectAll("g")
    .select((eb) => eb.selectFrom("error_group_devices as d").select((e) => e.fn.countAll<string>().as("n")).whereRef("d.error_id", "=", "g.error_id").as("devices"));
}

type GroupRow = Awaited<ReturnType<ReturnType<typeof groups>["executeTakeFirstOrThrow"]>>;

function view(r: GroupRow): ErrorGroupView {
  return {
    id: r.error_id,
    app: r.app,
    platform: r.platform,
    appVersions: r.app_versions,
    message: r.message,
    ...(r.top_frame !== null ? { topFrame: r.top_frame } : {}),
    kind: r.kind,
    count: r.count,
    devices: Number(r.devices ?? 0),
    firstSeen: r.first_seen.toISOString(),
    lastSeen: r.last_seen.toISOString(),
    status: r.status,
    fixedAt: r.fixed_at === null ? null : r.fixed_at.toISOString(),
  };
}

export type ErrorQuery = { cursor?: string | undefined; limit: number; app?: ErrorApp | undefined; platform?: ErrorPlatform | undefined; version?: string | undefined; status?: ErrorStatus | undefined };

/** GET /admin/errors: newest lastSeen first, cursor pages. */
export async function listErrorGroups(ex: Executor, input: ErrorQuery): Promise<{ items: ErrorGroupView[]; nextCursor: string | null }> {
  let query = groups(ex);
  if (input.app !== undefined) query = query.where("g.app", "=", input.app);
  if (input.platform !== undefined) query = query.where("g.platform", "=", input.platform);
  if (input.status !== undefined) query = query.where("g.status", "=", input.status);
  if (input.version !== undefined) query = query.where(sql<boolean>`${input.version}::text = ANY(g.app_versions)`);
  if (input.cursor !== undefined) {
    const c = readCursor(input.cursor);
    query = query.where((eb) => eb.or([eb("g.last_seen", "<", c.at), eb.and([eb("g.last_seen", "=", c.at), eb("g.error_id", ">", c.id)])]));
  }
  const rows = await query.orderBy("g.last_seen", "desc").orderBy("g.error_id").limit(input.limit + 1).execute();
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return { items: page.map(view), nextCursor: rows.length > input.limit && last ? cursorOf(last.last_seen, last.error_id) : null };
}

/** PATCH /admin/errors/{errorId}: open or fixed, audited. */
export async function setErrorStatus(trx: Trx, who: Principal, errorId: string, status: ErrorStatus, now: Date): Promise<ErrorGroupView> {
  const before = await trx.selectFrom("error_groups").select(["status"]).where("error_id", "=", errorId).forUpdate().executeTakeFirst();
  if (before === undefined) throw notFound("No such error group.");
  if (before.status !== status) {
    await trx
      .updateTable("error_groups")
      .set({ status, fixed_at: status === "fixed" ? now : null })
      .where("error_id", "=", errorId)
      .execute();
    await audit(trx, { adminId: who.subjectId, action: `error.${status}`, targetType: "error_group", targetId: errorId, detail: { from: before.status, to: status }, at: now });
  }
  return view(await groups(trx).where("g.error_id", "=", errorId).executeTakeFirstOrThrow());
}

/** contract §11: error groups not seen for keepDays go with their reports. S4 0.14b: at most `limit` groups per call. */
export async function purgeOldErrorGroups(ex: Executor, before: Date, limit?: number): Promise<number> {
  let query = ex.deleteFrom("error_groups").where("last_seen", "<", before);
  if (limit !== undefined) query = query.where("error_id", "in", ex.selectFrom("error_groups").select("error_id").where("last_seen", "<", before).limit(limit));
  const result = await query.executeTakeFirst();
  return Number(result.numDeletedRows);
}
