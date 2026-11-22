import { contract } from "../contract/contract.js";
import type { ConfigDoc } from "../db/schema.js";
import { ApiError } from "../http/errors.js";

/**
 * v0.18.123 SF-F1-3 (owner 2026-11-17 Q-SCS-1 "Keep values, save rest (Rec.)", contract.json#configDocs.keptKeys): the
 * kept keys per document (dotted paths), read from the contract copy. A save that leaves one out does not wipe it.
 */
const listed = (contract as unknown as { configDocs: { keptKeys: Record<string, unknown> } }).configDocs.keptKeys;
// v0.18.130 (configDocs.keptKeys.driver_app_config): the driver document keeps realtime.oneStream (v0.18.122 switch).
// v0.18.150: and realtime.oneStreamFallback (the two backup numbers under the switch), from the same contract list.
export const KEPT_KEYS: Partial<Record<ConfigDoc, readonly string[]>> = {
  country_rules: listed["country_rules"] as string[],
  dispatch: listed["dispatch"] as string[],
  driver_app_config: listed["driver_app_config"] as string[],
};

type Doc = Record<string, unknown>;
const isObject = (value: unknown): value is Doc => value !== null && typeof value === "object" && !Array.isArray(value);

/** removeKeys may name only kept keys of this document (else 400 unknown_kept_key, nothing saved). */
export function checkRemoveKeys(doc: ConfigDoc, removeKeys: readonly string[]): void {
  const kept = KEPT_KEYS[doc] ?? [];
  const unknown = removeKeys.filter((key) => !kept.includes(key));
  if (unknown.length > 0) throw new ApiError("invalid_request", "removeKeys may name only the kept keys of this document.", { reason: "unknown_kept_key", details: unknown.map((key) => `key:${key}`) });
}

/**
 * The sent document with every kept key put back that the stored document (the scope's draft, else its own live
 * document; null when the scope has none) has and the sent one leaves out, unless removeKeys names it. Never refuses.
 */
export function withKeptKeys(doc: ConfigDoc, stored: unknown, sent: unknown, removeKeys: readonly string[]): { document: unknown; kept: string[] } {
  const keys = KEPT_KEYS[doc];
  if (keys === undefined || !isObject(stored) || !isObject(sent)) return { document: sent, kept: [] };
  const document: Doc = structuredClone(sent);
  const kept: string[] = [];
  for (const path of keys) {
    if (removeKeys.includes(path)) continue;
    const parts = path.split(".");
    const leaf = parts.pop()!;
    let from: unknown = stored;
    for (const part of parts) from = isObject(from) ? from[part] : undefined;
    if (!isObject(from) || !(leaf in from)) continue;
    let into: Doc = document;
    let ok = true;
    for (const part of parts) {
      if (into[part] === undefined) into[part] = {};
      if (!isObject(into[part])) { ok = false; break; }
      into = into[part] as Doc;
    }
    if (!ok || leaf in into) continue;
    into[leaf] = structuredClone(from[leaf]);
    kept.push(path);
  }
  return { document: kept.length > 0 ? document : sent, kept };
}
