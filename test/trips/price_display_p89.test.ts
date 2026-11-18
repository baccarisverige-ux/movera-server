import { describe, expect, it } from "vitest";
import type { TripRow } from "../../src/db/tripLog.js";
import type { OfferRow } from "../../src/dispatch/runtime/offers.js";
import { offerView } from "../../src/dispatch/runtime/offers.js";
import { schemaProblem } from "../../src/contract/schemas.js";
import { redactProjection } from "../../src/realtime/events.js";
import { tripProjection } from "../../src/trips/projection.js";
import { routeChangePushText, type RouteChange } from "../../src/trips/routeChange.js";

/**
 * Contract v0.18.89 §90 (contract.json#priceDisplay; owner 2026-11-14 "make sure rider and driver app show correct prices
 * every where", Rules decisions/session-2026-11-06.md:1275): the server sends every money number the apps show —
 * Offer.driverTotal + Offer.cashToCollect, TripProjection.cashToCollect on every pay-in-car trip from accept (driver and
 * admin), TripRouteChange.driverTotal, TripFinish.owedToMovera. The rider never gets the driver's money. Sweden (SEK),
 * France (EUR) and Tunisia (TND, 3 decimals).
 */

type Doc = Record<string, unknown>;
const CURRENCIES = [
  // fare, rider wallet part, driver earnings (no bonus), pickup pay, Movera bonus — in minor units of each currency.
  { currency: "SEK", fare: 18750, wallet: 2500, earnings: 15000, pickup: 360, bonus: 1000, tip: 2000 },
  { currency: "EUR", fare: 2245, wallet: 0, earnings: 1796, pickup: 150, bonus: 0, tip: 0 },
  { currency: "TND", fare: 12350, wallet: 1275, earnings: 9880, pickup: 1125, bonus: 500, tip: 0 },
] as const;
type Case = (typeof CURRENCIES)[number];

const NOW = new Date("2026-11-14T12:00:00Z");
const PLACE = { address: "A", lat: 59.33, lng: 18.06 };

function tripRow(c: Case, change: Doc = {}): TripRow {
  return {
    trip_id: "trp_p89", rider_id: "rdr_1", driver_id: "drv_1", vehicle_id: null, status: "in_trip", version: 7, sequence: "7", kind: "live",
    scheduled_at: null, reservation: null, created_at: NOW, updated_at: NOW, accepted_at: NOW, zone_id: "Z001", category_id: "economy",
    pickup: PLACE, dropoff: PLACE, stops: [], stop_visits: [], currency: c.currency, fare_minor: String(c.fare),
    fare_lines: [{ code: "base", amount: { amountMinor: c.fare, currency: c.currency } }], booked_fare_minor: String(c.fare),
    driver_earnings_minor: String(c.earnings), commission_minor: String(c.fare - c.earnings - c.pickup - c.bonus), pickup_pay_minor: String(c.pickup),
    driver_bonus_minor: String(c.bonus), bonus_exclusive_minor: null, bonus_radar_minor: null, priority: false, priority_exclusive: null, priority_radar: null,
    payment_method: "cash", payment_method_id: null, payment_status: null, rating_status: "pending", driver_rating_status: "pending",
    pin_required: false, pickup_pin: null, pin_verified_at: null, pin_attempts: 0, pin_blocked: false, driver_summary: null, rider_summary: null,
    booking_rules: null, eta: null, heading_check: null, waiting: null, cancellation: null, ride_check: null, route_change: null, admin_flag: null,
    quote_id: null, tip: null, driver_adjustments_minor: "0", refunded_minor: "0", ended_at: null, ended_by_command: null, end_info: null,
    boarded_at: NOW, cash_collected_minor: null, wallet_applied_minor: String(c.wallet), chained: false, next_after_trip_id: null,
    search_step: null, driver_silent_alert: null, duration_seconds: 900, distance_meters: 7000,
    ...change,
  } as unknown as TripRow;
}

function offerRow(c: Case, change: Doc = {}): NonNullable<OfferRow> {
  return {
    offer_id: "ofr_p89", trip_id: "trp_p89", driver_id: "drv_1", kind: "exclusive", status: "open", version: 1, expires_at: NOW,
    currency: c.currency, fare_minor: String(c.fare), driver_earnings_minor: String(c.earnings), pickup_pay_minor: String(c.pickup),
    source: "system", group_id: null, pickup_eta_seconds: 300, pickup_meters: 1200, rider_rating: null, ...change,
  } as unknown as NonNullable<OfferRow>;
}

const m = (amountMinor: number, currency: string) => ({ amountMinor, currency });

describe.each(CURRENCIES)("v0.18.89 §90 price fields ($currency)", (c) => {
  it("Offer.driverTotal = driverEarnings (bonus inside) + pickupPay; cashToCollect = rider fare − wallet (cash); the shape is the contract's", () => {
    const view = offerView(offerRow(c), tripRow(c, { status: "offered", driver_id: null, accepted_at: null }));
    expect(view["driverEarnings"]).toEqual(m(c.earnings + c.bonus, c.currency));
    expect(view["driverTotal"]).toEqual(m(c.earnings + c.bonus + c.pickup, c.currency));
    // The rider's fare is Offer.fare without the Movera bonus.
    expect(view["cashToCollect"]).toEqual(m(c.fare - c.wallet, c.currency));
    expect(schemaProblem("Offer", view)).toBeNull();
  });

  it("Offer without pickup pay: driverTotal = driverEarnings; card / in-app payment: cashToCollect 0", () => {
    const view = offerView(offerRow(c, { pickup_pay_minor: "0" }), tripRow(c, { status: "offered", driver_id: null, payment_method: "card" }));
    expect(view["pickupPay"]).toBeUndefined();
    expect(view["driverTotal"]).toEqual(m(c.earnings + c.bonus, c.currency));
    expect(view["cashToCollect"]).toEqual(m(0, c.currency));
  });

  it("TripProjection.cashToCollect on every pay-in-car trip from accept (driver and admin), also with no wallet part; the rider only when the wallet paid part", () => {
    const row = tripRow(c, { status: "accepted", boarded_at: null, wallet_applied_minor: "0" });
    expect(tripProjection(row, "driver")["cashToCollect"]).toEqual(m(c.fare, c.currency));
    expect(tripProjection(row, "admin")["cashToCollect"]).toEqual(m(c.fare, c.currency));
    expect(tripProjection(row, "rider")["cashToCollect"]).toBeUndefined();
    // The stored (admin) projection on the stream: the same rule per side.
    const stored = tripProjection(row, "admin");
    expect(redactProjection(stored, "driver")["cashToCollect"]).toEqual(m(c.fare, c.currency));
    expect(redactProjection(stored, "rider")["cashToCollect"]).toBeUndefined();
    // Before accept there is no driver and nothing to collect yet.
    expect(tripProjection(tripRow(c, { status: "searching", driver_id: null, accepted_at: null, wallet_applied_minor: "0" }), "admin")["cashToCollect"]).toBeUndefined();
    // Card trips: none (nothing is collected in the car).
    expect(tripProjection(tripRow(c, { payment_method: "card", wallet_applied_minor: "0" }), "driver")["cashToCollect"]).toBeUndefined();
    for (const viewer of ["driver", "admin", "rider"] as const) expect(schemaProblem("TripProjection", tripProjection(row, viewer)), viewer).toBeNull();
  });

  it("TripRouteChange.driverTotal = the change's driverEarnings + pickupPay + driverBonus (driver and admin); never to the rider", () => {
    const newEarnings = c.earnings + 777;
    const change = {
      changeId: "rtc_1", routeQuoteId: "rtq_1", status: "pending", dropoff: PLACE, stops: [], total: m(c.fare + 900, c.currency), difference: m(900, c.currency),
      askedAt: NOW.toISOString(), answerBy: NOW.toISOString(), driverEarnings: m(newEarnings, c.currency), earningsDifference: m(777, c.currency),
    };
    const row = tripRow(c, { route_change: change });
    const want = m(newEarnings + c.pickup + c.bonus, c.currency);
    expect((tripProjection(row, "driver")["routeChange"] as Doc)["driverTotal"]).toEqual(want);
    expect((tripProjection(row, "admin")["routeChange"] as Doc)["driverTotal"]).toEqual(want);
    expect((tripProjection(row, "rider")["routeChange"] as Doc)["driverTotal"]).toBeUndefined();
    const stored = tripProjection(row, "admin");
    expect((redactProjection(stored, "driver")["routeChange"] as Doc)["driverTotal"]).toEqual(want);
    expect((redactProjection(stored, "rider")["routeChange"] as Doc)["driverTotal"]).toBeUndefined();
    for (const viewer of ["driver", "admin", "rider"] as const) expect(schemaProblem("TripProjection", tripProjection(row, viewer)), viewer).toBeNull();
  });

  it("TripFinish.owedToMovera = cash he holds for the trip (fare − wallet on cash, + a cash tip) − finish.driverTotal; never to the rider", () => {
    const tip = { amount: m(c.tip, c.currency), method: "cash", driverShare: m(c.tip, c.currency), at: NOW.toISOString() };
    const ended = { status: "completed", ended_at: NOW, ended_by_command: "complete", payment_status: "captured", ...(c.tip > 0 ? { tip } : {}) };
    const row = tripRow(c, ended);
    const driverTotal = c.earnings + c.pickup + c.bonus + c.tip;
    // Supervisor must-fix (2026-11-14): a cash tip is in his hand (TripTip method cash; the ledger counts it as cash, finish.ts tip credit).
    const cash = c.fare - c.wallet + c.tip;
    for (const viewer of ["driver", "admin"] as const) {
      const finish = tripProjection(row, viewer)["finish"] as Doc;
      expect(finish["driverTotal"]).toEqual(m(driverTotal, c.currency));
      expect(finish["owedToMovera"], viewer).toEqual(m(cash - driverTotal, c.currency));
    }
    expect((tripProjection(row, "rider")["finish"] as Doc)["owedToMovera"]).toBeUndefined();
    const stored = tripProjection(row, "admin");
    expect((redactProjection(stored, "driver")["finish"] as Doc)["owedToMovera"]).toEqual(m(cash - driverTotal, c.currency));
    expect((redactProjection(stored, "rider")["finish"] as Doc)["owedToMovera"]).toBeUndefined();
    // Card: he collected no fare; only a cash tip is in his hand. Movera owes him the rest (a negative balance).
    const card = tripProjection(tripRow(c, { ...ended, payment_method: "card" }), "driver")["finish"] as Doc;
    expect(card["owedToMovera"]).toEqual(m(c.tip - driverTotal, c.currency));
    for (const viewer of ["driver", "admin", "rider"] as const) expect(schemaProblem("TripProjection", tripProjection(row, viewer)), viewer).toBeNull();
  });
});

describe("TripFinish.owedToMovera counts the cash he really holds (supervisor must-fix, 2026-11-14)", () => {
  const done = { status: "completed", ended_at: NOW, ended_by_command: "complete", payment_status: "captured" };
  const owed = (row: TripRow) => ((tripProjection(row, "driver")["finish"] as Doc)["owedToMovera"] as { amountMinor: number }).amountMinor;
  const cashTip = (c: Case, amountMinor: number) => ({ amount: m(amountMinor, c.currency), method: "cash", driverShare: m(amountMinor, c.currency), at: NOW.toISOString() });

  it("SEK cash trip + cash tip 20,00 kr: 162,50 cash + 20,00 tip − 183,60 driverTotal = −1,10 (not −21,10)", () => {
    const c = CURRENCIES[0];
    const row = tripRow(c, { ...done, cash_collected_minor: String(c.fare - c.wallet), tip: cashTip(c, 2000) });
    expect(owed(row)).toBe(16250 + 2000 - 18360);
    expect(owed(row)).toBe(-110);
  });

  it("SEK card trip + cash tip: only the tip is in his hand → tip − driverTotal; an in-app tip is not cash", () => {
    const c = CURRENCIES[0];
    const card = tripRow(c, { ...done, payment_method: "card", cash_collected_minor: String(c.fare - c.wallet), tip: cashTip(c, 2000) });
    expect(owed(card)).toBe(2000 - 18360);
    const inApp = tripRow(c, { ...done, payment_method: "card", tip: { ...cashTip(c, 2000), method: "card" } });
    expect(owed(inApp)).toBe(-18360);
  });

  it("TND short count: cash_collected_minor below fare − wallet → the counted cash (3 decimals)", () => {
    const c = CURRENCIES[2];
    const row = tripRow(c, { ...done, cash_collected_minor: "10000" });
    // fare 12.350 − wallet 1.275 = 11.075 planned; he counted 10.000 DT. driverTotal 9.880 + 1.125 + 0.500 = 11.505.
    expect(owed(row)).toBe(10000 - 11505);
    expect((tripProjection(row, "driver")["finish"] as Doc)["owedToMovera"]).toEqual(m(-1505, "TND"));
  });
});

describe("v0.18.89 contract copy", () => {
  it("the server's contract copy is v0.18.120 (priceDisplay, moneyDisplay.wholeAmounts)", async () => {
    const { contract } = await import("../../src/contract/contract.js");
    const c = contract as unknown as { version: string; priceDisplay?: unknown; moneyDisplay: { wholeAmounts?: unknown } };
    expect(c.version).toBe("0.18.129");
    expect(c.priceDisplay).toBeDefined();
    expect(c.moneyDisplay.wholeAmounts).toBeDefined();
  });
});

describe("v0.18.89 §90: the route-change push says the card's number (driverTotal), in the currency's format", () => {
  // Owner 2026-11-14 (s06:1275 "correct prices every where"; s06:1164 the driver sees only what he gets): push = card.
  it.each([
    ["sv", CURRENCIES[0], "Svara inom 30 s: "],
    ["fr", CURRENCIES[2], "Répondez dans les 30 s : "],
  ] as const)("%s %s", (lang, c, prefix) => {
    const newEarnings = c.earnings + 1000;
    const change = {
      changeId: "rtc_1", routeQuoteId: "rtq_1", status: "pending", dropoff: PLACE, stops: [], total: m(c.fare + 900, c.currency), difference: m(900, c.currency),
      askedAt: NOW.toISOString(), answerBy: NOW.toISOString(), driverEarnings: m(newEarnings, c.currency), earningsDifference: m(1000, c.currency),
    } as RouteChange;
    const row = tripRow(c, { route_change: change });
    const card = (tripProjection(row, "driver")["routeChange"] as Doc)["driverTotal"] as { amountMinor: number };
    expect(card.amountMinor).toBe(newEarnings + c.pickup + c.bonus);
    const want = c.currency === "SEK" ? "173,60 kr" : "12.505 DT";
    expect(routeChangePushText(lang, 30, row, change)).toBe(prefix + want);
  });
});
