import { createHmac } from "node:crypto";
import { liveDocument } from "../config/service.js";
import { contract } from "../contract/contract.js";
import type { Executor } from "../db/db.js";

/**
 * v0.18.38 §62 (contract.json#inAppCalls.settings): CountryRules.calls of the trip's zone (its own country_rules, else
 * its country's Standard), else the defaults. A missing value, or one outside its range, reads as the default.
 */
export type CallSettings = { on: boolean; mode: "in_app" | "phone"; callWindowAfterTripMin: number; ringSeconds: number; maxCallMin: number; adminCallRoles: string[]; phoneProvider: string };
type Range = [number, number];
const C = contract as unknown as { configDefaults: { calls: CallSettings }; inAppCalls: { settings: { ranges: Record<string, Range> } } };
export const CALL_DEFAULTS: CallSettings = C.configDefaults.calls;
const RANGES = C.inAppCalls.settings.ranges;

const int = (v: unknown, key: string, fallback: number) => {
  const [lo, hi] = RANGES[key] ?? [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER];
  return typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : fallback;
};

export function callSettingsOf(rules: unknown): CallSettings {
  const raw = (rules as { calls?: Record<string, unknown> } | null | undefined)?.calls ?? {};
  const d = CALL_DEFAULTS;
  return {
    on: typeof raw["on"] === "boolean" ? raw["on"] : d.on,
    mode: raw["mode"] === "phone" || raw["mode"] === "in_app" ? raw["mode"] : d.mode,
    callWindowAfterTripMin: int(raw["callWindowAfterTripMin"], "callWindowAfterTripMin", d.callWindowAfterTripMin),
    ringSeconds: int(raw["ringSeconds"], "ringSeconds", d.ringSeconds),
    maxCallMin: int(raw["maxCallMin"], "maxCallMin", d.maxCallMin),
    adminCallRoles: Array.isArray(raw["adminCallRoles"]) ? raw["adminCallRoles"].filter((r): r is string => typeof r === "string") : d.adminCallRoles,
    phoneProvider: typeof raw["phoneProvider"] === "string" ? raw["phoneProvider"] : d.phoneProvider,
  };
}

export async function callSettingsFor(ex: Executor, zoneId: string | null): Promise<CallSettings> {
  if (zoneId === null) return callSettingsOf(null);
  return callSettingsOf((await liveDocument(ex, "country_rules", zoneId))?.document);
}

/**
 * contract.json#inAppCalls.ice: STUN / TURN from the server environment, never from git. MOVERA_STUN_URLS (comma list,
 * default a public STUN server), MOVERA_TURN_URLS + MOVERA_TURN_SECRET (coturn "REST API" credentials: username =
 * expiry:callId, credential = base64 HMAC-SHA1 of it). No server state: any copy gives valid credentials (rule 33).
 */
export type IceServer = { urls: string[]; username?: string; credential?: string };
const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
export function iceServers(callId: string, now: Date, ttlSeconds: number, env: Record<string, string | undefined> = process.env): { servers: IceServer[]; ttlSeconds: number } {
  const stun = list(env["MOVERA_STUN_URLS"]);
  const servers: IceServer[] = [{ urls: stun.length > 0 ? stun : ["stun:stun.l.google.com:19302"] }];
  const turn = list(env["MOVERA_TURN_URLS"]);
  const secret = env["MOVERA_TURN_SECRET"];
  if (turn.length > 0 && secret) {
    const username = `${Math.floor(now.getTime() / 1000) + ttlSeconds}:${callId}`;
    servers.push({ urls: turn, username, credential: createHmac("sha1", secret).update(username).digest("base64") });
  }
  return { servers, ttlSeconds };
}
