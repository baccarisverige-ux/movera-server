import { contract } from "../contract/contract.js";

/**
 * Contract v0.18.158 (contract.json#crashCatcher.setting; owner 2026-11-24 "Add to admin all kind of crash"): the zone's
 * switch for the apps' crash reports, RiderAppConfig.crashReports { on } and DriverAppConfig.crashReports { on }
 * (Admin Dispatch › Safety › Crash reports). Never saved = configDefaults.crashReportsOn (true). Served always.
 */
export const DEFAULT_CRASH_REPORTS_ON: boolean = (contract as unknown as { configDefaults: { crashReportsOn?: boolean } }).configDefaults.crashReportsOn ?? true;

type Doc = Record<string, unknown>;
const isObject = (value: unknown): value is Doc => typeof value === "object" && value !== null && !Array.isArray(value);

/** Why a document's crashReports is not valid (null = valid or absent). Checked here whatever contract copy the schema reads. */
export function crashReportsProblem(document: unknown): string | null {
  if (!isObject(document) || !("crashReports" in document)) return null;
  const value = document["crashReports"];
  if (!isObject(value)) return "crashReports must be an object { on }";
  if ("on" in value && typeof value["on"] !== "boolean") return "crashReports.on must be true or false";
  return null;
}

/** The served app document: crashReports.on is always there (the stored value, else the default). */
export function withCrashReports(document: Doc): Doc {
  const own = isObject(document["crashReports"]) ? document["crashReports"] : {};
  const on = typeof own["on"] === "boolean" ? own["on"] : DEFAULT_CRASH_REPORTS_ON;
  return { ...document, crashReports: { ...own, on } };
}
