import { describe, expect, it } from "vitest";
import { areaContains, bboxOf } from "../../src/areas/geometry.js";
import { loadAreaData } from "../../src/areas/seed.js";

/**
 * v0.18.172 (plan §2.2, GM edit 3: CI and the build tool only, never at boot): the 11 stadsdelsområden cover kommun 0180
 * with no gap and no overlap. Sampled on a grid of about 150 m over the kommun: every point inside the kommun is in exactly
 * one district (at most 0.1 % of points may miss or double, the simplification tolerance).
 */
describe("Stockholm districts geometry", () => {
  it("11 districts, each derived and approximate, union = kommun 0180 within 0.1 %", () => {
    const { features } = loadAreaData();
    const kommun = features.find((f) => f.properties.areaId === "SE-K-0180")!;
    const districts = features.filter((f) => f.properties.kind === "stadsdelsomrade");
    expect(districts.map((d) => d.properties.name).sort()).toEqual(["Bromma", "Enskede-Årsta-Vantör", "Farsta", "Hägersten-Älvsjö", "Hässelby-Vällingby", "Järva", "Kungsholmen", "Norra innerstaden", "Skarpnäck", "Skärholmen", "Södermalm"]);
    expect(districts.every((d) => d.properties.derived && d.properties.parentAreaId === "SE-K-0180")).toBe(true);
    const k = { polygons: kommun.polygons, bbox: bboxOf(kommun.polygons) };
    const ds = districts.map((d) => ({ polygons: d.polygons, bbox: bboxOf(d.polygons) }));
    let inside = 0, gaps = 0, doubles = 0, outside = 0;
    for (let lat = k.bbox.south; lat <= k.bbox.north; lat += 0.00135) {
      for (let lng = k.bbox.west; lng <= k.bbox.east; lng += 0.0027) {
        const n = ds.filter((d) => areaContains(d, lat, lng)).length;
        if (areaContains(k, lat, lng)) {
          inside++;
          if (n === 0) gaps++;
          if (n > 1) doubles++;
        } else if (n > 0) outside++;
      }
    }
    expect(inside).toBeGreaterThan(5000);
    expect(gaps / inside).toBeLessThan(0.001);
    expect(doubles / inside).toBeLessThan(0.001);
    expect(outside / inside).toBeLessThan(0.001);
  }, 120_000);
});
