import { contract } from "../contract/contract.js";
import type { Executor } from "../db/db.js";
import type { OfflineReason } from "../db/schema.js";
import { notify } from "../notifications/service.js";

/**
 * Contract v0.18.6 §32 (owner 2026-10-31 "Send the real reason", contract.json#driverHome.setOffline.offlineReason):
 * every time the server sets a driver offline it stores why (Driver.offlineReason, offlineNote, offlineAt; cleared when
 * he goes online) and sends the set_offline bell + push notice with data.reason, so the driver app's offline card shows
 * the real reason in sv / fr / en.
 */

type Lang = "sv" | "fr" | "en";
type SetOffline = { noticeKind: string; deepLink: string; text: { title: Record<Lang, string>; body: Record<Lang, string> }; reasons: Record<string, Record<Lang, string>> };
const SET_OFFLINE = (contract as unknown as { driverHome: { setOffline: SetOffline } }).driverHome.setOffline;

const lang = (language: string | null | undefined): Lang => (language === "sv" || language === "fr" ? language : "en");
const fill = (text: string, values: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (all, key: string) => (values[key] === undefined ? all : String(values[key])));

export async function markSetOffline(ex: Executor, driverId: string, reason: OfflineReason, extra: { note?: string | null; minutes?: number; count?: number }, now: Date): Promise<void> {
  const note = reason === "vehicle_blocked" && extra.note ? extra.note : null;
  const row = await ex.updateTable("drivers").set({ offline_reason: reason, offline_note: note, offline_at: now }).where("driver_id", "=", driverId).returning("language").executeTakeFirst();
  if (row === undefined) return;
  const language = lang(row.language);
  const values = { ...(extra.minutes !== undefined ? { minutes: extra.minutes } : {}), ...(extra.count !== undefined ? { count: extra.count } : {}) };
  // no_position keeps its G3 body "Tap to go online again"; every other reason says why.
  const body = reason === "no_position" ? SET_OFFLINE.text.body[language] : fill(SET_OFFLINE.reasons[reason]![language], values);
  await notify(
    ex,
    {
      audience: "driver",
      subjectId: driverId,
      kind: SET_OFFLINE.noticeKind,
      title: SET_OFFLINE.text.title[language],
      body,
      deepLink: SET_OFFLINE.deepLink,
      // Deep fix 2026-11-02: every language, so the Notifications list follows the app's language later.
      data: { reason, ...(note ? { note } : {}), ...values, texts: { title: SET_OFFLINE.text.title, body: Object.fromEntries((["sv", "fr", "en"] as Lang[]).map((l) => [l, reason === "no_position" ? SET_OFFLINE.text.body[l] : fill(SET_OFFLINE.reasons[reason]![l], values)])) } },
    },
    now,
  );
}

/** Going online (or offline by his own hand) forgets the last reason. */
export const CLEAR_OFFLINE_REASON = { offline_reason: null, offline_note: null, offline_at: null } as const;
