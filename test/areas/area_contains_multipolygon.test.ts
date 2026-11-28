import { describe, expect, it } from "vitest";
import { areaContains, bboxOf, searchKey } from "../../src/areas/geometry.js";
import type { AreaPolygons } from "../../src/db/schema/areas.js";

/** v0.18.172 (plan §2.6 area_contains_multipolygon): islands are separate polygons, enclaves are holes. */
const square = (lat: number, lng: number, size: number): Array<[number, number]> => [[lat, lng], [lat, lng + size], [lat + size, lng + size], [lat + size, lng]];
const polygons: AreaPolygons = [
  [square(0, 0, 10), square(4, 4, 2)], // main land with a hole (an enclave)
  [square(20, 20, 2)], // an island
];
const area = { polygons, bbox: bboxOf(polygons) };

describe("areaContains", () => {
  it("a point on the island polygon is inside", () => expect(areaContains(area, 21, 21)).toBe(true));
  it("a point in the main land is inside", () => expect(areaContains(area, 1, 1)).toBe(true));
  it("a point inside the hole is outside", () => expect(areaContains(area, 5, 5)).toBe(false));
  it("a point outside every polygon (inside the bbox) is outside", () => expect(areaContains(area, 15, 15)).toBe(false));
  it("a point outside the bbox is outside", () => expect(areaContains(area, -1, 30)).toBe(false));
});

describe("searchKey (same as tools/areas/build_areas.py key)", () => {
  it("removes accents and case, signs become one space", () => {
    expect(searchKey("Söder")).toBe("soder");
    expect(searchKey("Saint-Denis")).toBe("saint denis");
    expect(searchKey("L'Haÿ-les-Roses")).toBe("l hay les roses");
    expect(searchKey("  Enskede-Årsta-Vantör ")).toBe("enskede arsta vantor");
  });
});
