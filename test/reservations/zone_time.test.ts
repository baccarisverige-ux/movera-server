import { describe, expect, it } from "vitest";
import { clock } from "../../src/reservations/service.js";

/** Book later texts name the pickup time in the zone's own time: Sweden, France and Tunisia (owner Q7). */
describe("book later {time} per country", () => {
  const at = new Date("2026-11-05T07:00:00Z");
  it("Stockholm, Paris and Tunis are one hour ahead of UTC in November", () => {
    expect(clock(at, "Europe/Stockholm")).toBe("08:00");
    expect(clock(at, "Europe/Paris")).toBe("08:00");
    expect(clock(at, "Africa/Tunis")).toBe("08:00");
  });
  it("summer: Stockholm and Paris move, Tunis does not", () => {
    const july = new Date("2026-07-05T07:00:00Z");
    expect(clock(july, "Europe/Stockholm")).toBe("09:00");
    expect(clock(july, "Europe/Paris")).toBe("09:00");
    expect(clock(july, "Africa/Tunis")).toBe("08:00");
  });
});
