import { describe, expect, it } from "vitest";
import { appDocWithPricing } from "../../src/config/service.js";
import { pricingProblems } from "../../src/config/pricingRules.js";
import { contractJson } from "../../src/contract/contract.js";
import { extrasOf, riderExtras, sameExtras } from "../../src/rules/priceExtras.js";
import { scheduledSurgeAt } from "../../src/pricing/surge.js";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const doc = () => structuredClone(contractJson<Json>("fixtures/config/pricing_document.json"));
const sek = (amountMinor: number) => ({ amountMinor, currency: "SEK" });

describe("pricing document checks (admin demo validateZoneBook)", () => {
  it("the contract's Z001 document passes", () => {
    expect(pricingProblems(doc())).toEqual([]);
  });

  it("refuses what the demo refuses", () => {
    const d = doc();
    d.categories.economy.base = sek(0);
    d.categories.comfort.minimum = sek(300000);
    d.categories.premium.perKm = sek(-1);
    d.categories.pet.waiting.noShowFee = sek(-5);
    d.fees.reservationFee = sek(-1);
    d.fixedRoutes = [{ id: "R1", from: " ", to: "B", categoryId: "economy", price: sek(0) }];
    d.surge.smart.activeFrom = "25:00";
    d.surge.smart.profiles[0].isDefault = true;
    d.surge.smart.profiles[1].name = " ";
    d.surge.smart.profiles[1].days = [];
    d.surge.smart.profiles[1].windows = [{ from: "7:00", to: "09:00" }];
    d.surge.smart.profiles[2].steps = [{ ratio: 2, multiplier: 1.5 }, { ratio: 1.5, multiplier: 1.2 }, { ratio: 3, multiplier: 2.5 }];
    d.surge.scheduled = [{ id: "s1", multiplier: 1.5, startsAt: "2026-10-27T10:00:00Z", endsAt: "2026-10-27T10:00:00Z" }];
    const problems = pricingProblems(d);
    for (const text of [
      "categories.economy.base: the base fare must be above 0",
      "categories.comfort.minimum: the minimum fare is higher than the maximum fare",
      "categories.premium.perKm: must be 0 or more",
      "categories.pet.waiting.noShowFee: must be 0 or more",
      "fees.reservationFee: fees must be 0 or more",
      "fixedRoutes.R1: a fixed route needs a from and a to place",
      "fixedRoutes.R1: a fixed route needs a price above 0",
      "surge.smart.active: active hours must be like 06:00",
      "surge.smart.profiles: smart surge needs exactly one Normal (fallback) profile",
      "surge.smart.rush: every time profile needs a name",
      "surge.smart.rush: pick at least one day",
      "surge.smart.rush: times must be like 07:00",
      "surge.smart.night.steps: each step must have a higher level and at least the same surge as the one before",
      "surge.smart.night.steps: a step is above the cap ×2",
      'surge.scheduled.s1: scheduled surge "untitled" must end after it starts',
    ]) expect(problems).toContain(text);
  });

  it("no maximum (null) never clashes with the minimum", () => {
    const d = doc();
    d.categories.economy.maximum = null;
    expect(pricingProblems(d)).toEqual([]);
  });
});

describe("request extras", () => {
  it("keeps only what prices the ride (v0.7.1: the rider sends only a fixed route; seats and airport flags are not extras)", () => {
    expect(extrasOf({ babySeats: 0, childSeats: 2, airportPickup: false, airportDropoff: true, fixedRouteId: "R1", pickupInAirportZone: true, other: 1 })).toEqual({ fixedRouteId: "R1", pickupInAirportZone: true });
    expect(riderExtras({ fixedRouteId: "R1", pickupInAirportZone: true, airportPickup: true })).toEqual({ fixedRouteId: "R1" });
    expect(extrasOf(null)).toEqual({});
    expect(sameExtras({ fixedRouteId: "R1", pickupInAirportZone: true }, { fixedRouteId: "R1" })).toBe(true);
    expect(sameExtras({ fixedRouteId: "R1" }, { fixedRouteId: "R2" })).toBe(false);
  });

  it("v0.7.1: overlapping scheduled windows, the higher counts; else 1", () => {
    const scheduled = [
      { id: "a", multiplier: 1.4, startsAt: "2026-10-27T10:00:00Z", endsAt: "2026-10-27T11:00:00Z" },
      { id: "b", multiplier: 2, startsAt: "2026-10-27T10:30:00Z", endsAt: "2026-10-27T12:00:00Z" },
    ];
    expect(scheduledSurgeAt(scheduled, new Date("2026-10-27T10:15:00Z"))).toEqual({ multiplier: 1.4, until: "2026-10-27T11:00:00Z" });
    expect(scheduledSurgeAt(scheduled, new Date("2026-10-27T10:45:00Z"))).toEqual({ multiplier: 2, until: "2026-10-27T12:00:00Z" });
    expect(scheduledSurgeAt(scheduled, new Date("2026-10-27T11:00:00Z"))).toEqual({ multiplier: 2, until: "2026-10-27T12:00:00Z" });
    expect(scheduledSurgeAt(scheduled, new Date("2026-10-27T12:00:00Z"))).toEqual({ multiplier: 1 });
    expect(scheduledSurgeAt(undefined, new Date())).toEqual({ multiplier: 1 });
  });
});

describe("app documents follow the pricing document (configDocs.publishPricing)", () => {
  const rider = contractJson<Json>("fixtures/config/rider_app_config.json");
  const driver = contractJson<Json>("fixtures/config/driver_app_config.json");

  it("the contract's samples already match the Z001 pricing document", () => {
    expect(appDocWithPricing("rider_app_config", rider, doc())).toEqual({ ...rider, waiting: expect.anything(), pickupFee: expect.anything() });
    const synced = appDocWithPricing("rider_app_config", rider, doc()) as Json;
    for (const id of Object.keys(rider.waiting.byCategory)) expect(synced.waiting.byCategory[id]).toEqual(rider.waiting.byCategory[id]);
    expect((synced.waiting as Json).noShowFee).toEqual(sek(6500));
  });

  it("copies waiting, no-show and the rider pickup fee; keeps the rest", () => {
    const d = doc();
    d.categories.economy.waiting.noShowFee = sek(7000);
    d.categories.comfort.riderPickupFee = { live: sek(1500), reservation: sek(2000) };
    const r = appDocWithPricing("rider_app_config", rider, d) as Json;
    expect(r.waiting.noShowFee).toEqual(sek(7000));
    expect(r.waiting.byCategory.child_seat.noShowFee).toEqual(sek(6500));
    expect(r.pickupFee.byCategory.comfort).toEqual({ live: sek(1500), reservation: sek(2000) });
    expect(r.tips).toEqual(rider.tips);
    const dr = appDocWithPricing("driver_app_config", driver, d) as Json;
    expect(dr.waiting.driverSharePct).toBe(driver.waiting.driverSharePct);
    expect(dr.pickupPay.byCategory.comfort.riderFee).toEqual({ live: sek(1500), reservation: sek(2000) });
    // No pickup pay rate for a category: it gets none.
    expect(dr.pickupPay.byCategory.premium).toBeUndefined();
    expect(appDocWithPricing("driver_app_config", { zoneId: "Z001" }, d)).toMatchObject({ waiting: { noShowFee: sek(7000) } });
  });
});
