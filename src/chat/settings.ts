import { liveDocument } from "../config/service.js";
import { contract } from "../contract/contract.js";
import type { Executor } from "../db/db.js";

/**
 * v0.18.56 §78 (G9 part 2, owner rule 16; contract.json#chat.settings): CountryRules.chat of the trip's zone (its own
 * country_rules, else its country's Standard), else configDefaults.chat. A missing value, or one outside its range,
 * reads as the default, field by field (like CountryRules.calls, src/calls/settings.ts).
 */

export type Lang = "sv" | "fr" | "en";
export type Texts = Record<Lang, string>;
export type QuickReply = { id: string; text: Texts };
export type ChatSettings = {
  keepDays: number;
  maxLength: number;
  spamPerMin: number;
  sound: boolean;
  sheetAutoOpen: "new_message" | "off";
  readAloudDefault: boolean;
  translation: boolean;
  quickRepliesOn: boolean;
  quickReplies: { driver: QuickReply[]; rider: QuickReply[] };
  autoArrived: { on: boolean; text: Texts };
};
type Range = [number, number];
type ChatContract = {
  settings: { ranges: Record<string, Range> };
  header: { text: Texts };
  onTheWay: { text: Texts };
};
const C = contract as unknown as { configDefaults: { chat: ChatSettings }; chat: ChatContract };
export const CHAT_DEFAULTS: ChatSettings = C.configDefaults.chat;
export const CHAT_HEADER_LINE: Texts = C.chat.header.text;
export const ON_MY_WAY_TEXT: Texts = C.chat.onTheWay.text;
const RANGES = C.chat.settings.ranges;
const LANGS: readonly Lang[] = ["sv", "fr", "en"];
const ID = /^[a-z][a-z0-9_]{0,39}$/;

export const isLang = (v: unknown): v is Lang => v === "sv" || v === "fr" || v === "en";

const int = (v: unknown, key: string, fallback: number) => {
  const [lo, hi] = RANGES[key] ?? [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER];
  return typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : fallback;
};
const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);

function texts(v: unknown, max: number): Texts | null {
  if (typeof v !== "object" || v === null) return null;
  const t = v as Record<string, unknown>;
  for (const l of LANGS) if (typeof t[l] !== "string" || (t[l] as string).trim() === "" || (t[l] as string).length > max) return null;
  return { sv: t["sv"] as string, fr: t["fr"] as string, en: t["en"] as string };
}

/** A side's list: at most 8 chips, unique snake_case ids, texts 1–60; a bad list reads as the default list. */
function replies(v: unknown, fallback: QuickReply[]): QuickReply[] {
  const [, maxItems] = RANGES["quickRepliesPerSide"] ?? [0, 8];
  const [, maxText] = RANGES["quickReplyTextLength"] ?? [1, 60];
  if (!Array.isArray(v) || v.length > maxItems) return fallback;
  const out: QuickReply[] = [];
  const seen = new Set<string>();
  for (const item of v) {
    const id = (item as { id?: unknown } | null)?.id;
    const text = texts((item as { text?: unknown } | null)?.text, maxText);
    if (typeof id !== "string" || !ID.test(id) || seen.has(id) || text === null) return fallback;
    seen.add(id);
    out.push({ id, text });
  }
  return out;
}

export function chatSettingsOf(rules: unknown): ChatSettings {
  const raw = (rules as { chat?: Record<string, unknown> } | null | undefined)?.chat ?? {};
  const d = CHAT_DEFAULTS;
  const qr = (raw["quickReplies"] ?? {}) as Record<string, unknown>;
  const aa = (raw["autoArrived"] ?? {}) as Record<string, unknown>;
  return {
    keepDays: int(raw["keepDays"], "keepDays", d.keepDays),
    maxLength: int(raw["maxLength"], "maxLength", d.maxLength),
    spamPerMin: int(raw["spamPerMin"], "spamPerMin", d.spamPerMin),
    sound: bool(raw["sound"], d.sound),
    sheetAutoOpen: raw["sheetAutoOpen"] === "new_message" || raw["sheetAutoOpen"] === "off" ? raw["sheetAutoOpen"] : d.sheetAutoOpen,
    readAloudDefault: bool(raw["readAloudDefault"], d.readAloudDefault),
    translation: bool(raw["translation"], d.translation),
    quickRepliesOn: bool(raw["quickRepliesOn"], d.quickRepliesOn),
    quickReplies: { driver: replies(qr["driver"], d.quickReplies.driver), rider: replies(qr["rider"], d.quickReplies.rider) },
    autoArrived: { on: bool(aa["on"], d.autoArrived.on), text: texts(aa["text"], 200) ?? d.autoArrived.text },
  };
}

export async function chatSettingsFor(ex: Executor, zoneId: string | null): Promise<ChatSettings> {
  if (zoneId === null) return chatSettingsOf(null);
  return chatSettingsOf((await liveDocument(ex, "country_rules", zoneId))?.document);
}

/** GET /trips/{tripId}/messages/options → ChatOptions for the caller's side. */
export function chatOptions(settings: ChatSettings, side: "rider" | "driver") {
  return {
    quickReplies: settings.quickReplies[side],
    quickRepliesOn: settings.quickRepliesOn,
    maxLength: settings.maxLength,
    sound: settings.sound,
    sheetAutoOpen: settings.sheetAutoOpen,
    readAloudDefault: settings.readAloudDefault,
    translation: settings.translation,
    headerLine: CHAT_HEADER_LINE,
  };
}

const COUNTRY_LANGUAGE: Record<string, Lang> = { SE: "sv", FR: "fr" };

/** A person's app language (Rider.language / Driver.language), else the zone country's language, else en. */
export async function languageOf(ex: Executor, who: { actor: "rider" | "driver"; subjectId: string | null }, zoneId: string | null): Promise<Lang> {
  if (who.subjectId !== null) {
    const row = who.actor === "rider"
      ? await ex.selectFrom("riders").select("language").where("rider_id", "=", who.subjectId).executeTakeFirst()
      : await ex.selectFrom("drivers").select("language").where("driver_id", "=", who.subjectId).executeTakeFirst();
    if (isLang(row?.language)) return row.language;
  }
  if (zoneId !== null) {
    const zone = await ex.selectFrom("zones").select("country").where("zone_id", "=", zoneId).executeTakeFirst();
    const lang = zone ? COUNTRY_LANGUAGE[zone.country] : undefined;
    if (lang) return lang;
  }
  return "en";
}
