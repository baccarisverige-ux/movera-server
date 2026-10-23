import { describe, expect, it } from "vitest";
import { contractJson } from "../../src/contract/contract.js";
import type { Money } from "../../src/rules/money.js";
import {
  pickupPayMinor,
  riderPickupFee,
  type PickupOfferKind,
  type PickupPayRate,
} from "../../src/rules/pickupPay.js";

type PickupPayCase = {
  id: string;
  rate: PickupPayRate;
  offers: Record<string, boolean>;
  offerKind: PickupOfferKind;
  pickupKm: number;
  pickupMinutes: number;
  pay: Money;
};

const fixture = contractJson<{ version: string; cases: PickupPayCase[] }>("fixtures/pickup_pay.json");

/** Every Money in a rate, so a test can check they share one currency. */
function moneysOf(rate: PickupPayRate): Money[] {
  const out: Money[] = [];
  for (const r of rate.ranges) out.push(r.perKm, r.perMin);
  if (rate.maxPerRide) out.push(rate.maxPerRide);
  if (rate.riderFee.live) out.push(rate.riderFee.live);
  if (rate.riderFee.reservation) out.push(rate.riderFee.reservation);
  return out;
}

const clone = <T>(x: T): T => structuredClone(x);
const allOn = { radar: true, exclusive: true, exclusiveReservation: true, assigned: true, nextTrip: true };

function caseById(id: string): PickupPayCase {
  const c = fixture.cases.find((x) => x.id === id);
  if (!c) throw new Error(`pickup_pay.json has no case ${id}`);
  return c;
}

describe("fixtures/pickup_pay.json", () => {
  it("has the 10 cases of contract v0.5.0", () => {
    expect(fixture.version).toBe("0.5.0");
    expect(fixture.cases.length).toBe(10);
  });

  it.each(fixture.cases.map((c) => [c.id, c] as const))("%s", (id, c) => {
    const amountMinor = pickupPayMinor(c.rate, c.offers, c.offerKind, c.pickupKm, c.pickupMinutes);
    expect(amountMinor, `${id}: pay.amountMinor`).toBe(c.pay.amountMinor);

    // The pay is in the rate's currency: every Money in the rate shares one currency, and the fixture's pay uses it.
    const firstRange = c.rate.ranges[0];
    expect(firstRange, `${id}: rate has a first range`).toBeDefined();
    const currency = firstRange!.perKm.currency;
    for (const m of moneysOf(c.rate)) expect(m.currency, `${id}: rate currency`).toBe(currency);
    expect(c.pay.currency, `${id}: pay.currency`).toBe(currency);
  });
});

describe("pickupPayMinor beyond the fixture (expected values from reference_check.py pickup_pay)", () => {
  const base = caseById("tiered_three_ranges");

  it("does not sort ranges: it assumes ascending order and treats the last array entry as open-ended", () => {
    const rate = clone(base.rate);
    rate.maxPerRide = null; // so the cap does not hide the difference
    const [r0, r1, r2] = rate.ranges;
    const shuffled: PickupPayRate = { ...rate, ranges: [r2!, r0!, r1!] };

    // In order: 0 + (2250 + 1029) + (1200 + 571) = 5050, the same as the fixture case.
    expect(pickupPayMinor(rate, allOn, "exclusive", 14, 20), "in order, 14 km").toBe(5050);
    // Out of order the ranges are walked as given: the 1–10 km range comes last, so it is open-ended and also
    // pays 10–14 km, which the 10+ range already paid. reference_check.py gives 6507 too.
    expect(pickupPayMinor(shuffled, allOn, "exclusive", 14, 20), "shuffled, 14 km").toBe(6507);
    // With 0 km all minutes go to the first array entry: the free 0–1 km range when sorted, the 10+ range when not.
    expect(pickupPayMinor(rate, allOn, "exclusive", 0, 20), "in order, 0 km").toBe(0);
    expect(pickupPayMinor(shuffled, allOn, "exclusive", 0, 20), "shuffled, 0 km").toBe(2000);
    // The input is not changed.
    expect(shuffled.ranges.map((r) => r.fromKm), "shuffled ranges untouched").toEqual([10, 0, 1]);
  });

  it("pays a leg beyond a closed last range at the last range's rate", () => {
    const rate = clone(base.rate);
    rate.maxPerRide = null;
    rate.ranges = rate.ranges.slice(0, 2); // 0–1 free, 1–10 closed
    // 13 km × 250 = 3250, 20 min × 13/14 × 80 = 1485.71 → 1486.
    expect(pickupPayMinor(rate, allOn, "radar", 14, 20)).toBe(4736);
  });

  it("takes NaN km as 0, like Python's max(0.0, nan)", () => {
    const rate = clone(base.rate);
    expect(pickupPayMinor(rate, allOn, "radar", Number.NaN, 20)).toBe(0);
  });

  it("pays 0 when the rate has no ranges or the kind is missing from offers", () => {
    expect(pickupPayMinor({ ...clone(base.rate), ranges: [] }, allOn, "radar", 14, 20), "no ranges").toBe(0);
    expect(pickupPayMinor(clone(base.rate), { radar: true }, "assigned", 14, 20), "kind missing").toBe(0);
  });
});

describe("scheduled-list reservations (contract.json#pickupPay.neverPaid)", () => {
  it("are never paid, even with a scheduled switch turned on", () => {
    const base = caseById("tiered_three_ranges");
    expect(pickupPayMinor(base.rate, { ...allOn, scheduled: true }, "scheduled", 14, 20)).toBe(0);
  });
});

describe("riderPickupFee", () => {
  it("returns the live fee for a live ride and the reservation fee for a reservation (null = off)", () => {
    const rate = caseById("tiered_two_ranges").rate;
    expect(riderPickupFee(rate, false)).toEqual({ amountMinor: 1500, currency: "SEK" });
    expect(riderPickupFee(rate, true)).toBeNull();
  });

  it("does not depend on the driver side's enabled switch", () => {
    const rate = caseById("category_off").rate;
    expect(rate.enabled).toBe(false);
    expect(riderPickupFee(rate, false)).toEqual({ amountMinor: 1500, currency: "SEK" });
  });
});
