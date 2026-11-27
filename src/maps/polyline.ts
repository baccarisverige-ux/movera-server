import type { LatLng } from "./routing.js";

/**
 * v0.18.163 (contract.json#liveTraffic.duringTrip): Google's encoded polyline (precision 5) and the along-the-route
 * maths the ETA uses during a trip with no Google call: where the car is on the stored route, how far it is off it, and
 * how many metres are left.
 */
export function decodePolyline(encoded: string): LatLng[] {
  const points: LatLng[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    for (const axis of [0, 1]) {
      let result = 0;
      let shift = 0;
      let byte: number;
      do {
        if (index >= encoded.length) return points;
        byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta;
      else lng += delta;
    }
    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return points;
}

export function encodePolyline(points: LatLng[]): string {
  let out = "";
  let pLat = 0;
  let pLng = 0;
  const put = (v: number) => {
    let n = v < 0 ? ~(v << 1) : v << 1;
    while (n >= 0x20) {
      out += String.fromCharCode((0x20 | (n & 0x1f)) + 63);
      n >>= 5;
    }
    out += String.fromCharCode(n + 63);
  };
  for (const p of points) {
    const lat = Math.round(p.lat * 1e5);
    const lng = Math.round(p.lng * 1e5);
    put(lat - pLat);
    put(lng - pLng);
    pLat = lat;
    pLng = lng;
  }
  return out;
}

const R = 6371008.8;
/** Local flat metres around `origin` (fine at city scale). */
function toXY(p: LatLng, origin: LatLng): [number, number] {
  const rad = Math.PI / 180;
  return [(p.lng - origin.lng) * rad * R * Math.cos(origin.lat * rad), (p.lat - origin.lat) * rad * R];
}

/** Where `at` is on the route: metres off it, and metres left along it from the nearest point to the end. */
export function alongRoute(route: LatLng[], at: LatLng): { offMeters: number; remainingMeters: number } {
  if (route.length === 0) return { offMeters: Infinity, remainingMeters: 0 };
  if (route.length === 1) {
    const [x, y] = toXY(route[0]!, at);
    return { offMeters: Math.hypot(x, y), remainingMeters: 0 };
  }
  const seg: number[] = [];
  for (let i = 1; i < route.length; i++) {
    const [ax, ay] = toXY(route[i - 1]!, at);
    const [bx, by] = toXY(route[i]!, at);
    seg.push(Math.hypot(bx - ax, by - ay));
  }
  let best = { off: Infinity, i: 0, t: 0 };
  for (let i = 1; i < route.length; i++) {
    const [ax, ay] = toXY(route[i - 1]!, at);
    const [bx, by] = toXY(route[i]!, at);
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    const off = Math.hypot(ax + t * dx, ay + t * dy);
    if (off < best.off) best = { off, i: i - 1, t };
  }
  let remaining = seg[best.i]! * (1 - best.t);
  for (let k = best.i + 1; k < seg.length; k++) remaining += seg[k]!;
  return { offMeters: best.off, remainingMeters: remaining };
}

/**
 * v0.18.171 (contract.json#googleRoadLines.navigation): the route from the point on it nearest `at` to its end, with
 * how far `at` is off it and the metres left. The first point is that nearest point (on the segment), so the driver's
 * line starts at the car, not back at where the route was asked.
 */
export function cutFrom(route: LatLng[], at: LatLng): { points: LatLng[]; offMeters: number; remainingMeters: number } {
  if (route.length < 2) return { points: [...route], ...alongRoute(route, at) };
  let best = { off: Infinity, i: 0, t: 0 };
  for (let i = 1; i < route.length; i++) {
    const [ax, ay] = toXY(route[i - 1]!, at);
    const [bx, by] = toXY(route[i]!, at);
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    const off = Math.hypot(ax + t * dx, ay + t * dy);
    if (off < best.off) best = { off, i: i - 1, t };
  }
  const a = route[best.i]!;
  const b = route[best.i + 1]!;
  const start = { lat: a.lat + (b.lat - a.lat) * best.t, lng: a.lng + (b.lng - a.lng) * best.t };
  const rest = route.slice(best.i + 1);
  const points = best.t >= 1 ? rest : [start, ...rest];
  const { remainingMeters } = alongRoute(route, at);
  return { points: points.length >= 2 ? points : [start, route[route.length - 1]!], offMeters: best.off, remainingMeters };
}
