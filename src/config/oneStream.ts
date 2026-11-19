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

/** Why a driver document's realtime is not valid (null = valid or absent). */
export function oneStreamProblem(document: unknown): string | null {
  if (!isObject(document) || !("realtime" in document)) return null;
  const realtime = document["realtime"];
  if (!isObject(realtime)) return "realtime must be an object { oneStream }";
  if ("oneStream" in realtime && typeof realtime["oneStream"] !== "boolean") return "realtime.oneStream must be true or false";
  return null;
}

/** The served driver document: realtime.oneStream is always there (the stored value, else the default). */
export function withOneStream(document: Doc): Doc {
  const realtime = isObject(document["realtime"]) ? document["realtime"] : {};
  const oneStream = typeof realtime["oneStream"] === "boolean" ? realtime["oneStream"] : DEFAULT_ONE_STREAM;
  return { ...document, realtime: { ...realtime, oneStream } };
}
