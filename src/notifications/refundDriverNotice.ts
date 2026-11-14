import type { Executor } from "../db/db.js";
import type { Money } from "../rules/money.js";
import { moneyShown } from "../rules/money.js";
import { noticeLanguage, type Lang } from "./noticeLanguage.js";
import { notify } from "./service.js";

/**
 * v0.18.91 job A7 (contract.json#finish.refund.driverNotice; owner 2026-11-02 "taken from the driver's NEXT payout (driver
 * sees why)", Rules decisions/driver-g8.md:95-98, kept by Q-M4): when an admin refund is taken from the driver, he gets a
 * bell notice + push saying how much (his share, moneyDisplay with decimals) and why (the admin's reason). The texts are the
 * contract's, word for word (the server's contract copy is older than 0.18.91).
 */
export const DRIVER_REFUND_NOTICE = {
  kind: "driver_refund_taken",
  deepLink: "movera-driver://trips/{tripId}",
  title: { sv: "Avdrag från din utbetalning", fr: "Retenue sur votre versement", en: "Deduction from your payout" },
  body: {
    sv: "{amount} dras från din nästa utbetalning: resenären fick pengar tillbaka för resan. Orsak: {reason}",
    fr: "{amount} sera retenu sur votre prochain versement : le passager a été remboursé pour la course. Motif : {reason}",
    en: "{amount} is taken from your next payout: the rider got money back for the trip. Reason: {reason}",
  },
} as const;

const REASON_MAX = 200;

/** The notice's title and body in `lang`; the reason trimmed and cut at 200 characters with "…". */
export function driverRefundText(lang: Lang, share: Money, reason: string): { title: string; body: string } {
  const trimmed = reason.trim();
  const why = trimmed.length > REASON_MAX ? `${trimmed.slice(0, REASON_MAX)}…` : trimmed;
  const body = DRIVER_REFUND_NOTICE.body[lang].replace("{amount}", moneyShown(share)).replace("{reason}", why);
  return { title: DRIVER_REFUND_NOTICE.title[lang], body };
}

/** Writes the driver's notice (bell + push, his language) for a refund share taken from him. */
export async function noticeDriverRefund(ex: Executor, trip: { trip_id: string; zone_id: string; driver_id: string }, share: Money, refundId: string, reason: string, now: Date): Promise<void> {
  const lang = await noticeLanguage(ex, { actor: "driver", id: trip.driver_id }, trip.zone_id);
  const text = driverRefundText(lang, share, reason);
  await notify(ex, { audience: "driver", subjectId: trip.driver_id, kind: DRIVER_REFUND_NOTICE.kind, ...text, deepLink: DRIVER_REFUND_NOTICE.deepLink.replace("{tripId}", trip.trip_id), tripId: trip.trip_id, data: { tripId: trip.trip_id, refundId, amount: share, reason: reason.trim() } }, now);
}
