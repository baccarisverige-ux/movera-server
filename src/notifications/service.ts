import { sql } from "kysely";
import type { Executor } from "../db/db.js";
import { badRequest, notFound } from "../http/errors.js";
import { newId } from "../ids.js";

/**
 * In-app notifications (contract `Notification`, GET /notifications, POST /notifications/{id}/read): one row per
 * notice to a rider or driver, newest first; the app polls them and marks them read. Written inside the command
 * that causes them, so a notice never exists without its cause.
 */

export type Audience = "rider" | "driver";

type NotificationRow = {
  notification_id: string;
  audience: Audience;
  subject_id: string;
  kind: string;
  title: string;
  body: string;
  deep_link: string | null;
  trip_id: string | null;
  data: Record<string, unknown>;
  read_at: Date | null;
  created_at: Date;
};

/**
 * Deep fix 2026-11-02 (live sweep: "old texts stay Swedish"): a notice that carries data.texts { title, body } in every
 * language is shown in the reader's language now; others as written.
 */
export function notificationView(row: NotificationRow, language?: string | null) {
  const texts = (row.data as { texts?: { title?: Record<string, string>; body?: Record<string, string> } }).texts;
  const lang = language && texts?.title?.[language] ? language : null;
  const { texts: _t, ...data } = row.data as Record<string, unknown>;
  void _t;
  row = { ...row, data };
  return {
    notificationId: row.notification_id,
    audience: row.audience,
    kind: row.kind,
    title: lang ? texts!.title![lang]! : row.title,
    body: lang && texts?.body?.[lang] ? texts.body[lang]! : row.body,
    at: row.created_at.toISOString(),
    read: row.read_at !== null,
    ...(row.trip_id ? { tripId: row.trip_id } : {}),
    ...(row.deep_link ? { deepLink: row.deep_link } : {}),
    ...(Object.keys(row.data).length ? { data: row.data } : {}),
  };
}

/**
 * After a notice is written, the push dispatcher (src/push/dispatcher.ts) is kicked: it sends the push only once the
 * command has committed, outside this transaction, so a push never slows or breaks the command (contract v0.18.3 R7).
 */
const notifyListeners = new Set<() => void>();
export function onNotify(listener: () => void): () => void {
  notifyListeners.add(listener);
  return () => notifyListeners.delete(listener);
}

export async function notify(
  ex: Executor,
  notice: {
    audience: Audience;
    subjectId: string;
    kind: string;
    title: string;
    body: string;
    deepLink?: string;
    tripId?: string;
    data?: Record<string, unknown>;
    /** v0.18.6 (G4 decision 1): false = push only, never a bell notice (the new-offer push). */
    bell?: boolean;
    /** v0.18.6: not pushed after this time (the offer's expiresAt). */
    pushUntil?: Date;
  },
  now: Date,
): Promise<string> {
  const notificationId = newId("ntf", now.getTime());
  await ex
    .insertInto("notifications")
    .values({
      notification_id: notificationId,
      audience: notice.audience,
      subject_id: notice.subjectId,
      kind: notice.kind,
      title: notice.title,
      body: notice.body,
      deep_link: notice.deepLink ?? null,
      trip_id: notice.tripId ?? null,
      data: JSON.stringify(notice.data ?? {}),
      created_at: now,
      ...(notice.bell === false ? { bell: false } : {}),
      ...(notice.pushUntil ? { push_until: notice.pushUntil } : {}),
    })
    .execute();
  for (const listener of notifyListeners) {
    try {
      listener();
    } catch {
      // a push kick never breaks the command
    }
  }
  return notificationId;
}

/** GET /notifications?cursor&limit&unreadOnly: newest first; cursor = the last row's (createdAt, id). */
export async function listNotifications(ex: Executor, who: { audience: Audience; subjectId: string }, input: { cursor?: string | undefined; limit: number; unreadOnly?: boolean | undefined }) {
  // v0.18.6: push-only rows (bell = false, the new-offer push) are never bell notices.
  let q = ex.selectFrom("notifications").selectAll().where("audience", "=", who.audience).where("subject_id", "=", who.subjectId).where("bell", "=", true);
  if (input.unreadOnly) q = q.where("read_at", "is", null);
  if (input.cursor) {
    const [at, id] = Buffer.from(input.cursor, "base64url").toString("utf8").split("|");
    if (!at || !id || Number.isNaN(Date.parse(at))) throw badRequest("The cursor is not valid.", "invalid_cursor");
    q = q.where(sql<boolean>`(created_at, notification_id) < (${new Date(at)}, ${id})`);
  }
  const rows = await q.orderBy("created_at", "desc").orderBy("notification_id", "desc").limit(input.limit + 1).execute();
  const page = rows.slice(0, input.limit) as unknown as NotificationRow[];
  const last = page[page.length - 1];
  const person = who.audience === "rider"
    ? await ex.selectFrom("riders").select("language").where("rider_id", "=", who.subjectId).executeTakeFirst()
    : await ex.selectFrom("drivers").select("language").where("driver_id", "=", who.subjectId).executeTakeFirst();
  return {
    items: page.map((r) => notificationView(r, person?.language)),
    nextCursor: rows.length > input.limit && last ? Buffer.from(`${last.created_at.toISOString()}|${last.notification_id}`).toString("base64url") : null,
  };
}

/** POST /notifications/{id}/read: own notices only; reading twice is fine. */
export async function markNotificationRead(ex: Executor, who: { audience: Audience; subjectId: string }, notificationId: string, now: Date) {
  const row = await ex.selectFrom("notifications").selectAll().where("notification_id", "=", notificationId).executeTakeFirst();
  if (row === undefined || row.audience !== who.audience || row.subject_id !== who.subjectId || row.bell === false) throw notFound("No such notification.", "notification_not_found");
  if (row.read_at === null) await ex.updateTable("notifications").set({ read_at: now }).where("notification_id", "=", notificationId).execute();
  return notificationView({ ...(row as unknown as NotificationRow), read_at: row.read_at ?? now });
}

/** Unread notices of one kind, for a badge. */
export async function unreadCount(ex: Executor, who: { audience: Audience; subjectId: string }, kind?: string): Promise<number> {
  let q = ex.selectFrom("notifications").select((eb) => eb.fn.countAll<string>().as("n")).where("audience", "=", who.audience).where("subject_id", "=", who.subjectId).where("bell", "=", true).where("read_at", "is", null);
  if (kind) q = q.where("kind", "=", kind);
  return Number((await q.executeTakeFirstOrThrow()).n);
}
