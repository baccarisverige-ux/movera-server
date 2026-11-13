import { describe, expect, it } from "vitest";
import { priceFare, type CategoryPricing, type PricingDocument } from "../../src/rules/fare.js";
import { tripTerms } from "../../src/trips/ride/settings.js";
import type { TripRow } from "../../src/db/tripLog.js";

/**
 * A1 (owner 2026-11-02, Rules decisions/driver-g6.md:96): "Show price incl. fee (Recommended)" => apps/admin show the
 * waiting and stop-wait prices including the app fee (5,50 kr/min, 0,55 €/min) — what you see is what you pay.
 *
 * The charge (contract §3.5, src/rules/fare.ts): waiting and stop waiting are extras and the app fee is added on top, so
 * the rider pays perMin × (1 + appFeePct / 100) a minute. The price the server tells the apps to show is
 * TripProjection.terms.waitPerMinShown / stopWaitPerMinShown (before v0.18.85 there was only the raw waitPerMin /
 * stopWaitPerMin, which the apps showed). "Shown" below is what an app shows: the shown field, else the raw one.
 *
 * Every pricing document here has priceStep = 1 minor unit and a ride part whose app fee is whole, so the total moves by
 * exactly the waiting the rider pays.
 */

type Money = { amountMinor: number; currency: string };
const m = (amountMinor: number, currency: string): Money => ({ amountMinor, currency });

function pricing(currency: string, waitPerMin: number, stopWaitPerMin: number, appFeePct: number, minimum: number): PricingDocument {
  const category: CategoryPricing = {
    enabled: true,
    base: m(0, currency),
    perKm: m(0, currency),
    perMin: m(0, currency),
    minimum: m(minimum, currency),
    maximum: null,
    appFeePct,
    commissionPct: 20,
    extraStopFee: m(0, currency),
    stopWaitPerMin: m(stopWaitPerMin, currency),
    waiting: { freeWaitMin: 5, perMin: m(waitPerMin, currency), noShowAfterMin: 5, noShowFee: m(minimum, currency) },
    riderPickupFee: { live: null, reservation: null },
  };
  return {
    zoneId: `Z-${currency}`,
    currency,
    priceStep: m(1, currency),
    categories: { economy: category },
    fees: { airportPickup: m(0, currency), airportDropoff: m(0, currency), reservationFee: m(0, currency) },
    fixedRoutes: [],
    surge: {},
  };
}

/** A trip booked with this pricing: the booking snapshot as bookingRulesFor keeps it (src/trips/ride/settings.ts). */
function trip(doc: PricingDocument): Pick<TripRow, "booking_rules" | "currency"> {
  const cat = doc.categories["economy"]!;
  return {
    currency: doc.currency,
    booking_rules: {
      cancelRule: null,
      cancelDriverSharePct: 100,
      waiting: cat.waiting,
      stopWaitPerMin: cat.stopWaitPerMin,
      appFeePct: cat.appFeePct,
      noShowDriverSharePct: 80,
      waitDriverSharePct: 100,
      cancelAfterArrivedIsNoShow: true,
      maxPickupMoveMeters: 200,
      waitingRules: null,
      stopFreeWaitMin: 0,
      pin: { required: false, maxAttempts: 5, lockMinutes: 5 },
    } as unknown as TripRow["booking_rules"],
  };
}

const shown = (terms: Record<string, unknown> | null, raw: "waitPerMin" | "stopWaitPerMin") =>
  ((terms?.[`${raw}Shown`] ?? terms?.[raw]) as Money).amountMinor;

const base = { categoryId: "economy", km: 0, minutes: 0, kind: "live" as const };
/** What the rider pays for `minutes` of paid pickup waiting: the fare with it minus the fare without. */
const chargedPickup = (doc: PricingDocument, minutes: number) =>
  priceFare(doc, { ...base, waitingChargedSeconds: minutes * 60 }).total.amountMinor - priceFare(doc, base).total.amountMinor;
/** What the rider pays for `minutes` of waiting at one middle stop (extraStopFee 0 here). */
const chargedStop = (doc: PricingDocument, minutes: number) =>
  priceFare(doc, { ...base, stopWaitSeconds: [minutes * 60] }).total.amountMinor - priceFare(doc, { ...base, stopWaitSeconds: [0] }).total.amountMinor;

// [label, currency, waitPerMin, stopWaitPerMin, appFeePct, minimum (its app fee is whole)]
const EXACT: Array<[string, string, number, number, number, number]> = [
  ["SEK, the owner's 5 kr -> 5,50 kr/min", "SEK", 500, 500, 10, 4900],
  ["EUR, the owner's 0,50 € -> 0,55 €/min", "EUR", 50, 50, 10, 1000],
  ["TND, 0.250 DT -> 0.275 DT/min (3 decimals)", "TND", 250, 250, 10, 5000],
];

describe("A1: the waiting price shown is the price charged (driver-g6.md:96, contract v0.18.85 waitingPriceShown)", () => {
  it.each(EXACT)("%s: shown per minute × minutes = charged, pickup and stop waiting", (_label, currency, wait, stop, pct, min) => {
    const doc = pricing(currency, wait, stop, pct, min);
    const terms = tripTerms(trip(doc));
    for (const minutes of [1, 7, 10]) {
      expect({ minutes, pickup: shown(terms, "waitPerMin") * minutes }).toEqual({ minutes, pickup: chargedPickup(doc, minutes) });
      expect({ minutes, stop: shown(terms, "stopWaitPerMin") * minutes }).toEqual({ minutes, stop: chargedStop(doc, minutes) });
    }
  });

  it.each([
    ["SEK economy 12,26 kr + 10 % -> 13,49 kr/min", "SEK", 1226, 10, 1349],
    ["SEK premium 16,90 kr + 12 % -> 18,93 kr/min", "SEK", 1690, 12, 1893],
  ] as const)("%s: shown = one minute charged; N minutes differ only by the shown price's rounding", (_label, currency, wait, pct, perMinShown) => {
    const doc = pricing(currency, wait, wait, pct, 5000);
    const terms = tripTerms(trip(doc));
    expect(shown(terms, "waitPerMin")).toBe(perMinShown);
    expect(chargedPickup(doc, 1)).toBe(perMinShown);
    // The exact charge is 13.486 kr a minute; the shown 13.49 kr is that, half-up to a whole öre (contract §3.5 step 7).
    for (const minutes of [5, 10]) expect(Math.abs(shown(terms, "waitPerMin") * minutes - chargedPickup(doc, minutes))).toBeLessThanOrEqual(Math.ceil(minutes / 2));
  });

  it("the raw waitPerMin and stopWaitPerMin stay (the driver's own price: waiting is 100 % his, contract §3.5 money split)", () => {
    const doc = pricing("SEK", 1226, 500, 10, 4900);
    const terms = tripTerms(trip(doc));
    expect(terms?.["waitPerMin"]).toEqual(m(1226, "SEK"));
    expect(terms?.["stopWaitPerMin"]).toEqual(m(500, "SEK"));
    // The driver's share does not change: the waiting lines are his, the app fee on them is Movera's.
    const fare = priceFare(doc, { ...base, waitingChargedSeconds: 600 });
    const without = priceFare(doc, base);
    expect(fare.driverEarnings.amountMinor - without.driverEarnings.amountMinor).toBe(12260);
  });

  it("a trip booked before v0.18.85 (no appFeePct kept) gets no shown field, never a guessed one", () => {
    const old = trip(pricing("SEK", 1226, 500, 10, 4900));
    delete (old.booking_rules as Record<string, unknown>)["appFeePct"];
    const terms = tripTerms(old);
    expect(terms?.["waitPerMinShown"]).toBeUndefined();
    expect(terms?.["stopWaitPerMinShown"]).toBeUndefined();
  });
});
