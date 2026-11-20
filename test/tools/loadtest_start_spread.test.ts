import { describe, expect, it } from "vitest";
import { driverStartSpreadMs, START_SPREAD_DEFAULT_SECONDS } from "../../tools/loadtest/guards.mjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** S4c fix 1 (load tool only): the drivers start over 60 s by default (was 10 s: a login burst the apps never send). */
describe("phone-load driver start spread", () => {
  it("defaults to 60 s", () => {
    expect(START_SPREAD_DEFAULT_SECONDS).toBe(60);
    expect(driverStartSpreadMs(undefined)).toBe(60_000);
  });
  it("takes --driver-start-spread seconds, 0 to 600", () => {
    expect(driverStartSpreadMs("10")).toBe(10_000);
    expect(driverStartSpreadMs("0")).toBe(0);
    expect(() => driverStartSpreadMs("601")).toThrow(/driver-start-spread/);
    expect(() => driverStartSpreadMs("abc")).toThrow(/driver-start-spread/);
  });
  it("the tool uses it for the driver starts (no fixed 10 s left)", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "..", "tools", "loadtest", "phone-load.mjs"), "utf8");
    expect(src).toContain('driverStartSpreadMs(arg("driver-start-spread"))');
    expect(src).not.toMatch(/rng\(\) \* 10_000, \(\) => p\.start/);
  });
});
