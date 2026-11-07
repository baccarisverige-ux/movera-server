import { describe, expect, it } from "vitest";
import { momentOf, RIDER_TRIP_PUSH } from "../../src/notifications/tripPush.js";

/**
 * Contract v0.18.50 §72, owner L11 (Rules plan/finders-2026-11-07/LIFECYCLE.md): the rider push for a search that ended
 * with no driver (expired) and for a system failure (failed) has its own words, not "Trip cancelled".
 */
describe("L11: rider push words for no driver found and a failure", () => {
  it("expired → no_driver_found, failed → trip_failed; a real cancel stays trip_cancelled (fail-before: trip_cancelled for all)", () => {
    expect(momentOf({ status: "searching", driver_id: null }, { status: "expired" })).toBe("no_driver_found");
    expect(momentOf({ status: "in_trip", driver_id: "drv_1" }, { status: "failed" })).toBe("trip_failed");
    for (const status of ["cancelled_by_driver", "cancelled_by_admin", "cancelled_by_system"]) {
      expect(momentOf({ status: "accepted", driver_id: "drv_1" }, { status }), status).toBe("trip_cancelled");
    }
    expect(momentOf({ status: "accepted", driver_id: "drv_1" }, { status: "cancelled_by_rider" })).toBeNull();
  });

  it("the owner's French words, with sv and en", () => {
    const texts = RIDER_TRIP_PUSH.texts as Record<string, { title: Record<string, string>; body: Record<string, string> }>;
    expect(texts["no_driver_found"]!.title.fr).toBe("Aucun chauffeur disponible pour le moment");
    expect(texts["trip_failed"]!.title.fr).toBe("Un problème est survenu, votre course n’a pas pu être réservée");
    for (const m of ["no_driver_found", "trip_failed"]) for (const part of ["title", "body"] as const) expect(Object.keys(texts[m]![part]).sort()).toEqual(["en", "fr", "sv"]);
  });
});
