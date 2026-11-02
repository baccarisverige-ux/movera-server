import { describe, expect, it } from "vitest";
import { stopsWithVisits } from "../../src/trips/projection.js";

// Live re-check 2026-11-02 (G7 round 2, item 2): the arrival was only in stopVisits; contract.json#stopWaits says
// TripProjection.stops[i].arrivedAt / leftAt.
describe("stopsWithVisits", () => {
  const a = { address: "Mariatorget", lat: 59.317, lng: 18.064 };
  const b = { address: "Odenplan", lat: 59.343, lng: 18.05 };

  it("puts each visit on its stop", () => {
    const visits = [
      { stopIndex: 0, arrivedAt: "2026-11-02T02:10:00.000Z", leftAt: "2026-11-02T02:12:00.000Z" },
      { stopIndex: 1, arrivedAt: "2026-11-02T02:20:00.000Z" },
    ];
    expect(stopsWithVisits([a, b], visits)).toEqual([
      { ...a, arrivedAt: "2026-11-02T02:10:00.000Z", leftAt: "2026-11-02T02:12:00.000Z" },
      { ...b, arrivedAt: "2026-11-02T02:20:00.000Z" },
    ]);
  });

  it("no visits: the stops as they are; a stored client echo of arrivedAt never counts", () => {
    expect(stopsWithVisits([a, b], null)).toEqual([a, b]);
    expect(stopsWithVisits([{ ...a, arrivedAt: "2026-11-02T00:00:00.000Z" }], [])).toEqual([a]);
    expect(stopsWithVisits(null, [{ stopIndex: 0, arrivedAt: "x" }])).toEqual([]);
  });
});
