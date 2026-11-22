/**
 * Contract v0.18.136 stripeFees.keys + stripeFees.status (DRAFT; live mode, owner 2026-11-21 "Yes, build live mode now
 * (Recommended)"). A leaf module (env.ts imports it): the server's Stripe mode from its env, never a key in the answer.
 */
export type StripeMode = "test" | "live";
export type StripeOffReason = "no_keys" | "keys_incomplete" | "mixed_keys" | "bad_webhook_secret" | "test_keys_in_production" | "live_keys_outside_production";
/** contract.json#stripeFees.status: StripeStatus. Never a key or any part of one. */
export type StripeKeyStatus = { mode: StripeMode } | { mode: "off"; reason: StripeOffReason };
export type StripeEnv = { MOVERA_ENV?: "development" | "staging" | "production" | undefined; STRIPE_SECRET_KEY?: string | undefined; STRIPE_PUBLISHABLE_KEY?: string | undefined; STRIPE_WEBHOOK_SECRET?: string | undefined };

const keyMode = (key: string, kind: "sk" | "pk"): StripeMode | null => (key.startsWith(`${kind}_test_`) ? "test" : key.startsWith(`${kind}_live_`) ? "live" : null);

/** contract.json#stripeFees.keys: the server's Stripe mode from its env (MOVERA_ENV missing = production, as env.ts). */
export function stripeKeyStatus(env: StripeEnv): StripeKeyStatus {
  const secret = env.STRIPE_SECRET_KEY ?? "", publishable = env.STRIPE_PUBLISHABLE_KEY ?? "", hook = env.STRIPE_WEBHOOK_SECRET ?? "";
  const off = (reason: StripeOffReason): StripeKeyStatus => ({ mode: "off", reason });
  if (!secret && !publishable && !hook) return off("no_keys");
  if (!secret || !publishable || !hook) return off("keys_incomplete");
  const mode = keyMode(secret, "sk");
  if (mode === null || keyMode(publishable, "pk") !== mode) return off("mixed_keys");
  if (!hook.startsWith("whsec_") || hook.length <= "whsec_".length) return off("bad_webhook_secret");
  const production = (env.MOVERA_ENV ?? "production") === "production";
  if (production && mode === "test") return off("test_keys_in_production");
  if (!production && mode === "live") return off("live_keys_outside_production");
  return { mode };
}

/**
 * What this server copy started with (buildApp sets it), for the admin status and the system_health alert of the
 * sweep, which runs in the same process. Unset (a tool, a test without buildApp) = no_keys: no alert.
 */
let serverStatus: StripeKeyStatus = { mode: "off", reason: "no_keys" };
export function setServerStripeStatus(status: StripeKeyStatus): void {
  serverStatus = status;
}
export const serverStripeStatus = (): StripeKeyStatus => serverStatus;
