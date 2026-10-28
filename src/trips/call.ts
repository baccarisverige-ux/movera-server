import type { Executor } from "../db/db.js";
import { ApiError } from "../http/errors.js";
import type { TelephonyProvider } from "../telephony/provider.js";
import { readOwnTrip } from "./commands.js";
import { chatOpen } from "./messages.js";
import { tripProjection } from "./projection.js";

/**
 * POST /trips/{tripId}/call → 200 TripCall { tripId, proxyNumber, expiresAt } (contract v0.13.0 §22): the trip's
 * rider or driver calls the other side through a masked number while the chat is open. Neither real number leaves
 * the server; without a telephony provider the answer is 503 unavailable, reason call_unavailable.
 */
export async function callTripPeer(ex: Executor, who: { actor: "rider" | "driver"; subjectId: string }, tripId: string, telephony: TelephonyProvider, now: Date) {
  const trip = await readOwnTrip(ex, tripId, who);
  if (!chatOpen(trip, who.actor) || trip.driver_id === null) {
    throw new ApiError("invalid_transition", "Calls are open while a driver is on the trip; they close at drop-off.", { reason: "chat_closed", projection: tripProjection(trip, who.actor) });
  }
  if (telephony.name === "disabled") throw callUnavailable();
  const rider = await ex.selectFrom("riders").select("phone").where("rider_id", "=", trip.rider_id).executeTakeFirst();
  const driver = await ex.selectFrom("drivers").select("phone").where("driver_id", "=", trip.driver_id).executeTakeFirst();
  if (!rider?.phone || !driver?.phone) throw callUnavailable();
  const sides = { rider: { actor: "rider" as const, phone: rider.phone }, driver: { actor: "driver" as const, phone: driver.phone } };
  const call = await telephony.maskedCall({ tripId, caller: sides[who.actor], callee: sides[who.actor === "rider" ? "driver" : "rider"], now });
  if (call === null) throw callUnavailable();
  return { tripId, proxyNumber: call.proxyNumber, expiresAt: call.expiresAt.toISOString() };
}

const callUnavailable = () => new ApiError("unavailable", "Calls are not available; write in the chat instead.", { reason: "call_unavailable" });
