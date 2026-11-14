import { contract } from "../contract/contract.js";
import type { Db, Executor, Trx } from "../db/db.js";
import { liveDocument, standardKey } from "../config/service.js";
import { emergencyNumbersFor } from "../config/emergencyNumbers.js";
import { ApiError } from "../http/errors.js";
import { newId } from "../ids.js";
import { noticeLanguage, type Lang } from "../notifications/noticeLanguage.js";
import type { SmsProvider } from "../sms/sms.js";
import { scrubText } from "../telemetry/scrub.js";
import { driverContacts } from "../accounts/phoneData.js";

/**
 * v0.18.101 §92 (contract.json#sosContactsSms; BQ-V34 = BQ-S12, owner 2026-11-02 Q2 "Use them in SOS (Recommended)",
 * Rules decisions/driver-g14.md:12): the FIRST driver SOS of a case writes one SMS with his position to each of his
 * emergency contacts, when the country standard's CountryRules.sosContactsSms is on (default on).
 *
 * "SMS not connected" seam: without an SMS company (today; the owner chose 46elks + Twilio, keys missing) the rows are
 * kept in sms_outbox as `skipped` and the result is `not_connected`. With one, the rows are written `queued` inside the
 * SOS command and handed to the company only AFTER the command is saved ({@link deliverSosSms}), so the SOS answer and
 * the emergency call never wait for it. The rider's SOS never texts anybody.
 */

type Texts = { sms: Record<Lang, string>; noPosition: Record<Lang, string> };
type SosSmsContract = { statuses: string[]; positionLink: string; callingCodes: Record<string, string>; texts: Texts };
const SCS = (contract as unknown as { sosContactsSms: SosSmsContract }).sosContactsSms;
const DEFAULTS = (contract as unknown as { configDefaults: { sosContactsSms: Record<string, boolean> } }).configDefaults.sosContactsSms;
export const SOS_SMS_KIND = "sos_contact";

export type SosSmsStatus = "off" | "no_contacts" | "not_connected" | "queued" | "sent" | "failed";
export type SosContactsSms = { status: SosSmsStatus; contacts: number; sent?: number; at: string };
type LatLng = { lat: number; lng: number };

/** contract.json#sosContactsSms.phone: + kept; 00… → +…; a leading 0 or a bare number gets the country's calling code. */
export function internationalPhone(phone: string, country: string | null): string {
  const p = phone.replace(/[\s-]/g, "");
  if (p.startsWith("+")) return p;
  if (p.startsWith("00")) return `+${p.slice(2)}`;
  const code = country ? SCS.callingCodes[country] : undefined;
  if (!code) return p;
  return p.startsWith("0") ? `${code}${p.slice(1)}` : `${code}${p}`;
}

/** contract.json#sosContactsSms.text: the SMS in the driver's notice language. */
export function sosSmsText(lang: Lang, input: { driver: string; position: LatLng | null; emergency: string }): string {
  const template = SCS.texts.sms[lang] ?? SCS.texts.sms.en;
  const filled = input.position
    ? template.replace("{link}", SCS.positionLink.replace("{lat}", input.position.lat.toFixed(6)).replace("{lng}", input.position.lng.toFixed(6)))
    : template.replace(/Position ?: \{link\}/, SCS.texts.noPosition[lang] ?? SCS.texts.noPosition.en);
  return filled.replaceAll("{driver}", input.driver).replaceAll("{emergency}", input.emergency);
}

/** CountryRules.sosContactsSms of the country standard; never saved → configDefaults.sosContactsSms. */
export async function sosSmsOn(ex: Executor, country: string): Promise<boolean> {
  const rules = await liveDocument<{ sosContactsSms?: unknown }>(ex, "country_rules", standardKey(country));
  const saved = rules?.document.sosContactsSms;
  if (typeof saved === "boolean") return saved;
  return DEFAULTS[country] ?? DEFAULTS["other"] ?? true;
}

/** PUT country_rules: only the country standard carries the switch, and only as true / false. */
export function checkSosContactsSms(zoneKind: string, document: unknown): void {
  if (!document || typeof document !== "object" || !("sosContactsSms" in document)) return;
  if (zoneKind !== "standard") throw new ApiError("invalid_request", "The SOS SMS switch is set per country, on the country standard.", { reason: "sos_sms_country_only" });
  if (typeof (document as Record<string, unknown>)["sosContactsSms"] !== "boolean") throw new ApiError("invalid_request", "sosContactsSms must be true or false.", { reason: "invalid_document" });
}

const latLng = (raw: unknown): LatLng | null => {
  const r = (raw && typeof raw === "object" ? raw : null) as { lat?: unknown; lng?: unknown } | null;
  return r && typeof r.lat === "number" && typeof r.lng === "number" ? { lat: r.lat, lng: r.lng } : null;
};

/**
 * Called by the driver's SOS inside its command, for the case's first driver SOS only (incidents.contacts_sms is NULL).
 * Stores the result on the incident and answers it, plus the queued rows to hand over after the save.
 */
export async function writeSosSms(
  trx: Trx,
  incident: { incident_id: string; zone_id: string | null; driver_id: string | null; position: unknown; driver_fix: unknown },
  connected: boolean,
  now: Date,
): Promise<{ result: SosContactsSms; queued: string[] }> {
  const at = now.toISOString();
  const zone = incident.zone_id ? await trx.selectFrom("zones").select("country").where("zone_id", "=", incident.zone_id).executeTakeFirst() : undefined;
  const country = zone?.country ?? null;
  const queued: string[] = [];
  let result: SosContactsSms;
  if (!incident.driver_id) result = { status: "no_contacts", contacts: 0, at };
  else if (country !== null && !(await sosSmsOn(trx, country))) result = { status: "off", contacts: 0, at };
  else {
    const { items } = await driverContacts(trx, incident.driver_id);
    if (items.length === 0) result = { status: "no_contacts", contacts: 0, at };
    else {
      const driver = await trx.selectFrom("drivers").select(["first_name", "language"]).where("driver_id", "=", incident.driver_id).executeTakeFirstOrThrow();
      const lang = await noticeLanguage(trx, { actor: "driver", id: incident.driver_id, language: driver.language }, incident.zone_id);
      const emergency = country ? ((await emergencyNumbersFor(trx, country))[0]?.number ?? "112") : "112";
      const text = sosSmsText(lang, { driver: driver.first_name, position: latLng(incident.position) ?? latLng(incident.driver_fix), emergency });
      for (const [i, contact] of items.entries()) {
        const smsId = newId("sms", now.getTime() + i);
        await trx.insertInto("sms_outbox").values({ sms_id: smsId, phone: internationalPhone(contact.phone, country), text, kind: SOS_SMS_KIND, status: connected ? "queued" : "skipped", provider: null, created_at: now }).execute();
        if (connected) queued.push(smsId);
      }
      result = { status: connected ? "queued" : "not_connected", contacts: items.length, at };
    }
  }
  await trx.updateTable("incidents").set({ contacts_sms: JSON.stringify(result) }).where("incident_id", "=", incident.incident_id).execute();
  return { result, queued };
}

/**
 * After the SOS is saved: hands the queued rows to the SMS company, one by one, then stores sent / failed on the case
 * (and tells the admin feed). Never throws; the caller does not wait for it.
 */
export async function deliverSosSms(
  db: Db,
  provider: SmsProvider,
  incidentId: string,
  smsIds: string[],
  deps: { now: () => Date; warn?: (data: Record<string, unknown>, message: string) => void; onUpdated?: (trx: Trx, incidentId: string, now: Date) => Promise<void> },
): Promise<void> {
  let sent = 0;
  for (const smsId of smsIds) {
    const row = await db.updateTable("sms_outbox").set({ provider: provider.name }).where("sms_id", "=", smsId).where("status", "=", "queued").where("provider", "is", null).returningAll().executeTakeFirst();
    if (!row) continue;
    try {
      const ref = await provider.send({ phone: row.phone, text: row.text, kind: row.kind });
      await db.updateTable("sms_outbox").set({ status: "sent", provider_ref: ref, sent_at: deps.now() }).where("sms_id", "=", smsId).execute();
      sent++;
    } catch (error) {
      await db.updateTable("sms_outbox").set({ status: "failed", error: String(error).slice(0, 500) }).where("sms_id", "=", smsId).execute();
      deps.warn?.({ smsId, err: scrubText(String(error)) }, "SOS SMS failed");
    }
  }
  await db.transaction().execute(async (trx) => {
    const now = deps.now();
    const current = await trx.selectFrom("incidents").select("contacts_sms").where("incident_id", "=", incidentId).forUpdate().executeTakeFirst();
    const before = (current?.contacts_sms ?? null) as SosContactsSms | null;
    if (!before) return;
    const result: SosContactsSms = { status: sent > 0 ? "sent" : "failed", contacts: before.contacts, sent, at: now.toISOString() };
    await trx.updateTable("incidents").set({ contacts_sms: JSON.stringify(result), updated_at: now }).where("incident_id", "=", incidentId).execute();
    await deps.onUpdated?.(trx, incidentId, now);
  });
}

/** For the driver config: the zone country's switch. */
export const sosSmsDriverConfig = async (ex: Executor, country: string, connected: boolean) => ({ on: await sosSmsOn(ex, country), connected });
