import { afterEach, describe, expect, it, vi } from "vitest";

/** v0.18.144 (contract.json#liveLocation.load): the load generator's rider-sharing mode, LOADTEST_LIVE_SHARE=1. */
describe("load generator rider-sharing mode", () => {
  afterEach(() => {
    delete process.env["LOADTEST_LIVE_SHARE"];
    vi.resetModules();
  });
  it("off by default: no live-location request in any state", async () => {
    vi.resetModules();
    const { CADENCES } = await import("../../tools/loadtest/cadences.mjs");
    const ids = Object.values(CADENCES).flatMap((app) => Object.values(app).flat().map((e) => (e as { id: string }).id));
    expect(ids.filter((id) => id.includes("live-location"))).toEqual([]);
  });
  it("on: the rider (waiting, arrived) and the driver (to / at pickup) PUT live-location every 8 s", async () => {
    process.env["LOADTEST_LIVE_SHARE"] = "1";
    vi.resetModules();
    const { CADENCES, budgetPerMinute, LIVE_SHARE } = await import("../../tools/loadtest/cadences.mjs");
    expect(LIVE_SHARE).toBe(true);
    expect(budgetPerMinute("rider", "waiting")["PUT /trips/{id}/live-location (rider)"]).toBe(7.5);
    expect(budgetPerMinute("rider", "arrived")["PUT /trips/{id}/live-location (rider)"]).toBe(7.5);
    expect(budgetPerMinute("driver", "to_pickup")["PUT /trips/{id}/live-location (driver)"]).toBe(7.5);
    expect(budgetPerMinute("driver", "at_pickup")["PUT /trips/{id}/live-location (driver)"]).toBe(7.5);
    expect((CADENCES.rider["in_trip"] ?? []).map((e: { id: string }) => e.id)).not.toContain("PUT /trips/{id}/live-location (rider)");
  });
});
