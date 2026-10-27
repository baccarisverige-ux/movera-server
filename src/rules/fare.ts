import { contract } from "../contract/contract.js";
import { Frac } from "./fraction.js";

/**
 * The fare (contract v0.5.1 §3.5, contract.json#pricing): the admin panel's calculator order with the owner's rules
 * (decisions 5, 8, 16–21). Every amount is exact until it becomes a fare line; the total is rounded once to the
 * price step. Checked case by case against fixtures/fares.json.
 */

type MoneyJson = { amountMinor: number; currency: string };

export type CategoryPricing = {
  enabled: boolean;
  base: MoneyJson;
  perKm: MoneyJson;
  perMin: MoneyJson;
  minimum: MoneyJson;
  maximum: MoneyJson | null;
  appFeePct: number;
  commissionPct: number;
  extraStopFee: MoneyJson;
  stopWaitPerMin: MoneyJson;
  /** v0.6.0: only on child_seat (owner 2026-10-27); a category without it adds nothing for a seat (as quoteRide). */
  babySeatFee?: MoneyJson;
  childSeatFee?: MoneyJson;
  waiting: { freeWaitMin: number; perMin: MoneyJson; noShowAfterMin: number; noShowFee: MoneyJson };
  riderPickupFee: { live: MoneyJson | null; reservation: MoneyJson | null };
};

export type PricingDocument = {
  zoneId: string;
  currency: string;
  priceStep: MoneyJson;
  stopFreeWaitMin: number;
  categories: Record<string, CategoryPricing>;
  fees: { airportPickup: MoneyJson; airportDropoff: MoneyJson; reservationFee: MoneyJson };
  fixedRoutes: Array<{ id: string; categoryId: string; price: MoneyJson }>;
  surge: { maxMultiplier: number };
};

export type FareInput = {
  categoryId: string;
  /** The priced route. */
  km: number;
  minutes: number;
  kind: "live" | "scheduled";
  fixedRouteId?: string;
  surgeMultiplier?: number;
  /** Waiting.chargedSeconds: pickup waiting after the free minutes. */
  waitingChargedSeconds?: number;
  /** Seconds waited at each extra stop, one entry per stop. */
  stopWaitSeconds?: number[];
  babySeats?: number;
  childSeats?: number;
  airportPickup?: boolean;
  airportDropoff?: boolean;
  outstandingFee?: MoneyJson | null;
  /** The trip whose unpaid fee this is (FareLine.sourceTripId, §3.7). */
  outstandingSourceTripId?: string;
  endEarly?: { kmDriven: number; minutesOnBoard: number; bookedFare: MoneyJson };
};

export type FareLine = { code: string; amount: MoneyJson; sourceTripId?: string };
export type Fare = { total: MoneyJson; fareLines: FareLine[]; driverEarnings: MoneyJson; moveraShare: MoneyJson; surgeMultiplier: number };

const CONTRACT_MAX_SURGE = Frac.dec((contract as unknown as { pricing: { maxMultiplier: number } }).pricing.maxMultiplier);

export class FareError extends Error {}

export function priceFare(doc: PricingDocument, input: FareInput): Fare {
  const cat = doc.categories[input.categoryId];
  if (cat === undefined) throw new FareError(`No price for category ${input.categoryId} in zone ${doc.zoneId}`);
  if (!cat.enabled) throw new FareError(`Category ${input.categoryId} is switched off in zone ${doc.zoneId}`);
  const currency = doc.currency;
  const amt = (m: MoneyJson) => {
    if (m.currency !== currency) throw new FareError(`Money in ${m.currency} in a ${currency} zone`);
    return Frac.of(m.amountMinor);
  };
  const seatPart = (count: number | undefined, fee: MoneyJson | undefined) => (count && fee ? Frac.of(count).mul(amt(fee)) : Frac.ZERO);
  const lines: Array<[string, Frac]> = [];
  const add = (code: string, value: Frac, keep = false) => {
    if (!value.isZero() || keep) lines.push([code, value]);
  };

  const ee = input.endEarly;
  const km = Frac.dec(ee ? ee.kmDriven : input.km);
  const minutes = Frac.dec(ee ? ee.minutesOnBoard : input.minutes);
  const route = ee ? undefined : doc.fixedRoutes.find((r) => r.id === input.fixedRouteId && r.categoryId === input.categoryId);

  let ride: Frac;
  let multiplier = Frac.ONE;
  if (route) {
    ride = amt(route.price);
    add("fixed_route", ride, true);
  } else {
    const parts: Array<[string, Frac]> = [
      ["base", amt(cat.base)],
      ["distance", amt(cat.perKm).mul(km)],
      ["time", amt(cat.perMin).mul(minutes)],
    ];
    for (const [code, value] of parts) add(code, value, true);
    ride = parts.reduce((sum, [, v]) => sum.add(v), Frac.ZERO);
    const cap = Frac.min(Frac.dec(doc.surge.maxMultiplier), CONTRACT_MAX_SURGE);
    multiplier = Frac.min(Frac.max(Frac.dec(input.surgeMultiplier ?? 1), Frac.ONE), cap);
    if (multiplier.cmp(Frac.ONE) > 0) {
      add("surge", ride.mul(multiplier.sub(Frac.ONE)));
      ride = ride.mul(multiplier);
    }
    const minimum = amt(cat.minimum);
    if (ride.cmp(minimum) < 0) {
      add("minimum_adjust", minimum.sub(ride));
      ride = minimum;
    }
    if (cat.maximum !== null && ride.cmp(amt(cat.maximum)) > 0) {
      add("maximum_adjust", amt(cat.maximum).sub(ride));
      ride = amt(cat.maximum);
    }
  }

  const pct = Frac.dec(cat.appFeePct).div(Frac.of(100));
  const feeMoney = input.kind === "scheduled" ? cat.riderPickupFee.reservation : cat.riderPickupFee.live;
  const fee = feeMoney ? amt(feeMoney) : Frac.ZERO;
  let extras = Frac.ZERO;
  let waiting = Frac.ZERO;
  let waitLines = 0n;

  if (ee) {
    // Never above the booked fare: lower the ride part so ride + app fee + pickup fee is exactly the booked fare.
    const cap = amt(ee.bookedFare).sub(fee).div(Frac.ONE.add(pct));
    if (ride.cmp(cap) > 0) {
      add("maximum_adjust", cap.sub(ride));
      ride = cap;
    }
  } else {
    const free = doc.stopFreeWaitMin * 60;
    const stops = input.stopWaitSeconds ?? [];
    const w = Frac.of(input.waitingChargedSeconds ?? 0).div(Frac.of(60)).mul(amt(cat.waiting.perMin));
    const sw = Frac.of(stops.reduce((sum, s) => sum + Math.max(0, s - free), 0)).div(Frac.of(60)).mul(amt(cat.stopWaitPerMin));
    const extraLines: Array<[string, Frac]> = [
      ["waiting", w],
      ["stops", Frac.of(stops.length).mul(amt(cat.extraStopFee))],
      ["stop_waiting", sw],
      ["extras", seatPart(input.babySeats, cat.babySeatFee).add(seatPart(input.childSeats, cat.childSeatFee))],
      ["airport", (input.airportPickup ? amt(doc.fees.airportPickup) : Frac.ZERO).add(input.airportDropoff ? amt(doc.fees.airportDropoff) : Frac.ZERO)],
      ["reservation_fee", input.kind === "scheduled" ? amt(doc.fees.reservationFee) : Frac.ZERO],
    ];
    for (const [code, value] of extraLines) {
      if (value.cmp(Frac.ZERO) > 0) {
        add(code, value);
        extras = extras.add(value);
      }
    }
    waiting = w.add(sw);
    waitLines = w.halfUp() + sw.halfUp();
  }

  const before = ride.add(extras);
  const appFee = before.mul(pct);
  add("app_fee", appFee);
  add("pickup_fee", fee);
  const step = amt(doc.priceStep);
  let total = before.add(appFee).add(fee).div(step).halfUp() * step.n;
  const out: Array<{ code: string; amount: bigint; sourceTripId?: string }> = lines.map(([code, value]) => ({ code, amount: value.halfUp() }));
  const sum = out.reduce((s, l) => s + l.amount, 0n);
  if (total !== sum) out.push({ code: "rounding", amount: total - sum });
  const commission = Frac.ONE.sub(Frac.dec(cat.commissionPct).div(Frac.of(100)));
  const driverRaw = before.sub(waiting).mul(commission).halfUp() + waitLines;
  const driver = driverRaw < total ? driverRaw : total;
  if (input.outstandingFee && input.outstandingFee.amountMinor !== 0) {
    out.push({ code: "outstanding_fee", amount: amt(input.outstandingFee).n, ...(input.outstandingSourceTripId ? { sourceTripId: input.outstandingSourceTripId } : {}) });
    total += amt(input.outstandingFee).n;
  }
  const money = (v: bigint): MoneyJson => ({ amountMinor: Number(v), currency });
  return {
    total: money(total),
    fareLines: out.map((l) => ({ code: l.code, amount: money(l.amount), ...(l.sourceTripId ? { sourceTripId: l.sourceTripId } : {}) })),
    driverEarnings: money(driver),
    moveraShare: money(total - driver),
    surgeMultiplier: Number(multiplier.n) / Number(multiplier.d),
  };
}
