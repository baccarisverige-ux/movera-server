import { contract } from "../contract/contract.js";

/**
 * Contract v0.18.122 (L20 stream, contract.json#driverOneStream; owner 2026-11-17 "Yes, with switch (Rec.)"):
 * DriverAppConfig.realtime.oneStream, the zone's switch that tells the driver app to open GET /driver/stream instead of
 * the offer feed + the config stream. Stored in the zone's driver document as the admin publishes it; served always,
 * missing = configDefaults.driverOneStream (false; the server's contract copy may be older than 0.18.122).
 */
export const DEFAULT_ONE_STREAM: boolean = (contract as unknown as { configDefaults: { driverOneStream?: boolean } }).configDefaults.driverOneStream ?? false;

type Doc = Record<string, unknown>;
const isObject = (value: unknown): value is Doc => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Contract v0.18.150 (L20 stream backup, contract.json#driverOneStreamFallback; owner 2026-11-21 "Switch to old two
 * (Rec.)"): DriverAppConfig.realtime.oneStreamFallback { failuresInARow 1-10, retryOneAfterMinutes 1-60 }: after that many
 * failed tries of GET /driver/stream in a row the driver app opens the two old streams for that many minutes.
 * Defaults = configDefaults.driverOneStreamFallback (3 / 10; the contract copy may be older than 0.18.150).
 */
type Fallback = { failuresInARow: number; retryOneAfterMinutes: number };
const listedFallback = (contract as unknown as { configDefaults: { driverOneStreamFallback?: Partial<Fallback> } }).configDefaults.driverOneStreamFallback;
export const DEFAULT_ONE_STREAM_FALLBACK: Fallback = {
  failuresInARow: listedFallback?.failuresInARow ?? 3,
  retryOneAfterMinutes: listedFallback?.retryOneAfterMinutes ?? 10,
};
const FALLBACK_RANGES: Record<keyof Fallback, readonly [number, number]> = { failuresInARow: [1, 10], retryOneAfterMinutes: [1, 60] };
const inRange = (value: unknown, [min, max]: readonly [number, number]): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;

function fallbackProblem(fallback: unknown): string | null {
  if (!isObject(fallback)) return "realtime.oneStreamFallback must be an object { failuresInARow, retryOneAfterMinutes }";
  for (const key of Object.keys(FALLBACK_RANGES) as Array<keyof Fallback>) {
    const [min, max] = FALLBACK_RANGES[key];
    if (key in fallback && !inRange(fallback[key], FALLBACK_RANGES[key])) return `realtime.oneStreamFallback.${key} must be a whole number from ${min} to ${max}`;
  }
  return null;
}

/** Why a driver document's realtime is not valid (null = valid or absent). */
export function oneStreamProblem(document: unknown): string | null {
  if (!isObject(document) || !("realtime" in document)) return null;
  const realtime = document["realtime"];
  if (!isObject(realtime)) return "realtime must be an object { oneStream }";
  if ("oneStream" in realtime && typeof realtime["oneStream"] !== "boolean") return "realtime.oneStream must be true or false";
  if ("oneStreamFallback" in realtime) return fallbackProblem(realtime["oneStreamFallback"]);
  return null;
}

/**
 * The served driver document: realtime.oneStream and (v0.18.150) realtime.oneStreamFallback are always there (the stored
 * values, else the defaults; a stored value out of range is served as its default).
 */
export function withOneStream(document: Doc): Doc {
  const realtime = isObject(document["realtime"]) ? document["realtime"] : {};
  const oneStream = typeof realtime["oneStream"] === "boolean" ? realtime["oneStream"] : DEFAULT_ONE_STREAM;
  const stored = isObject(realtime["oneStreamFallback"]) ? realtime["oneStreamFallback"] : {};
  const oneStreamFallback: Fallback = {
    failuresInARow: inRange(stored["failuresInARow"], FALLBACK_RANGES.failuresInARow) ? stored["failuresInARow"] : DEFAULT_ONE_STREAM_FALLBACK.failuresInARow,
    retryOneAfterMinutes: inRange(stored["retryOneAfterMinutes"], FALLBACK_RANGES.retryOneAfterMinutes) ? stored["retryOneAfterMinutes"] : DEFAULT_ONE_STREAM_FALLBACK.retryOneAfterMinutes,
  };
  return { ...document, realtime: { ...realtime, oneStream, oneStreamFallback } };
}
