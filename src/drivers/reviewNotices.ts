import type { Executor } from "../db/db.js";
import { contract } from "../contract/contract.js";
import { notify } from "../notifications/service.js";
import { onboardingSettings, typeInfo } from "./onboardingSettings.js";

/**
 * Contract v0.18.3 §28 (contract.json#driverOnboarding.reviewNotices, owner R6 "Update + notice (Recommended)"): every
 * admin decision on a document or a car is one bell notice to the account concerned, in its language, with the reason.
 */

type Lang = "sv" | "fr" | "en";
type Texts = Record<string, { title: Record<Lang, string>; body: Record<Lang, string>; bodyNoNote?: Record<Lang, string> }>;
const NOTICES = (contract as unknown as { driverOnboarding: { reviewNotices: { texts: Texts } } }).driverOnboarding.reviewNotices;

const lang = (language: string | null | undefined): Lang => (language === "sv" || language === "fr" ? language : "en");
const fill = (text: string, values: Record<string, string>) => text.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? "");

function words(kind: string, language: Lang, values: Record<string, string>, note: string | null) {
  const t = NOTICES.texts[kind]!;
  const body = note === null && t.bodyNoNote ? t.bodyNoNote[language] : t.body[language];
  return { title: fill(t.title[language], values), body: fill(body, { ...values, note: note ?? "" }) };
}

/** The account a car belongs to: its fleet's owner, else its driver. */
async function carAccount(ex: Executor, car: { fleet_id: string | null; driver_id: string | null }): Promise<{ driverId: string; country: string | null } | null> {
  if (car.fleet_id) {
    const fleet = await ex.selectFrom("fleets").select(["owner_driver_id", "country"]).where("fleet_id", "=", car.fleet_id).executeTakeFirst();
    return fleet ? { driverId: fleet.owner_driver_id, country: fleet.country } : null;
  }
  return car.driver_id ? { driverId: car.driver_id, country: null } : null;
}

/** document_approved / document_rejected to the document's account (a car's document to the car's fleet owner). */
export async function noticeDocumentReview(
  ex: Executor,
  doc: { document_id: string; driver_id: string; owner_kind: "driver" | "vehicle"; owner_id: string; type: string },
  decision: "approved" | "rejected",
  note: string | null,
  now: Date,
): Promise<void> {
  let to = doc.driver_id;
  let country: string | null = null;
  if (doc.owner_kind === "vehicle") {
    const car = await ex.selectFrom("vehicles").select(["fleet_id", "driver_id"]).where("vehicle_id", "=", doc.owner_id).executeTakeFirst();
    const account = car ? await carAccount(ex, car) : null;
    if (account) ({ driverId: to, country } = account);
  }
  const driver = await ex.selectFrom("drivers").select(["language", "country"]).where("driver_id", "=", to).executeTakeFirst();
  if (driver === undefined) return;
  const settings = await onboardingSettings(ex, country ?? driver.country);
  const language = lang(driver.language);
  const name = typeInfo(settings, doc.type)?.name[language] ?? doc.type;
  const scope = doc.owner_kind === "vehicle" ? "vehicle" : settings.documents.fleet.includes(doc.type) && !settings.documents.driver.includes(doc.type) ? "fleet" : "driver";
  const vehicleId = doc.owner_kind === "vehicle" ? doc.owner_id : undefined;
  const kind = decision === "approved" ? "document_approved" : "document_rejected";
  await notify(ex, {
    audience: "driver",
    subjectId: to,
    kind,
    ...words(kind, language, { name }, note),
    deepLink: `movera-driver://documents/${doc.type}${vehicleId ? `?vehicleId=${vehicleId}` : ""}`,
    data: { documentId: doc.document_id, type: doc.type, scope, ...(vehicleId ? { vehicleId } : {}), decision, ...(note !== null ? { note } : {}) },
  }, now);
}

/** vehicle_approved / vehicle_rejected / vehicle_blocked to the car's fleet owner (a car without fleet: its driver). */
export async function noticeVehicleReview(
  ex: Executor,
  car: { vehicle_id: string; plate: string; fleet_id: string | null; driver_id: string | null },
  decision: "approved" | "rejected" | "blocked",
  note: string | null,
  now: Date,
): Promise<void> {
  const account = await carAccount(ex, car);
  if (account === null) return;
  const driver = await ex.selectFrom("drivers").select("language").where("driver_id", "=", account.driverId).executeTakeFirst();
  if (driver === undefined) return;
  const kind = `vehicle_${decision}`;
  await notify(ex, {
    audience: "driver",
    subjectId: account.driverId,
    kind,
    ...words(kind, lang(driver.language), { plate: car.plate }, note),
    deepLink: "movera-driver://fleet",
    data: { vehicleId: car.vehicle_id, plate: car.plate, decision, ...(note !== null ? { note } : {}) },
  }, now);
}
