import { describe, expect, it } from "vitest";
import { contractJson } from "../../src/contract/contract.js";
import { boundsOf, inPolygon, polygonProblem, type Polygon } from "../../src/zones/geometry.js";

type Fixture = { zones: Array<{ zoneId: string; kind: string; open: boolean; polygon: Polygon; bounds: Record<string, number> }>; points: Array<{ name: string; lat: number; lng: number; zoneId: string | null; airport?: string }> };
const fixture = contractJson<Fixture>("fixtures/zones.json");

describe("zone geometry (contract v0.11.0 §20, fixtures/zones.json)", () => {
  it("bounds are the outline's rectangle", () => {
    for (const zone of fixture.zones) expect(boundsOf(zone.polygon), zone.zoneId).toEqual(zone.bounds);
  });

  it("every fixture point lands in its zone", () => {
    const area = (b: Record<string, number>) => (b["north"]! - b["south"]!) * (b["east"]! - b["west"]!);
    for (const point of fixture.points) {
      const hits = fixture.zones
        .filter((z) => inPolygon(point.lat, point.lng, z.polygon))
        .sort((a, b) => Number(b.open) - Number(a.open) || Number(a.kind === "airport") - Number(b.kind === "airport") || area(a.bounds) - area(b.bounds));
      expect(hits[0]?.zoneId ?? null, point.name).toBe(point.zoneId);
      // An airport inside the city zone adds its fees, it does not take the ride.
      expect(fixture.zones.find((z) => z.kind === "airport" && inPolygon(point.lat, point.lng, z.polygon))?.zoneId, point.name).toBe(point.airport);
    }
  });

  it("an edge and a corner are inside", () => {
    const square: Polygon = [[0, 0], [0, 1], [1, 1], [1, 0]];
    expect(inPolygon(0, 0.5, square)).toBe(true);
    expect(inPolygon(1, 1, square)).toBe(true);
    expect(inPolygon(0.5, 0.5, square)).toBe(true);
    expect(inPolygon(1.01, 0.5, square)).toBe(false);
  });

  it("refuses outlines that are closed, repeat a point, have no area or cross themselves", () => {
    expect(polygonProblem([[0, 0], [0, 1], [1, 1], [0, 0]])).toBe("polygon_closed");
    expect(polygonProblem([[0, 0], [0, 1], [0, 1], [1, 1]])).toBe("polygon_repeated_point");
    expect(polygonProblem([[0, 0], [1, 1], [2, 2]])).toBe("polygon_no_area");
    expect(polygonProblem([[0, 0], [1, 1], [0, 1], [1, 0]])).toBe("polygon_self_crossing");
    for (const zone of fixture.zones) expect(polygonProblem(zone.polygon), zone.zoneId).toBeNull();
  });
});
