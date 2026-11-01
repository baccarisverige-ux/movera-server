import { contract } from "../contract/contract.js";

/**
 * v0.18.8 (driver group 6, contract.json#arrivedWaiting.rules; Rules decisions/driver-g6.md): every waiting rule the admin
 * sets (Dispatch › Waiting at pickup) — far pickup, airport, event and scheduled ride with their overrides, and the free
 * wait at each stop. Pure functions, no imports from the trip modules (ride.ts / projection.ts import this file).
 */

export type Money = { amountMinor: number; currency: string };
export type CategoryWaiting = { freeWaitMin: number; perMin: Money; noShowAfterMin: number; noShowFee: Money };
export type WaitingRuleId = "airport" | "scheduled" | "event" | "far_pickup";
export type RuleOverride = { on: boolean; freeWaitMin: number | null; perMin: Money | null; noShowAfterMin: number | null; noShowFee: Money | null };
export type WaitingExtras = {
  farPickup: RuleOverride & { km: number };
  rideTypes: { scheduled: RuleOverride; airport: RuleOverride; event: RuleOverride & { radiusMeters: number; afterEndMin: number } };
  stopFreeWaitMin: number;
};
export type EffectiveWaiting = CategoryWaiting & { rules: WaitingRuleId[] };

type Defaults = {
  farPickup: Omit<RuleOverride, "noShowFee"> & { km: number; noShowFee: Record<string, number> | null };
  scheduled: RuleOverride;
  airport: RuleOverride;
  event: RuleOverride & { radiusMeters: number; afterEndMin: number };
  stopFreeWaitMin: number;
};
const AW = (contract as unknown as { arrivedWaiting: { rules: { defaults: Defaults } } }).arrivedWaiting;
export const WAITING_DEFAULTS = AW.rules.defaults;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const minutes = (v: unknown, fallback: number | null): number | null => (v === null ? null : typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 240 ? v : fallback);
const moneyIn = (v: unknown, currency: string): Money | null =>
  isObj(v) && typeof v["amountMinor"] === "number" && Number.isInteger(v["amountMinor"]) && v["amountMinor"] >= 0 && v["currency"] === currency ? { amountMinor: v["amountMinor"], currency } : null;

function override(stored: unknown, fallback: RuleOverride, currency: string): RuleOverride {
  const s = isObj(stored) ? stored : {};
  const money = (key: "perMin" | "noShowFee") => (key in s ? (s[key] === null ? null : moneyIn(s[key], currency)) : fallback[key]);
  return {
    on: typeof s["on"] === "boolean" ? s["on"] : fallback.on,
    freeWaitMin: "freeWaitMin" in s ? minutes(s["freeWaitMin"], fallback.freeWaitMin) : fallback.freeWaitMin,
    perMin: money("perMin"),
    noShowAfterMin: "noShowAfterMin" in s ? minutes(s["noShowAfterMin"], fallback.noShowAfterMin) : fallback.noShowAfterMin,
    noShowFee: money("noShowFee"),
  };
}

/**
 * The zone's rules from its live driver document (DriverAppConfig.waiting), with the admin panel's defaults for a missing
 * field (contract.json#arrivedWaiting.rules.defaults). Money in another currency than the zone's is ignored.
 */
export function waitingExtrasOf(waiting: unknown, currency: string): WaitingExtras {
  const w = isObj(waiting) ? waiting : {};
  const d = WAITING_DEFAULTS;
  const farFee = d.farPickup.noShowFee?.[currency];
  const farDefault: RuleOverride = { on: d.farPickup.on, freeWaitMin: d.farPickup.freeWaitMin, perMin: null, noShowAfterMin: d.farPickup.noShowAfterMin, noShowFee: farFee !== undefined ? { amountMinor: farFee, currency } : null };
  const far = isObj(w["farPickup"]) ? w["farPickup"] : {};
  const types = isObj(w["rideTypes"]) ? w["rideTypes"] : {};
  const event = isObj(types["event"]) ? types["event"] : {};
  const km = typeof far["km"] === "number" && far["km"] >= 0 ? far["km"] : d.farPickup.km;
  return {
    farPickup: { ...override(far, farDefault, currency), km },
    rideTypes: {
      scheduled: override(types["scheduled"], d.scheduled, currency),
      airport: override(types["airport"], d.airport, currency),
      event: {
        ...override(event, d.event, currency),
        radiusMeters: typeof event["radiusMeters"] === "number" && event["radiusMeters"] >= 0 ? event["radiusMeters"] : d.event.radiusMeters,
        afterEndMin: typeof event["afterEndMin"] === "number" && event["afterEndMin"] >= 0 ? event["afterEndMin"] : d.event.afterEndMin,
      },
    },
    stopFreeWaitMin: minutes(w["stopFreeWaitMin"], d.stopFreeWaitMin) ?? 0,
  };
}

export type WaitingContext = { kind: string; pickupInAirportZone: boolean; inEvent: boolean; acceptPickupMeters: number | null };

/**
 * contract.json#arrivedWaiting.rules.order: one ride type (airport, else scheduled, else event), then far pickup on top; a
 * later rule wins where it sets a value; a rule that sets the free wait without a no-show time moves the no-show time with
 * it (owner decision 5); the no-show time is never before the end of the free wait.
 */
export function effectiveWaiting(base: CategoryWaiting, extras: WaitingExtras | null, ctx: WaitingContext): EffectiveWaiting {
  const eff: EffectiveWaiting = { freeWaitMin: base.freeWaitMin, perMin: base.perMin, noShowAfterMin: base.noShowAfterMin, noShowFee: base.noShowFee, rules: [] };
  if (extras) {
    const apply = (rule: RuleOverride, id: WaitingRuleId) => {
      eff.rules.push(id);
      if (rule.freeWaitMin !== null) eff.freeWaitMin = rule.freeWaitMin;
      if (rule.noShowAfterMin !== null) eff.noShowAfterMin = rule.noShowAfterMin;
      else if (rule.freeWaitMin !== null) eff.noShowAfterMin = rule.freeWaitMin;
      if (rule.perMin !== null && rule.perMin.currency === base.perMin.currency) eff.perMin = rule.perMin;
      if (rule.noShowFee !== null && rule.noShowFee.currency === base.noShowFee.currency) eff.noShowFee = rule.noShowFee;
    };
    const t = extras.rideTypes;
    const type: WaitingRuleId | null =
      ctx.pickupInAirportZone && t.airport.on ? "airport" : ctx.kind === "scheduled" && t.scheduled.on ? "scheduled" : ctx.inEvent && t.event.on ? "event" : null;
    if (type !== null) apply(t[type as "airport" | "scheduled" | "event"], type);
    const far = extras.farPickup;
    if (far.on && ctx.kind === "live" && ctx.acceptPickupMeters !== null && ctx.acceptPickupMeters > far.km * 1000) apply(far, "far_pickup");
  }
  eff.noShowAfterMin = Math.max(eff.noShowAfterMin, eff.freeWaitMin);
  return eff;
}

/** contract.json#arrivedWaiting.rules.stops: seconds charged at one stop after its free minutes. */
export const chargedStopSeconds = (waited: number, stopFreeWaitMin: number) => Math.max(0, waited - Math.round(stopFreeWaitMin * 60));
