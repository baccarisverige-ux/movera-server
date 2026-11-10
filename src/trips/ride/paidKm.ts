import { haversineKm, type LatLng } from "../../maps/routing.js";

/**
 * Paid km from the trip's GPS trace (owner decision 2026-11-10: smooth the GPS path before counting paid km).
 * Step 72's recorded traces showed the raw sum over-credited ~11 % from jitter. The contract fixes only the drawn
 * path's filter (§25 tripPath, src/trips/path.ts); "km driven" (§3.5) is this server's measure:
 *  1. drop fixes with poor accuracy (> 50 m);
 *  2. drop impossible jumps (implied speed > 200 km/h from the last kept fix);
 *  3. smooth: each fix becomes the accuracy-weighted mean (1 / accuracy²) of the kept fixes within ±5 s;
 *  4. sum the steps, ignoring moves under 15 m, and moves under 40 m while the car stands (speed < 1 m/s).
 */
export const PAID_KM_RULES = { maxAccuracyM: 50, maxKmh: 200, smoothWindowS: 5, minStepM: 15, stillSpeedMps: 1, stillMaxStepM: 40 } as const;

export type TraceFix = LatLng & { accuracy: number; measured_at: Date; speed_mps?: number | null };

export function paidKm(fixes: readonly TraceFix[], rules = PAID_KM_RULES): number {
  const usable = [...fixes].filter((f) => f.accuracy <= rules.maxAccuracyM).sort((a, b) => a.measured_at.getTime() - b.measured_at.getTime());
  if (usable.length < 2) return 0;
  const kept: TraceFix[] = [usable[0]!];
  for (const next of usable.slice(1)) {
    const from = kept[kept.length - 1]!;
    const seconds = Math.max(1, (next.measured_at.getTime() - from.measured_at.getTime()) / 1000);
    if ((haversineKm(from, next) * 3_600_000) / seconds > rules.maxKmh * 1000) continue;
    kept.push(next);
  }
  const windowMs = rules.smoothWindowS * 1000;
  const smooth = kept.map((f) => {
    let w = 0, lat = 0, lng = 0;
    for (const g of kept) {
      if (Math.abs(g.measured_at.getTime() - f.measured_at.getTime()) > windowMs) continue;
      const gw = 1 / Math.max(1, g.accuracy) ** 2;
      w += gw; lat += g.lat * gw; lng += g.lng * gw;
    }
    return { lat: lat / w, lng: lng / w, at: f.measured_at.getTime(), speed: f.speed_mps ?? null };
  });
  let km = 0;
  let from = smooth[0]!;
  for (const next of smooth.slice(1)) {
    const meters = haversineKm(from, next) * 1000;
    if (meters < rules.minStepM) continue;
    const speed = next.speed ?? meters / Math.max(1, (next.at - from.at) / 1000);
    if (speed < rules.stillSpeedMps && meters < rules.stillMaxStepM) continue;
    km += meters / 1000;
    from = next;
  }
  return km;
}
