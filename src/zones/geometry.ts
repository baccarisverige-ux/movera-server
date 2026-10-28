/** Contract v0.11.0 §20 (contract.json#zones.polygon): a zone's outline, [[lat, lng], ...], not closed. */
export type Polygon = Array<[number, number]>;
export type Bounds = { south: number; west: number; north: number; east: number };

/** Point in polygon by ray casting; a point on an edge or a corner is inside. */
export function inPolygon(lat: number, lng: number, polygon: readonly (readonly [number, number])[]): boolean {
  let inside = false;
  for (let k = 0; k < polygon.length; k++) {
    const [y1, x1] = polygon[k]!;
    const [y2, x2] = polygon[(k + 1) % polygon.length]!;
    if (onSegment(lat, lng, y1, x1, y2, x2)) return true;
    if (y1 > lat !== y2 > lat) {
      const x = x1 + ((lat - y1) * (x2 - x1)) / (y2 - y1);
      if (x > lng) inside = !inside;
    }
  }
  return inside;
}

function onSegment(lat: number, lng: number, y1: number, x1: number, y2: number, x2: number): boolean {
  const cross = (lng - x1) * (y2 - y1) - (lat - y1) * (x2 - x1);
  if (Math.abs(cross) > 1e-12) return false;
  return Math.min(x1, x2) <= lng && lng <= Math.max(x1, x2) && Math.min(y1, y2) <= lat && lat <= Math.max(y1, y2);
}

export function boundsOf(polygon: Polygon): Bounds {
  const lats = polygon.map((p) => p[0]);
  const lngs = polygon.map((p) => p[1]);
  return { south: Math.min(...lats), west: Math.min(...lngs), north: Math.max(...lats), east: Math.max(...lngs) };
}

type P = readonly [number, number];
const orient = (a: P, b: P, c: P) => Math.sign((b[1] - a[1]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[1] - a[1]));
function segmentsCross(a: P, b: P, c: P, d: P): boolean {
  const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  const within = (p: P, q: P, r: P) => Math.min(p[0], r[0]) <= q[0] && q[0] <= Math.max(p[0], r[0]) && Math.min(p[1], r[1]) <= q[1] && q[1] <= Math.max(p[1], r[1]);
  return (o1 === 0 && within(a, c, b)) || (o2 === 0 && within(a, d, b)) || (o3 === 0 && within(c, a, d)) || (o4 === 0 && within(c, b, d));
}

/** Why an outline cannot be a zone, or null: closed, repeated points, no area, or edges that cross. */
export function polygonProblem(polygon: Polygon): string | null {
  const n = polygon.length;
  const same = (a: P, b: P) => a[0] === b[0] && a[1] === b[1];
  if (same(polygon[0]!, polygon[n - 1]!)) return "polygon_closed";
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (same(polygon[i]!, polygon[j]!)) return "polygon_repeated_point";
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue; // neighbours share a corner
      if (segmentsCross(polygon[i]!, polygon[(i + 1) % n]!, polygon[j]!, polygon[(j + 1) % n]!)) return "polygon_self_crossing";
    }
  }
  let area = 0;
  for (let i = 0; i < n; i++) {
    const [y1, x1] = polygon[i]!;
    const [y2, x2] = polygon[(i + 1) % n]!;
    area += x1 * y2 - x2 * y1;
  }
  if (Math.abs(area) < 1e-12) return "polygon_no_area";
  return null;
}
