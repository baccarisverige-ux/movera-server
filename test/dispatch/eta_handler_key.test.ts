import { describe, expect, it } from "vitest";
import { dispatchHandlers } from "../../src/dispatch/runtime.js";
import { TRIP_ETA } from "../../src/trips/eta.js";

// Render deploy of 48e587e crashed at start: eta.ts ↔ dispatch/runtime.ts import each other and the handler table read
// TRIP_ETA before eta.ts had run. The key is spelled out now; it must stay the same name as the timer eta.ts books.
describe("dispatch handler table", () => {
  it("handles the trip_eta timer under the same name eta.ts books it with", () => {
    expect(TRIP_ETA).toBe("trip_eta");
    expect(typeof dispatchHandlers[TRIP_ETA]).toBe("function");
  });
});
