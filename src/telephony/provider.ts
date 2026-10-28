/**
 * Number masking for rider ↔ driver calls (contract v0.13.0 §22, contract.json#chat.call; owner 2026-10-28: the
 * rider and the driver never see each other's real number). A provider hands out a proxy number that bridges the
 * two sides. The owner has not picked a telephony provider yet, so the only provider here is `disabled`: every call
 * is 503 unavailable, reason call_unavailable. A real provider reads its keys from the environment, never from git.
 */

export type MaskedCallRequest = { tripId: string; caller: { actor: "rider" | "driver"; phone: string }; callee: { actor: "rider" | "driver"; phone: string }; now: Date };
export type MaskedCall = { proxyNumber: string; expiresAt: Date };

export interface TelephonyProvider {
  readonly name: string;
  /** A proxy number for this pair, or null when the provider cannot give one now. */
  maskedCall(request: MaskedCallRequest): Promise<MaskedCall | null>;
}

export const disabledTelephony: TelephonyProvider = {
  name: "disabled",
  maskedCall: () => Promise.resolve(null),
};
