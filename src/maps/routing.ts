import { contract } from "../contract/contract.js";
import { OSRM_BREAKER_COOLDOWN_SECONDS_DEFAULT, OSRM_BREAKER_FAILURES_DEFAULT, OSRM_MAX_SNAP_METERS_DEFAULT, OSRM_TIMEOUT_MS_DEFAULT } from "./osrmSettings.js";

/**
 * Road distance and time between points (contract §10; owner decision 4: Movera's own OSRM). Until OSRM runs
 * (OSRM_URL unset, or OSRM down) the server estimates the way the admin panel's dispatch test does: straight line
 * × 1.25 at 24 km/h (contract.json#dispatch.score roadFactor, pickupKmh). Every result says which one it is.
 */

export type LatLng = { lat: number; lng: number };
export type RouteLeg = { distanceMeters: number; durationSeconds: number; source: "osrm" | "estimate"; points?: LatLng[] };

/**
 * S7 0.17 (owner W2 Q120 part 3): `shape: false` = the caller needs only the distance and the time (an ETA tick, the
 * booked "leave now" check, a route-change price), so OSRM is asked without the road's shape (overview=false: a far
 * smaller answer, the same distance and time) and the leg has no `points`. Default (true): the full shape, as before
 * (the trip's line on the map, the ride check's planned route).
 */
export type RouteOptions = { shape?: boolean };

export interface Router {
  route(points: LatLng[], options?: RouteOptions): Promise<RouteLeg>;
}

type ScoreConstants = { roadFactor: number; pickupKmh: number };
const SCORE = (contract as unknown as { dispatch: { score: ScoreConstants } }).dispatch.score;

const EARTH_KM = 6371.0088;

/** Great-circle distance in km. */
export function haversineKm(a: LatLng, b: LatLng): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export class EstimateRouter implements Router {
  async route(points: LatLng[]): Promise<RouteLeg> {
    let km = 0;
    for (let i = 1; i < points.length; i++) km += haversineKm(points[i - 1]!, points[i]!) * SCORE.roadFactor;
    return { distanceMeters: Math.round(km * 1000), durationSeconds: Math.round((km / SCORE.pickupKmh) * 3600), source: "estimate", points };
  }
}

/**
 * B1.3 (owner W1 Q67, 2026-11-11): the circuit breaker in front of OSRM. After `failuresToOpen` failures in a row it
 * opens: every ask gets the straight-line estimate at once, without calling or waiting on OSRM. After `coolDownMs` one
 * ask goes out as a probe (the others keep the estimate while it is out): an answer closes the breaker, a failure opens
 * it for another cool-down. One log line when it opens and one when it closes; failed probes add none.
 * `failuresToOpen` 0 turns the breaker off (every ask goes to OSRM, as before B1.3).
 *
 * Rule 33 (several server copies): the state is per copy, in memory, on purpose. It only decides whether THIS copy waits
 * on OSRM; nothing is stored from it (B1.2: a road route is kept only when OSRM answered), so copies that disagree
 * for a moment only differ in which of them still pays one timeout. Each copy learns the outage after at most
 * `failuresToOpen` of its own asks and sends at most one probe per cool-down.
 */
export type OsrmBreakerOptions = {
  failuresToOpen: number;
  coolDownMs: number;
  log?: { warn(data: Record<string, unknown>, message: string): void; info(data: Record<string, unknown>, message: string): void };
};

/**
 * OSRM v5 /route/v1/driving. Falls back to the estimate when OSRM does not answer in time, while the breaker is open,
 * or when its answer moved an asked point too far (route guard, OsrmSnappedFarError).
 */
/** OSRM answered with an error (4xx = bad or unroutable points, not an outage; 5xx = server trouble). */
export class OsrmAnsweredError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(`OSRM answered ${status} ${code ?? ""}`);
    this.name = "OsrmAnsweredError";
  }
}

/**
 * Route guard: OSRM answered "Ok" but moved an asked point further than the limit to reach a road it knows (the point
 * is outside its map, or nowhere near a road), so the route it answered is not the asked ride (far too short at a map
 * edge). Not an outage. The text and the fields hold metres and the point's place in the list only, never a coordinate.
 */
export class OsrmSnappedFarError extends Error {
  constructor(
    readonly movedMeters: number,
    readonly limitMeters: number,
    /** 0 = the first asked point. */
    readonly point: number,
    readonly points: number,
  ) {
    super(`OSRM moved point ${point + 1} of ${points} by ${movedMeters} m to reach a road (limit ${limitMeters} m)`);
    this.name = "OsrmSnappedFarError";
  }
}

type OsrmWaypoint = { distance?: unknown; location?: unknown };

/**
 * How far OSRM moved the asked point that it moved the most (metres), and which one. `waypoints[i].distance` is OSRM's
 * own number; an answer without it but with the snapped place (`location`: [lng, lat]) is measured from the asked
 * point. A waypoint with neither says nothing and is skipped, so an answer without usable waypoints is never refused.
 */
export function farthestSnap(points: LatLng[], waypoints: unknown): { meters: number; point: number } | null {
  if (!Array.isArray(waypoints)) return null;
  let worst: { meters: number; point: number } | null = null;
  for (let i = 0; i < points.length && i < waypoints.length; i++) {
    const waypoint = waypoints[i] as OsrmWaypoint | null;
    if (waypoint === null || typeof waypoint !== "object") continue;
    let meters: number | null = null;
    if (typeof waypoint.distance === "number" && Number.isFinite(waypoint.distance) && waypoint.distance >= 0) meters = waypoint.distance;
    else if (Array.isArray(waypoint.location) && waypoint.location.length >= 2) {
      const [lng, lat] = waypoint.location as unknown[];
      if (typeof lng === "number" && typeof lat === "number" && Number.isFinite(lng) && Number.isFinite(lat)) meters = haversineKm(points[i]!, { lat, lng }) * 1000;
    }
    if (meters !== null && (worst === null || meters > worst.meters)) worst = { meters, point: i };
  }
  return worst;
}

export class OsrmRouter implements Router {
  private readonly fallback = new EstimateRouter();
  private readonly breaker: OsrmBreakerOptions;
  private failuresInRow = 0;
  /** Epoch ms the breaker opened (or re-opened after a failed probe); null while closed. */
  private openedAt: number | null = null;
  private probing = false;

  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = OSRM_TIMEOUT_MS_DEFAULT,
    private readonly onFallback: (error: unknown) => void = () => undefined,
    breaker?: Partial<OsrmBreakerOptions>,
    /** Route guard: an answer that moved an asked point further than this (metres) is not used. */
    private readonly maxSnapMeters = OSRM_MAX_SNAP_METERS_DEFAULT,
  ) {
    this.breaker = {
      failuresToOpen: breaker?.failuresToOpen ?? OSRM_BREAKER_FAILURES_DEFAULT,
      coolDownMs: breaker?.coolDownMs ?? OSRM_BREAKER_COOLDOWN_SECONDS_DEFAULT * 1000,
      ...(breaker?.log ? { log: breaker.log } : {}),
    };
  }

  /** "closed" | "open" | "half_open" (a probe is out), for logs and the later ops view (plan 0.22). */
  get state(): "closed" | "open" | "half_open" {
    if (this.openedAt === null) return "closed";
    return this.probing ? "half_open" : "open";
  }

  async route(points: LatLng[], options: RouteOptions = {}): Promise<RouteLeg> {
    let probe = false;
    if (this.openedAt !== null) {
      if (this.probing || Date.now() - this.openedAt < this.breaker.coolDownMs) return this.fallback.route(points);
      probe = true;
      this.probing = true;
    }
    try {
      const leg = await this.ask(points, options.shape !== false);
      this.succeeded();
      return leg;
    } catch (error) {
      if (error instanceof OsrmAnsweredError && error.status < 500) {
        // The server answered (bad or unroutable points: 400 NoRoute / InvalidQuery): not an outage, so it counts as
        // "up" for the breaker; this trip still gets the estimate (never stored as the road, B1.2).
        this.onFallback(error);
        this.succeeded();
        return this.fallback.route(points);
      }
      if (error instanceof OsrmSnappedFarError) {
        // Route guard: the server answered, so it counts as "up" for the breaker exactly like the unroutable points
        // above (a ride to a place outside the map must never stop road routes for everyone else). This ask gets the
        // estimate. One line, without coordinates (B1.27).
        if (this.breaker.log) {
          this.breaker.log.warn(
            { osrmSnap: "too_far", movedMeters: error.movedMeters, limitMeters: error.limitMeters, point: error.point, points: error.points },
            "OSRM moved a point too far to reach a road (outside its map?); distance estimated",
          );
        } else this.onFallback(error);
        this.succeeded();
        return this.fallback.route(points);
      }
      this.failed(error, probe);
      return this.fallback.route(points);
    } finally {
      if (probe) this.probing = false;
    }
  }

  private async ask(points: LatLng[], shape = true): Promise<RouteLeg> {
    const coordinates = points.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(";");
    // 0.17: overview=false when only the numbers are needed (RouteOptions.shape).
    const url = `${this.baseUrl.replace(/\/$/, "")}/route/v1/driving/${coordinates}?overview=${shape ? "full" : "false"}&geometries=geojson&steps=false&alternatives=false`;
    const response = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    const body = (await response.json()) as { code?: string; routes?: Array<{ distance: number; duration: number; geometry?: { coordinates?: number[][] } }>; waypoints?: unknown };
    const best = body.routes?.[0];
    if (!response.ok || body.code !== "Ok" || best === undefined) throw new OsrmAnsweredError(response.status, body.code);
    // Route guard: "Ok" is not enough. A point outside the map was moved to the nearest known road: not this ride.
    const snap = farthestSnap(points, body.waypoints);
    if (snap !== null && snap.meters > this.maxSnapMeters) throw new OsrmSnappedFarError(Math.round(snap.meters), this.maxSnapMeters, snap.point, points.length);
    return {
      distanceMeters: Math.round(best.distance),
      durationSeconds: Math.round(best.duration),
      source: "osrm",
      ...(shape ? { points: (best.geometry?.coordinates ?? []).map(([lng, lat]) => ({ lat: lat!, lng: lng! })) } : {}),
    };
  }

  private succeeded(): void {
    this.failuresInRow = 0;
    if (this.openedAt === null) return;
    const openForMs = Date.now() - this.openedAt;
    this.openedAt = null;
    this.breaker.log?.info({ osrmBreaker: "closed", openForMs }, "OSRM circuit closed; road routes again");
  }

  private failed(error: unknown, probe: boolean): void {
    if (probe) {
      // Still down: another cool-down, no new line (the open line already said so).
      this.openedAt = Date.now();
      return;
    }
    this.onFallback(error);
    if (this.breaker.failuresToOpen <= 0) return;
    this.failuresInRow += 1;
    if (this.openedAt === null && this.failuresInRow >= this.breaker.failuresToOpen) {
      this.openedAt = Date.now();
      this.breaker.log?.warn(
        { err: error, osrmBreaker: "open", failuresInRow: this.failuresInRow, coolDownMs: this.breaker.coolDownMs },
        "OSRM circuit open; distances estimated without calling OSRM until a probe answers",
      );
    }
  }
}

/**
 * Job 1 (fix plan R1 b, audits/stress-test-2026-11-04.md H2): road routes are asked BEFORE a timer's transaction (the
 * handler's `prepare`, no lock held) and handed to the handler as prepared legs. Inside the transaction the handler
 * routes with `preparedRouter`: the prepared leg for the same points, else the straight-line estimate (without a
 * shape, so nothing estimated is ever kept as a road route) — never a network call while a row is locked.
 */
export type PreparedLegs = { legs: Array<{ key: string; leg: RouteLeg }> };

export const legKey = (points: LatLng[]): string => points.map((p) => `${Number(p.lat).toFixed(6)},${Number(p.lng).toFixed(6)}`).join(";");

export async function prepareLegs(router: Router, wanted: LatLng[][], options?: RouteOptions): Promise<PreparedLegs> {
  const legs: PreparedLegs["legs"] = [];
  for (const points of wanted) {
    try {
      legs.push({ key: legKey(points), leg: await (options === undefined ? router.route(points) : router.route(points, options)) });
    } catch {
      // No road route now: the handler estimates.
    }
  }
  return { legs };
}

export function preparedRouter(prepared: unknown): Router {
  const legs = (prepared as PreparedLegs | null | undefined)?.legs ?? [];
  const estimate = new EstimateRouter();
  return {
    async route(points: LatLng[]): Promise<RouteLeg> {
      const key = legKey(points);
      const found = legs.find((l) => l.key === key);
      if (found) return found.leg;
      const { points: _shape, ...leg } = await estimate.route(points);
      return leg;
    },
  };
}
