import { contract } from "../contract/contract.js";
import type { Executor } from "../db/db.js";
import { notify } from "../notifications/service.js";

/**
 * v0.18.53 §75 (owner Q39 2026-11-09, contract.json#support.answerPush): an admin's answer on a ticket (POST
 * /admin/tickets/{ticketId}/reply, and the trip tools' case opened visible to the person) pushes the ticket's owner at
 * once — kind support_reply, bell true, deep link per audience, data { ticketId, texts }, in the person's language
 * (else the ticket zone country's, else English). A service message: the push dispatcher never stops it for
 * Rider.consents.rideUpdates false. Never for the person's own message, nor for an admin-opened case the person
 * cannot see (visible_to_person false).
 */

type Lang = "sv" | "fr" | "en";
type Texts = Record<Lang, string>;
type Spec = { kind: string; deepLink: { rider: string; driver: string }; texts: { title: Texts; body: Texts } };

export const SUPPORT_ANSWER_PUSH: Spec = (contract as unknown as { support: { answerPush: Spec } }).support.answerPush;
const COUNTRY_LANGUAGE: Record<string, Lang> = { SE: "sv", FR: "fr", TN: "fr" };
const isLang = (value: unknown): value is Lang => value === "sv" || value === "fr" || value === "en";

type Ticket = { ticket_id: string; opened_by: "rider" | "driver" | "admin"; visible_to_person?: boolean | null; rider_id: string | null; driver_id: string | null; zone_id: string | null; country?: string | null };

/** Writes the notice inside the command's transaction (the dispatcher sends it after commit). Returns the notice id, or null when nobody is told. */
export async function pushSupportAnswer(ex: Executor, ticket: Ticket, now: Date): Promise<string | null> {
  if (ticket.opened_by === "admin" && ticket.visible_to_person !== true) return null;
  const audience = ticket.driver_id && !ticket.rider_id ? "driver" : ticket.rider_id ? "rider" : null;
  if (audience === null) return null;
  const subjectId = audience === "rider" ? ticket.rider_id! : ticket.driver_id!;
  const person =
    audience === "rider"
      ? await ex.selectFrom("riders").select("language").where("rider_id", "=", subjectId).executeTakeFirst()
      : await ex.selectFrom("drivers").select("language").where("driver_id", "=", subjectId).executeTakeFirst();
  if (!person) return null;
  let language: Lang | undefined = isLang(person.language) ? person.language : undefined;
  if (language === undefined) {
    const zone = ticket.zone_id ? await ex.selectFrom("zones").select("country").where("zone_id", "=", ticket.zone_id).executeTakeFirst() : undefined;
    const country = zone?.country ?? ticket.country ?? null;
    language = (country && COUNTRY_LANGUAGE[country]) || "en";
  }
  return notify(ex, {
    audience,
    subjectId,
    kind: SUPPORT_ANSWER_PUSH.kind,
    title: SUPPORT_ANSWER_PUSH.texts.title[language],
    body: SUPPORT_ANSWER_PUSH.texts.body[language],
    deepLink: SUPPORT_ANSWER_PUSH.deepLink[audience].replace("{ticketId}", ticket.ticket_id),
    bell: true,
    // Every language, so the Notifications list shows the reader's language of the moment (notificationView).
    data: { ticketId: ticket.ticket_id, texts: SUPPORT_ANSWER_PUSH.texts },
  }, now);
}
