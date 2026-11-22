import type { FastifyRequest } from "fastify";
import type { Executor } from "../db/db.js";
import type { ConfigDoc } from "../db/schema.js";
import { ApiError } from "../http/errors.js";
import { liveDocument } from "./service.js";

/**
 * Contract v0.18.154 P16c (contract.json#appUpdate; owner 2026-11-21 20:30 "Yes, build it now (Recommended)"): the
 * minimum app version per app document (rider_app_config, driver_app_config), per platform (android, ios) and per zone
 * (its own live document, else its country Standard). Default off (null or missing). The Android and iOS apps send
 * X-App-Version + X-App-Platform; below the minimum, booking, go-online and offer accept answer 426 upgrade_required,
 * reason app_update_required. A call without both valid headers (older apps, web builds) is never checked.
 */

export const APP_PLATFORMS = ["android", "ios"] as const;
export type AppPlatform = (typeof APP_PLATFORMS)[number];
export type AppClient = { version: string; platform: AppPlatform };

/** x.y.z, whole numbers 0-99999, no leading zeros, no suffix (contract.json#appUpdate.validation). */
const SEMVER = /^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/;
const MAX_URL = 500;

type Doc = Record<string, unknown>;
const isObject = (value: unknown): value is Doc => typeof value === "object" && value !== null && !Array.isArray(value);

export const isSemver = (value: unknown): value is string => typeof value === "string" && SEMVER.test(value);

/** Number by number: < 0 when a is lower (1.9.3 < 1.10.0). Both must be semver. */
export function compareVersions(a: string, b: string): number {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  return 0;
}

const header = (request: FastifyRequest, name: string): string | undefined => {
  const value = request.headers[name];
  return (Array.isArray(value) ? value[0] : value)?.trim();
};

/** The app and its platform, or null when either header is missing or not valid (no check then). */
export function appClientOf(request: FastifyRequest): AppClient | null {
  const version = header(request, "x-app-version");
  const platform = header(request, "x-app-platform")?.toLowerCase();
  if (!isSemver(version) || !(APP_PLATFORMS as readonly string[]).includes(platform ?? "")) return null;
  return { version, platform: platform as AppPlatform };
}

/** Why a document's appUpdate.minVersion / storeUrls is not valid (null = valid or absent). The older keys are not read. */
export function appUpdateProblem(document: unknown): string | null {
  if (!isObject(document) || !("appUpdate" in document)) return null;
  const update = document["appUpdate"];
  if (!isObject(update)) return "appUpdate must be an object";
  for (const [key, check, what] of [
    ["minVersion", isSemver, "null or a version x.y.z"],
    ["storeUrls", (value: unknown) => typeof value === "string" && value.length <= MAX_URL && /^https:\/\/[^\s]+$/.test(value), "null or an https link"],
  ] as const) {
    if (!(key in update) || update[key] === undefined) continue;
    const map = update[key];
    if (!isObject(map)) return `appUpdate.${key} must be an object { android, ios }`;
    for (const platform of Object.keys(map)) {
      if (!(APP_PLATFORMS as readonly string[]).includes(platform)) return `appUpdate.${key}.${platform} is not a platform (android, ios)`;
      const value = map[platform];
      if (value !== null && !check(value)) return `appUpdate.${key}.${platform} must be ${what}`;
    }
  }
  return null;
}

/** The minimum of one platform in a document, or null (off). */
export function minVersionOf(document: unknown, platform: AppPlatform): string | null {
  const update = isObject(document) ? document["appUpdate"] : undefined;
  const map = isObject(update) ? update["minVersion"] : undefined;
  const value = isObject(map) ? map[platform] : undefined;
  return isSemver(value) ? value : null;
}

/**
 * Refuses the call (426 upgrade_required, app_update_required) when the app is below the highest minimum of its
 * platform over the zones' live documents of `doc`. No client (missing / bad headers) or no minimum: nothing.
 */
export async function refuseOldApp(ex: Executor, doc: Extract<ConfigDoc, "rider_app_config" | "driver_app_config">, zoneIds: readonly string[], client: AppClient | null | undefined): Promise<void> {
  if (!client) return;
  let highest: string | null = null;
  for (const zoneId of new Set(zoneIds)) {
    const live = await liveDocument(ex, doc, zoneId);
    const min = live === null ? null : minVersionOf(live.document, client.platform);
    if (min !== null && (highest === null || compareVersions(min, highest) > 0)) highest = min;
  }
  if (highest !== null && compareVersions(client.version, highest) < 0) {
    throw new ApiError("upgrade_required", "Update Movera to continue.", { reason: "app_update_required", details: [`platform:${client.platform}`, `minVersion:${highest}`] });
  }
}
