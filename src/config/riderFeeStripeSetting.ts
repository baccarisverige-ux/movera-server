import { badRequest } from "../http/errors.js";

/** v0.18.136 (contract.json#stripeFees.setting). A leaf module so config/service.ts can import it. */
/** Save check of CountryRules.riderFeeStripe (config/service.ts checkDocument). */
export function checkRiderFeeStripeSetting(document: unknown): void {
  const set = (document as { riderFeeStripe?: unknown } | null)?.riderFeeStripe;
  if (set === undefined) return;
  const ok = typeof set === "object" && set !== null && !Array.isArray(set) && typeof (set as Record<string, unknown>)["enabled"] === "boolean" && Object.keys(set).every((k) => k === "enabled");
  if (!ok) throw badRequest("The Stripe rider fee setting needs its on / off switch only.", "rider_fee_stripe_invalid");
}
