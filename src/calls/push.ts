import { contract } from "../contract/contract.js";
import { languageOf, type Texts } from "../chat/settings.js";
import type { Trx } from "../db/db.js";
import type { TripRow } from "../db/tripLog.js";
import { notify } from "../notifications/service.js";
import { PRESENCE_STALE_MS } from "../realtime/streams.js";

/**
 * v0.18.56 §78 (contract.json#inAppCalls.push, owner Q79 and A2): on call_ringing, a push to the callee's devices
 * when the callee has no open trip stream. Push only (never in GET /notifications), sent even with
 * Rider.consents.rideUpdates false (src/notifications/tripPush.ts riderPushAlwaysSent), and only while the call still
 * rings (pushUntil = the ring end; the dispatcher also checks the call row).
 */
export const CALL_PUSH_KIND = "call_ringing";
type PushSpec = { texts: { fromDriver: Texts; fromRider: Texts } };
const SPEC = (contract as unknown as { inAppCalls: { push: PushSpec } }).inAppCalls.push;
const DEEP_LINK = { rider: "movera://trips/{tripId}/call", driver: "movera-driver://trips/{tripId}/call" } as const;

export async function pushIncomingCall(trx: Trx, trip: TripRow, callId: string, callee: "rider" | "driver", ringSeconds: number, now: Date): Promise<boolean> {
  const subjectId = callee === "rider" ? trip.rider_id : trip.driver_id;
  if (subjectId === null) return false;
  const open = await trx.selectFrom("trip_stream_presence").select("stream_id")
    .where("trip_id", "=", trip.trip_id).where("actor", "=", callee).where("subject_id", "=", subjectId)
    .where("seen_at", ">", new Date(now.getTime() - PRESENCE_STALE_MS)).executeTakeFirst();
  if (open) return false;
  const texts = callee === "rider" ? SPEC.texts.fromDriver : SPEC.texts.fromRider;
  const lang = await languageOf(trx, { actor: callee, subjectId }, trip.zone_id);
  await notify(trx, {
    audience: callee, subjectId, kind: CALL_PUSH_KIND, title: "Movera", body: texts[lang],
    deepLink: DEEP_LINK[callee].replace("{tripId}", trip.trip_id), tripId: trip.trip_id,
    data: { tripId: trip.trip_id, callId }, bell: false, pushUntil: new Date(now.getTime() + ringSeconds * 1000),
  }, now);
  return true;
}
