import { assertCallAllowed, startInAppCall } from "../calls/service.js";
import { callSettingsFor } from "../calls/settings.js";
import type { Trx } from "../db/db.js";
import type { TelephonyProvider } from "../telephony/provider.js";
import { lockOwnTrip } from "./commands.js";

/**
 * POST /trips/{tripId}/call → 200 TripCall. v0.18.38 §62 (contract.json#inAppCalls; owner G15 2026-11-05 "In-app calls
 * only"): mode in_app by default — the server opens a call row and relays the WebRTC signalling (src/calls). Mode phone
 * (v0.13.0 masked number) only when CountryRules.calls.mode is phone AND a telephony provider is configured; a provider
 * that gives no number falls back to in-app. The window runs from driver assignment until callWindowAfterTripMin after
 * drop-off (409 call_window_closed); calls.on false is 403 calls_off. Neither real number ever leaves the server.
 */
export async function callTripPeer(trx: Trx, who: { actor: "rider" | "driver"; subjectId: string }, tripId: string, telephony: TelephonyProvider, now: Date) {
  const trip = await lockOwnTrip(trx, tripId, who);
  const settings = await callSettingsFor(trx, trip.zone_id);
  assertCallAllowed(trip, who, settings, now);
  if (settings.mode === "phone" && telephony.name !== "disabled" && trip.driver_id !== null) {
    const rider = await trx.selectFrom("riders").select("phone").where("rider_id", "=", trip.rider_id).executeTakeFirst();
    const driver = await trx.selectFrom("drivers").select("phone").where("driver_id", "=", trip.driver_id).executeTakeFirst();
    if (rider?.phone && driver?.phone) {
      const sides = { rider: { actor: "rider" as const, phone: rider.phone }, driver: { actor: "driver" as const, phone: driver.phone } };
      const masked = await telephony.maskedCall({ tripId, caller: sides[who.actor], callee: sides[who.actor === "rider" ? "driver" : "rider"], now });
      if (masked !== null) return { tripId, mode: "phone" as const, proxyNumber: masked.proxyNumber, expiresAt: masked.expiresAt.toISOString() };
    }
  }
  return startInAppCall(trx, trip, who, settings, now);
}
