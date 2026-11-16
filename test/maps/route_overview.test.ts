import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OsrmRouter, prepareLegs, preparedRouter } from "../../src/maps/routing.js";
import { fakeOsrm } from "../e2e/harness.js";

/**
 * S7 0.17 (owner W2 Q120 part 3): OSRM was always asked with overview=full (the whole road shape), also by callers
 * that read only the distance and the time. `route(points, { shape: false })` asks with overview=false; the default
 * stays the full shape (the trip's line on the map, the ride check's planned route).
 */
let osrm: Awaited<ReturnType<typeof fakeOsrm>>;
const A = { lat: 59.3326, lng: 18.0649 };
const B = { lat: 59.3143, lng: 18.0735 };

beforeAll(async () => {
  osrm = await fakeOsrm({ distance: 4200, duration: 600 });
});
afterAll(async () => {
  await osrm.close();
});

describe("S7 0.17: a lighter OSRM answer where the shape is not needed", () => {
  it("default: overview=full and the shape, as before", async () => {
    const leg = await new OsrmRouter(osrm.url).route([A, B]);
    expect(osrm.calls.at(-1)).toContain("overview=full");
    expect(leg).toMatchObject({ distanceMeters: 4200, durationSeconds: 600, source: "osrm" });
    expect(leg.points).toEqual([A, B]);
  });

  it("shape: false asks overview=false: the same distance and time, no shape", async () => {
    const router = new OsrmRouter(osrm.url) as unknown as { route: (points: unknown[], options?: { shape?: boolean }) => Promise<Record<string, unknown>> };
    const leg = await router.route([A, B], { shape: false });
    console.log(`0.17 proof (overview): OSRM asked with ${/overview=[a-z]+/.exec(osrm.calls.at(-1)!)?.[0]}`);
    expect(osrm.calls.at(-1)).toContain("overview=false");
    expect(osrm.calls.at(-1)).not.toContain("overview=full");
    expect(leg).toEqual({ distanceMeters: 4200, durationSeconds: 600, source: "osrm" });
  });

  it("prepareLegs passes the option on, and the prepared leg is found again by its points", async () => {
    const prepare = prepareLegs as unknown as (router: OsrmRouter, wanted: unknown[][], options?: { shape?: boolean }) => Promise<unknown>;
    const prepared = await prepare(new OsrmRouter(osrm.url), [[A, B]], { shape: false });
    expect(osrm.calls.at(-1)).toContain("overview=false");
    expect(await preparedRouter(prepared).route([A, B])).toEqual({ distanceMeters: 4200, durationSeconds: 600, source: "osrm" });
    await prepareLegs(new OsrmRouter(osrm.url), [[A, B]]);
    expect(osrm.calls.at(-1)).toContain("overview=full");
  });
});
