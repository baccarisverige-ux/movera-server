import { contract } from "../contract/contract.js";

/**
 * Road distance and time between points (contract §10; owner decision 4: Movera's own OSRM). Until OSRM runs
 * (OSRM_URL unset, or OSRM down) the server estimates the way the admin panel's dispatch test does: straight line
 * × 1.25 at 24 km/h (contract.json#dispatch.score roadFactor, pickupKmh). Every result says which one it is.
 */

export type LatLng = { lat: number; lng: number };
export type RouteLeg = { distanceMeters: number; durationSeconds: number; source: "osrm" | "estimate"; points?: LatLng[] };

export interface Router {
  route(points: LatLng[]): Promise<RouteLeg>;
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

/** OSRM v5 /route/v1/driving. Falls back to the estimate when OSRM does not answer in time. */
export class OsrmRouter implements Router {
  private readonly fallback = new EstimateRouter();

  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 2500,
    private readonly onFallback: (error: unknown) => void = () => undefined,
  ) {}

  async route(points: LatLng[]): Promise<RouteLeg> {
    const coordinates = points.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(";");
    const url = `${this.baseUrl.replace(/\/$/, "")}/route/v1/driving/${coordinates}?overview=full&geometries=geojson&steps=false&alternatives=false`;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
      const body = (await response.json()) as { code?: string; routes?: Array<{ distance: number; duration: number; geometry?: { coordinates?: number[][] } }> };
      const best = body.routes?.[0];
      if (!response.ok || body.code !== "Ok" || best === undefined) throw new Error(`OSRM answered ${response.status} ${body.code ?? ""}`);
      return {
        distanceMeters: Math.round(best.distance),
        durationSeconds: Math.round(best.duration),
        source: "osrm",
        points: (best.geometry?.coordinates ?? []).map(([lng, lat]) => ({ lat: lat!, lng: lng! })),
      };
    } catch (error) {
      this.onFallback(error);
      return this.fallback.route(points);
    }
  }
}
