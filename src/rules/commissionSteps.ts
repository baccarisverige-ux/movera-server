import { contract } from "../contract/contract.js";
import { Frac } from "./fraction.js";

/**
 * J5b commission steps (contract v0.18.86, contract.json#commissionSteps; owner 2026-11-13 ~20:48 UTC "Yes, like this
 * (Rec.)"): per zone and car type, steps "trip price up to X" (the last = "above"), each EITHER a % OR a fixed amount,
 * picked by the exact commission base (ride part + extras − waiting − stop waiting). No steps (absent, null or []) =
 * commissionPct exactly as before. Checked case by case against fixtures/commission_steps.json.
 */

export type CommissionStep = { upToMinor: number | null; pct?: number; amountMinor?: number };

type Validation = { maxSteps: number; pctMin: number; pctMax: number; problems: Record<string, string> };
const V = (contract as unknown as { commissionSteps: { validation: Validation } }).commissionSteps.validation;

export type StepProblemCode =
  | "not_a_list"
  | "too_many_steps"
  | "pct_or_amount"
  | "up_to_missing"
  | "pct_out_of_range"
  | "amount_out_of_range"
  | "above_not_last"
  | "last_not_above"
  | "up_to_out_of_range"
  | "up_to_not_increasing";

export type StepProblem = { step: number | null; problem: StepProblemCode };

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isWhole = (v: unknown): v is number => isNumber(v) && Number.isInteger(v);

/**
 * contract.json#commissionSteps.validation: null when the admin's steps are valid, else the first problem (in step
 * order, then in the order of the problems), exactly as reference_check.py steps_problem.
 */
export function commissionStepsProblem(steps: unknown): StepProblem | null {
  if (steps === null || steps === undefined) return null; // null (and absent) = no steps
  if (!Array.isArray(steps)) return { step: null, problem: "not_a_list" };
  if (steps.length > V.maxSteps) return { step: null, problem: "too_many_steps" };
  let prev: number | null = null;
  for (let k = 0; k < steps.length; k++) {
    const st: unknown = steps[k];
    if (st === null || typeof st !== "object" || Array.isArray(st) || ("pct" in st) === ("amountMinor" in st)) return { step: k, problem: "pct_or_amount" };
    const s = st as Record<string, unknown>;
    if (!("upToMinor" in s)) return { step: k, problem: "up_to_missing" };
    const last = k === steps.length - 1;
    const up = s["upToMinor"];
    if ("pct" in s && (!isNumber(s["pct"]) || s["pct"] < V.pctMin || s["pct"] > V.pctMax)) return { step: k, problem: "pct_out_of_range" };
    if ("amountMinor" in s && (!isWhole(s["amountMinor"]) || s["amountMinor"] < 0)) return { step: k, problem: "amount_out_of_range" };
    if (up === null && !last) return { step: k, problem: "above_not_last" };
    if (up !== null && last) return { step: k, problem: "last_not_above" };
    if (up !== null && (!isWhole(up) || up <= 0)) return { step: k, problem: "up_to_out_of_range" };
    if (up !== null && prev !== null && (up as number) <= prev) return { step: k, problem: "up_to_not_increasing" };
    prev = up as number | null;
  }
  return null;
}

/**
 * The first problem of any category's steps in a pricing document (contract.json#commissionSteps.validation.rule), or
 * null. Reads the document defensively: it runs before the schema check, so a malformed document is left to the schema.
 */
export function pricingStepsProblem(document: unknown): (StepProblem & { categoryId: string }) | null {
  if (document === null || typeof document !== "object") return null;
  const categories = (document as { categories?: unknown }).categories;
  if (categories === null || typeof categories !== "object" || Array.isArray(categories)) return null;
  for (const [categoryId, category] of Object.entries(categories as Record<string, unknown>)) {
    if (category === null || typeof category !== "object" || !("commissionSteps" in category)) continue;
    const problem = commissionStepsProblem((category as { commissionSteps: unknown }).commissionSteps);
    if (problem !== null) return { ...problem, categoryId };
  }
  return null;
}

/** contract.json#commissionSteps.pick: the first step whose upToMinor is null ("above") or ≥ the exact base ("up to" includes X). */
export function pickStep(base: Frac, steps: readonly CommissionStep[] | null | undefined): number | null {
  const list = steps ?? [];
  for (let k = 0; k < list.length; k++) {
    const up = list[k]!.upToMinor;
    if (up === null || base.cmp(Frac.of(up)) <= 0) return k;
  }
  return null;
}

/**
 * The driver's part of the commission base, half_up to a whole minor unit (TND millimes, SEK öre, EUR cents), never
 * below 0. No steps = commissionPct (unchanged); a % step = half_up(base × (1 − pct / 100)); a fixed step =
 * half_up(base − min(amountMinor, base)): a fixed commission is never above the base (owner 2026-11-14 ~03:40 UTC: a
 * silent code guard only; the minimum trip price makes it unreachable in practice).
 */
export function driverRidePart(base: Frac, cat: { commissionPct: number; commissionSteps?: readonly CommissionStep[] | null }): { step: number | null; driverRidePart: bigint } {
  const steps = cat.commissionSteps ?? [];
  const k = pickStep(base, steps);
  const keep = (v: bigint) => (v < 0n ? 0n : v);
  const ofPct = (pct: number) => keep(base.mul(Frac.ONE.sub(Frac.dec(pct).div(Frac.of(100)))).halfUp());
  if (k === null) return { step: null, driverRidePart: ofPct(cat.commissionPct) };
  const st = steps[k]!;
  if (st.pct !== undefined) return { step: k, driverRidePart: ofPct(st.pct) };
  const fixed = Frac.min(Frac.of(st.amountMinor ?? 0), Frac.max(base, Frac.ZERO));
  return { step: k, driverRidePart: keep(base.sub(fixed).halfUp()) };
}
