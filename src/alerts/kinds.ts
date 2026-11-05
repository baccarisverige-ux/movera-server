import { contract } from "../contract/contract.js";

/**
 * v0.18.23 (contract.json#alertDesk.serverDetection, owner 2026-11-04 A1–A3): the alert kinds the server finds, their
 * defaults, and how the country's alert settings document (PUT /admin/alerts/settings) is read.
 */

export type Level = "critical" | "important" | "info";
export type Limits = { info: number | null; important: number | null; critical: number | null };
/** A text as an English template with {0}, {1} places; x = the places whose value is itself a text to translate. */
export type Text = { t: string; a: (string | number)[]; x?: number[] };

type KindDefault = { on?: boolean; level?: Level; limits?: Limits };
type ZoneDefaults = { bookedAtRiskMin: number; liveAtRiskMin: number; fewDriversLimit: number; noDriverLimit: number };
const SD = (contract as unknown as {
  alertDesk: {
    kindGroups: Record<string, string>;
    serverDetection: {
      sweepSeconds: number;
      kindDefaults: Record<string, KindDefault>;
      settings: Record<keyof ZoneDefaults, { default: number; range: [number, number] }>;
    };
  };
}).alertDesk;

export const SWEEP_MS = SD.serverDetection.sweepSeconds * 1000;
export const KIND_DEFAULTS = SD.serverDetection.kindDefaults;
export const KINDS = Object.keys(SD.kindGroups);
const ZONE_KEYS = ["bookedAtRiskMin", "liveAtRiskMin", "fewDriversLimit", "noDriverLimit"] as const;
export const ZONE_DEFAULTS = Object.fromEntries(ZONE_KEYS.map((k) => [k, SD.serverDetection.settings[k].default])) as ZoneDefaults;

export type KindSetting = { on: boolean; level: Level; limits: Limits };

const isLevel = (v: unknown): v is Level => v === "critical" || v === "important" || v === "info";
const num = (v: unknown): number | null | undefined => (v === null ? null : typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** The settings document as the panel saved it, read defensively: anything missing or wrong uses the default. */
export class AlertSettings {
  constructor(private readonly doc: Record<string, unknown>) {}

  kind(kind: string): KindSetting {
    const def = KIND_DEFAULTS[kind] ?? {};
    const raw = ((this.doc["kinds"] as Record<string, Record<string, unknown>> | undefined) ?? {})[kind] ?? {};
    const base: Limits = { ...(def.limits ?? { info: null, important: null, critical: null }) };
    const rawLimits = (raw["limits"] as Record<string, unknown> | undefined) ?? {};
    const limits: Limits = {
      info: num(rawLimits["info"]) === undefined ? base.info : (num(rawLimits["info"]) as number | null),
      important: num(rawLimits["important"]) === undefined ? base.important : (num(rawLimits["important"]) as number | null),
      critical: num(rawLimits["critical"]) === undefined ? base.critical : (num(rawLimits["critical"]) as number | null),
    };
    return { on: typeof raw["on"] === "boolean" ? raw["on"] : def.on !== false, level: isLevel(raw["level"]) ? raw["level"] : (def.level ?? "important"), limits };
  }

  zone(zoneId: string): ZoneDefaults {
    const raw = ((this.doc["zones"] as Record<string, Record<string, unknown>> | undefined) ?? {})[zoneId] ?? {};
    const out = { ...ZONE_DEFAULTS };
    for (const key of ZONE_KEYS) {
      const value = num(raw[key]);
      const [lo, hi] = SD.serverDetection.settings[key].range;
      if (typeof value === "number" && value >= lo && value <= hi) out[key] = value;
    }
    return out;
  }
}

/** The level a number reaches, or null when it is fine ("up": higher is worse). */
export function levelFor(value: number, limits: Limits, direction: "up" | "down"): Level | null {
  const reached = (limit: number | null) => limit !== null && (direction === "up" ? value >= limit : value <= limit);
  if (reached(limits.critical)) return "critical";
  if (reached(limits.important)) return "important";
  if (reached(limits.info)) return "info";
  return null;
}

export function render(text: Text): string {
  return text.t.replace(/\{(\d+)\}/g, (_, i: string) => String(text.a[Number(i)] ?? ""));
}

/** HH:MM in the zone's time zone (texts the admin reads). */
export function hhmm(at: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
  } catch {
    return at.toISOString().slice(11, 16);
  }
}

/** Custom rule (owner A3), as the panel saves it (contract.json#alertDesk.serverDetection.kindDefaults.rule). */
export type CustomRule = { id: string; name: string; on: boolean; metric: string; op: "above" | "below"; value: number; forMin: number; zoneId: string; level: Level };

export function rulesOf(doc: unknown): CustomRule[] {
  if (!Array.isArray(doc)) return [];
  return doc.flatMap((r: Record<string, unknown>) => {
    if (!r || typeof r !== "object" || typeof r["id"] !== "string" || typeof r["metric"] !== "string") return [];
    const value = Number(r["value"]);
    if (!Number.isFinite(value) || (r["op"] !== "above" && r["op"] !== "below")) return [];
    return [{
      id: r["id"],
      name: typeof r["name"] === "string" ? r["name"] : "Rule",
      on: r["on"] !== false,
      metric: r["metric"],
      op: r["op"],
      value,
      forMin: Math.max(0, Math.min(240, Number(r["forMin"]) || 0)),
      zoneId: typeof r["zoneId"] === "string" ? r["zoneId"] : "all",
      level: isLevel(r["level"]) ? r["level"] : "important",
    }];
  });
}

export const METRIC_UNITS: Record<string, string> = {
  free_drivers: "drivers",
  riders_waiting: "riders",
  longest_wait: "min",
  failed_payments: "payments",
  open_sos: "SOS",
  open_tickets: "tickets",
};
