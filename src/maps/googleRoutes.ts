import { decodePolyline } from "./polyline.js";
import type { LatLng, RouteLeg, RouteOptions, Router } from "./routing.js";

/**
 * v0.18.163 (contract.json#liveTraffic, owner 2026-11-25 "Google trafic réel": an offer said 13 min where Google Maps
 * said 26 min): the drive time WITH live traffic from Google Routes API computeRoutes (TRAFFIC_AWARE, departure now).
 * The field mask asks duration, distance and the encoded polyline (owner 2026-11-25 "the cheapest method, about 2 Google
 * calls per trip"): the quote keeps the polyline, and the ETA during the trip is worked out along it with no new call.
 *
 * Owner 2026-11-25 "We cannot use data for open street map": no OSRM. Fallback google → estimate: any failure (timeout,
 * 4xx/5xx, a bad body), the open breaker or the per-copy rate limit hands the ask to `fallback` (the straight-line
 * estimate); the admin gets the system_health alert (alerts/detector.ts). The key goes only in
 * the X-Goog-Api-Key header and is never logged (errors carry the status, never the request).
 *
 * Breaker as OSRM's (B1.3): `failuresToOpen` failures in a row open it for `coolDownMs`, then one probe. State per
 * server copy, in memory (Rule 33): it only decides whether THIS copy waits on Google.
 */
export const GOOGLE_ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";
export const GOOGLE_ROUTES_FIELD_MASK = "routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline";
export const GOOGLE_TIMEOUT_MS_DEFAULT = 2500;
export const GOOGLE_PER_MINUTE_DEFAULT = 300;

type Log = { warn(data: Record<string, unknown>, message: string): void; info(data: Record<string, unknown>, message: string): void };

export type GoogleRoutesOptions = {
  timeoutMs?: number;
  failuresToOpen?: number;
  coolDownMs?: number;
  /** Google asks per minute on this copy (0 = no cap). Above it: the estimate for the rest of the minute. */
  perMinute?: number;
  log?: Log;
  fetch?: typeof fetch;
  now?: () => number;
};

/** Google answered with an error status. Carries only the status: the request (and its key header) is never kept. */
export class GoogleRoutesError extends Error {
  constructor(readonly reason: string) {
    super(`Google Routes: ${reason}`);
    this.name = "GoogleRoutesError";
  }
}

/** "1234s" / "1234.5s" (protobuf Duration as JSON) → seconds. */
export function parseGoogleDuration(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = /^(\d+(?:\.\d+)?)s$/.exec(value);
  return m ? Math.round(Number(m[1])) : null;
}

const waypoint = (p: LatLng) => ({ location: { latLng: { latitude: Number(p.lat), longitude: Number(p.lng) } } });

export class GoogleRoutesRouter implements Router {
  private readonly timeoutMs: number;
  private readonly failuresToOpen: number;
  private readonly coolDownMs: number;
  private readonly perMinute: number;
  private readonly doFetch: typeof fetch;
  private readonly now: () => number;
  private failuresInRow = 0;
  private openedAt: number | null = null;
  private probing = false;
  private minute = -1;
  private usedThisMinute = 0;

  constructor(
    private readonly apiKey: string,
    private readonly fallback: Router,
    private readonly options: GoogleRoutesOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? GOOGLE_TIMEOUT_MS_DEFAULT;
    this.failuresToOpen = options.failuresToOpen ?? 5;
    this.coolDownMs = options.coolDownMs ?? 60_000;
    this.perMinute = options.perMinute ?? GOOGLE_PER_MINUTE_DEFAULT;
    this.doFetch = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  get state(): "closed" | "open" | "half_open" {
    if (this.openedAt === null) return "closed";
    return this.probing ? "half_open" : "open";
  }

  async route(points: LatLng[], options: RouteOptions = {}): Promise<RouteLeg> {
    if (points.length < 2 || points.length > 27) return this.fallback.route(points, options);
    if (!this.takeBudget()) return this.fallback.route(points, options);
    let probe = false;
    if (this.openedAt !== null) {
      if (this.probing || this.now() - this.openedAt < this.coolDownMs) return this.fallback.route(points, options);
      probe = true;
      this.probing = true;
    }
    try {
      const leg = await this.ask(points);
      this.succeeded();
      return leg;
    } catch (error) {
      this.failed(error, probe);
      return this.fallback.route(points, options);
    } finally {
      if (probe) this.probing = false;
    }
  }

  private takeBudget(): boolean {
    if (this.perMinute <= 0) return true;
    const minute = Math.floor(this.now() / 60_000);
    if (minute !== this.minute) {
      this.minute = minute;
      this.usedThisMinute = 0;
    }
    if (this.usedThisMinute >= this.perMinute) return false;
    this.usedThisMinute += 1;
    return true;
  }

  private async ask(points: LatLng[]): Promise<RouteLeg> {
    const body = {
      origin: waypoint(points[0]!),
      destination: waypoint(points[points.length - 1]!),
      ...(points.length > 2 ? { intermediates: points.slice(1, -1).map(waypoint) } : {}),
      travelMode: "DRIVE",
      routingPreference: "TRAFFIC_AWARE",
      departureTime: new Date(this.now()).toISOString(),
    };
    let response: Response;
    try {
      response = await this.doFetch(GOOGLE_ROUTES_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey, "x-goog-fieldmask": GOOGLE_ROUTES_FIELD_MASK },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const name = (error as { name?: string } | null)?.name;
      throw new GoogleRoutesError(name === "TimeoutError" || name === "AbortError" ? "timeout" : "network");
    }
    if (!response.ok) throw new GoogleRoutesError(`status_${response.status}`);
    const json = (await response.json().catch(() => null)) as { routes?: Array<{ duration?: unknown; distanceMeters?: unknown; polyline?: { encodedPolyline?: unknown } }> } | null;
    const best = json?.routes?.[0];
    const seconds = parseGoogleDuration(best?.duration);
    const meters = typeof best?.distanceMeters === "number" && Number.isFinite(best.distanceMeters) ? Math.round(best.distanceMeters) : null;
    if (seconds === null || meters === null) throw new GoogleRoutesError("no_route");
    const polyline = typeof best?.polyline?.encodedPolyline === "string" && best.polyline.encodedPolyline.length > 0 ? best.polyline.encodedPolyline : undefined;
    return { distanceMeters: meters, durationSeconds: seconds, source: "google", ...(polyline ? { polyline, points: decodePolyline(polyline) } : {}) };
  }

  private succeeded(): void {
    this.failuresInRow = 0;
    if (this.openedAt === null) return;
    const openForMs = this.now() - this.openedAt;
    this.openedAt = null;
    this.options.log?.info({ googleRoutesBreaker: "closed", openForMs }, "Google Routes circuit closed; live traffic again");
  }

  private failed(error: unknown, probe: boolean): void {
    const reason = error instanceof GoogleRoutesError ? error.reason : "error";
    if (probe) {
      this.openedAt = this.now();
      return;
    }
    // Never the error object itself: only our own reason string (no URL, no header, no key).
    this.options.log?.warn({ googleRoutes: "fallback", reason }, "Google Routes unavailable; trip time estimated (straight line)");
    if (this.failuresToOpen <= 0) return;
    this.failuresInRow += 1;
    if (this.openedAt === null && this.failuresInRow >= this.failuresToOpen) {
      this.openedAt = this.now();
      this.options.log?.warn({ googleRoutesBreaker: "open", failuresInRow: this.failuresInRow, coolDownMs: this.coolDownMs }, "Google Routes circuit open; estimate until a probe answers");
    }
  }
}

/**
 * The system_health alert (alerts/detector.ts liveTrafficCauses) reads the quotes' route_source, so it sees every copy.
 * It only runs when this server has a Google key (app.ts sets it): without a key live traffic was never there to fail.
 */
let configured = false;
export const LIVE_TRAFFIC_ALERT_WINDOW_MS = 10 * 60_000;
export function setLiveTrafficConfigured(on: boolean): void {
  configured = on;
}
export function liveTrafficConfigured(): boolean {
  return configured;
}
