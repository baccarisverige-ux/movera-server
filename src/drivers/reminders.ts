import type { Executor } from "../db/db.js";
import { contract } from "../contract/contract.js";
import { notify } from "../notifications/service.js";
import { ONBOARDING } from "./onboardingRules.js";
import { PHOTO_TYPES, daysLeft, onboardingSettings, requiredOf, typeInfo, type OnboardingSettings } from "./onboardingSettings.js";
import { isTestDriver, pickableCars } from "./readiness.js";

/**
 * Contract v0.17.0 §25 (owner decisions of 2026-10-29, driver group 2, items 1, 2, 3, 8, 9 and the note check):
 * the Home sheet's "Important reminders", the expiry warnings and the expired mark, and the 'Finish your sign-up'
 * reminders. Notices go through GET /notifications (the app's push path), each once.
 */

type Level = "blocks_online" | "due_soon" | "waiting";
type Scope = "driver" | "fleet" | "vehicle";
export type Reminder = {
  kind: string;
  level: Level;
  scope?: Scope;
  documentType?: string;
  documentId?: string;
  vehicleId?: string;
  status?: string;
  expiresAt?: string;
  daysLeft?: number;
  reviewNote?: string;
  fix?: { target: string; documentType?: string; scope?: Scope; vehicleId?: string; contentSlot?: string };
};

type DriverLike = { driver_id: string; country: string | null; account_type: string | null; account_status: string; fleet_id: string | null; vehicle_id: string | null; language?: string | null; created_at?: Date };
type DocRow = { document_id: string; type: string; status: string; expires_at: Date | null; review_note: string | null; owner_id: string };

const INFO = (contract as unknown as { driverOnboarding: { infoSession: { type: string; status: string; contentSlot: string } } }).driverOnboarding.infoSession;
type SignUpText = { kind: string; text: { title: Record<string, string>; body: Record<string, string> } };
const SIGN_UP = (contract as unknown as { driverOnboarding: { signUpReminders: SignUpText } }).driverOnboarding.signUpReminders;
const RANK: Record<Level, number> = { blocks_online: 0, due_soon: 1, waiting: 2 };

/** Warning days, largest first: people expiry.warnDays; cars vehicles.warnDays, then the smaller people days. */
export function warnDaysFor(settings: OnboardingSettings, ownerKind: "driver" | "vehicle"): number[] {
  if (ownerKind === "driver") return settings.expiry.warnDays;
  const first = settings.vehicles.warnDays;
  return [first, ...settings.expiry.warnDays.filter((d) => d < first)];
}

/** The reminder lines of one owner's required documents. */
function documentLines(required: string[], docs: DocRow[], scope: Scope, settings: OnboardingSettings, now: Date, vehicleId?: string): Reminder[] {
  const out: Reminder[] = [];
  const firstWarning = warnDaysFor(settings, scope === "vehicle" ? "vehicle" : "driver")[0] ?? 0;
  const blocks = scope === "vehicle" ? settings.vehicles.autoHold : settings.expiry.blockAtExpiry;
  for (const type of required) {
    const doc = docs.find((d) => d.type === type);
    const fix = { target: "document", documentType: type, scope, ...(vehicleId ? { vehicleId } : {}) };
    const base = { scope, documentType: type, ...(vehicleId ? { vehicleId } : {}), ...(doc ? { documentId: doc.document_id } : {}) };
    const kind = typeInfo(settings, type)?.kind;
    if (kind === "admin_check" && doc?.status !== "approved" && doc?.status !== "rejected") {
      // The info session has its "How to book" page; an admin_check type of the admin's own only waits (item 14).
      if (type === INFO.type) out.push({ kind: "info_session_waiting", level: "waiting", ...base, status: INFO.status, fix: { target: "info_session", contentSlot: INFO.contentSlot } });
      else out.push({ kind: "admin_check_waiting", level: "waiting", ...base, status: INFO.status });
      continue;
    }
    if (doc === undefined || doc.status === "missing") out.push({ kind: "document_needed", level: "blocks_online", ...base, status: "needed", fix });
    else if (doc.status === "rejected") out.push({ kind: "document_rejected", level: "blocks_online", ...base, status: "rejected", ...(doc.review_note ? { reviewNote: doc.review_note } : {}), fix });
    else if (doc.status === "in_review") out.push({ kind: "document_in_review", level: "waiting", ...base, status: "in_review" });
    else if (doc.expires_at !== null) {
      const left = daysLeft(doc.expires_at, now);
      const at = { expiresAt: doc.expires_at.toISOString(), daysLeft: left };
      if (doc.status === "expired" || left === 0) out.push({ kind: "document_expired", level: blocks ? "blocks_online" : "due_soon", ...base, status: "expired", ...at, fix });
      else if (left <= firstWarning) out.push({ kind: "document_expiring", level: "due_soon", ...base, status: "expiring", ...at, fix });
    }
  }
  return out;
}

async function docsOf(ex: Executor, ownerKind: "driver" | "vehicle", ownerIds: string[]): Promise<DocRow[]> {
  if (ownerIds.length === 0) return [];
  return (await ex.selectFrom("documents").select(["document_id", "type", "status", "expires_at", "review_note", "owner_id"]).where("owner_kind", "=", ownerKind).where("owner_id", "in", ownerIds).execute()) as DocRow[];
}

/** GET /driver/reminders (contract.json#driverOnboarding.reminders). */
export async function listReminders(ex: Executor, driver: DriverLike, now: Date): Promise<{ items: Reminder[]; blocksOnline: number }> {
  const items: Reminder[] = [];
  if (driver.country) {
    const settings = await onboardingSettings(ex, driver.country);
    const own = await docsOf(ex, "driver", [driver.driver_id]);
    items.push(...documentLines(requiredOf(settings, "driver"), own, "driver", settings, now));
    if (driver.account_type === "fleet") items.push(...documentLines(requiredOf(settings, "fleet"), own, "fleet", settings, now));
    // The cars: an owner sees every car of his fleet; a member the one he picked.
    const fleet = driver.fleet_id ? await ex.selectFrom("fleets").select(["fleet_id", "status", "owner_driver_id", "country"]).where("fleet_id", "=", driver.fleet_id).executeTakeFirst() : undefined;
    const owner = fleet?.owner_driver_id === driver.driver_id;
    // v0.18.0 (owner decision 19): car documents are the owner's; a member gets no car-document lines.
    const carIds = owner && fleet ? (await ex.selectFrom("vehicles").select("vehicle_id").where("fleet_id", "=", fleet.fleet_id).execute()).map((r) => r.vehicle_id) : !fleet && driver.vehicle_id ? [driver.vehicle_id] : [];
    const carSettings = fleet ? await onboardingSettings(ex, fleet.country) : settings;
    const carDocs = await docsOf(ex, "vehicle", carIds);
    // v0.18.0 (owner item 16): the four photos are one line "Add 4 photos of your car"; a test account is not asked.
    const exempt = await isTestDriver(ex, driver.driver_id);
    for (const id of carIds) {
      const mine = carDocs.filter((d) => d.owner_id === id);
      const required = requiredOf(carSettings, "vehicle");
      items.push(...documentLines(required.filter((t) => !PHOTO_TYPES.includes(t)), mine, "vehicle", carSettings, now, id));
      const photos = required.filter((t) => PHOTO_TYPES.includes(t));
      const todo = photos.filter((t) => !["approved", "in_review"].includes(mine.find((d) => d.type === t)?.status ?? "missing"));
      if (!exempt && todo.length > 0) items.push({ kind: "vehicle_photos_needed", level: "blocks_online", scope: "vehicle", vehicleId: id, documentType: todo[0]!, fix: { target: "document", documentType: todo[0]!, scope: "vehicle", vehicleId: id } });
      else if (!exempt && photos.some((t) => mine.find((d) => d.type === t)?.status === "in_review")) items.push({ kind: "document_in_review", level: "waiting", scope: "vehicle", vehicleId: id, documentType: photos.find((t) => mine.find((d) => d.type === t)?.status === "in_review")! });
    }
    if (fleet && fleet.status !== "approved") items.push({ kind: "fleet_not_approved", level: "blocks_online" });
    if (fleet && fleet.status === "approved" && driver.vehicle_id === null) {
      const pickable = await pickableCars(ex, fleet.fleet_id, now, driver.driver_id);
      if (pickable.length === 0) items.push({ kind: "fleet_no_approved_car", level: "blocks_online", ...(owner ? { fix: { target: "fleet_vehicles" } } : {}) });
      else items.push({ kind: "no_vehicle", level: "blocks_online", fix: { target: "pick_vehicle" } });
    }
  }
  if (driver.account_status !== "active" && !items.some((i) => i.level === "blocks_online" && i.kind.startsWith("document_"))) items.push({ kind: "account_not_active", level: "blocks_online" });
  items.sort((a, b) => RANK[a.level] - RANK[b.level] || (a.expiresAt ?? "~").localeCompare(b.expiresAt ?? "~") || (a.documentType ?? "").localeCompare(b.documentType ?? ""));
  return { items, blocksOnline: items.filter((i) => i.level === "blocks_online").length };
}

/* ---------------------------------------------------------------- the hourly sweep */

const lang = (language: string | null | undefined) => (language === "sv" || language === "fr" ? language : "en");

const EXPIRY_TEXT: Record<"document_expiring" | "document_expired", Record<"sv" | "fr" | "en", (name: string, days: number) => { title: string; body: string }>> = {
  document_expiring: {
    sv: (name, days) => ({ title: `${name} går ut om ${days} ${days === 1 ? "dag" : "dagar"}`, body: "Ladda upp ett nytt i Movera Driver innan det går ut." }),
    fr: (name, days) => ({ title: `${name} expire dans ${days} jour${days === 1 ? "" : "s"}`, body: "Envoyez le nouveau dans Movera Driver avant l’expiration." }),
    en: (name, days) => ({ title: `${name} expires in ${days} day${days === 1 ? "" : "s"}`, body: "Upload the new one in Movera Driver before it expires." }),
  },
  document_expired: {
    sv: (name) => ({ title: `${name} har gått ut`, body: "Ladda upp ett nytt för att kunna köra igen." }),
    fr: (name) => ({ title: `${name} a expiré`, body: "Envoyez le nouveau pour pouvoir rouler à nouveau." }),
    en: (name) => ({ title: `${name} has expired`, body: "Upload the new one to drive again." }),
  },
};

/**
 * Marks documents expired at their expiresAt and sends the warnings (30 / 7 / 1 days by default; only the smallest
 * reached when several are reached at once) and the expired notice, each once per document and expiry date.
 */
export async function sweepDocumentExpiry(ex: Executor, now: Date): Promise<void> {
  const due = await ex.selectFrom("documents").select(["document_id", "driver_id", "owner_kind", "owner_id", "type", "status", "expires_at"]).where("status", "=", "approved").where("expires_at", "is not", null).execute();
  for (const doc of due) {
    const expiresAt = doc.expires_at!;
    const driver = await ex.selectFrom("drivers").select(["driver_id", "country", "language"]).where("driver_id", "=", doc.driver_id).executeTakeFirst();
    if (driver === undefined) continue;
    let country = driver.country;
    let vehicleId: string | undefined;
    if (doc.owner_kind === "vehicle") {
      vehicleId = doc.owner_id;
      const car = await ex.selectFrom("vehicles").select(["fleet_id"]).where("vehicle_id", "=", doc.owner_id).executeTakeFirst();
      if (car?.fleet_id) country = (await ex.selectFrom("fleets").select("country").where("fleet_id", "=", car.fleet_id).executeTakeFirst())?.country ?? country;
    }
    const settings = await onboardingSettings(ex, country);
    const left = daysLeft(expiresAt, now);
    const scope = doc.owner_kind === "vehicle" ? "vehicle" : settings.documents.fleet.includes(doc.type) && !settings.documents.driver.includes(doc.type) ? "fleet" : "driver";
    let kind: "document_expiring" | "document_expired";
    let warnDay: number;
    if (left === 0) {
      await ex.updateTable("documents").set({ status: "expired", updated_at: now }).where("document_id", "=", doc.document_id).where("status", "=", "approved").execute();
      kind = "document_expired";
      warnDay = 0;
    } else {
      const days = warnDaysFor(settings, doc.owner_kind);
      const reached = days.filter((d) => left <= d);
      if (reached.length === 0) continue;
      kind = "document_expiring";
      warnDay = Math.min(...reached);
    }
    const sent = await ex.insertInto("document_notices").values({ document_id: doc.document_id, expires_at: expiresAt, warn_day: warnDay, sent_at: now }).onConflict((c) => c.doNothing()).returning("document_id").executeTakeFirst();
    if (sent === undefined) continue;
    // A warning day already passed counts as sent too (a later, larger one is never sent after a smaller one).
    if (kind === "document_expiring") {
      const larger = warnDaysFor(settings, doc.owner_kind).filter((d) => d > warnDay);
      for (const d of larger) await ex.insertInto("document_notices").values({ document_id: doc.document_id, expires_at: expiresAt, warn_day: d, sent_at: now }).onConflict((c) => c.doNothing()).execute();
    }
    const language = lang(driver.language);
    const name = typeInfo(settings, doc.type)?.name[language] ?? doc.type;
    const text = EXPIRY_TEXT[kind][language](name, left);
    await notify(ex, {
      audience: "driver",
      subjectId: doc.driver_id,
      kind,
      ...text,
      deepLink: `movera-driver://documents/${doc.type}${vehicleId ? `?vehicleId=${vehicleId}` : ""}`,
      data: { documentId: doc.document_id, type: doc.type, scope, ...(vehicleId ? { vehicleId } : {}), daysLeft: left, expiresAt: expiresAt.toISOString() },
    }, now);
  }
}

/** The account waits on itself: details not sent, or a required file document missing or rejected. */
async function waitsOnItself(ex: Executor, d: DriverLike, settings: OnboardingSettings): Promise<boolean> {
  if (d.account_status === "pending") return true;
  const required = [...requiredOf(settings, "driver"), ...(d.account_type === "fleet" ? requiredOf(settings, "fleet") : [])].filter((t) => typeInfo(settings, t)?.kind === "file");
  if (required.length === 0) return false;
  const docs = await ex.selectFrom("documents").select(["type", "status"]).where("owner_kind", "=", "driver").where("owner_id", "=", d.driver_id).where("type", "in", required).execute();
  return required.some((t) => {
    const doc = docs.find((r) => r.type === t);
    return doc === undefined || doc.status === "missing" || doc.status === "rejected";
  });
}

/** 'Finish your sign-up' every everyDays days from sign-up, then from the last one (note check). */
export async function sweepSignUpReminders(ex: Executor, now: Date): Promise<void> {
  const rows = await ex.selectFrom("drivers").select(["driver_id", "country", "account_type", "account_status", "fleet_id", "vehicle_id", "language", "created_at"]).where("account_status", "in", ["pending", "on_hold"]).where("account_type", "is not", null).execute();
  for (const d of rows as DriverLike[]) {
    const settings = await onboardingSettings(ex, d.country);
    if (!d.country || !settings.signUpReminders.on) continue;
    if (!ONBOARDING.countries[d.country]?.open) continue;
    const last = await ex.selectFrom("sign_up_reminders").select("sent_at").where("driver_id", "=", d.driver_id).orderBy("sent_at", "desc").executeTakeFirst();
    const from = last?.sent_at ?? d.created_at!;
    if (now.getTime() - from.getTime() < settings.signUpReminders.everyDays * 86_400_000) continue;
    if (!(await waitsOnItself(ex, d, settings))) continue;
    await ex.insertInto("sign_up_reminders").values({ driver_id: d.driver_id, sent_at: now }).execute();
    const language = lang(d.language);
    await notify(ex, { audience: "driver", subjectId: d.driver_id, kind: SIGN_UP.kind, title: SIGN_UP.text.title[language]!, body: SIGN_UP.text.body[language]!, deepLink: "movera-driver://home" }, now);
  }
}

/** Driver.signUp (admin view) while the account is pending or on_hold. */
export async function signUpView(ex: Executor, d: { driver_id: string; account_status: string; country: string | null; created_at?: Date }, now: Date = new Date()) {
  if (d.account_status !== "pending" && d.account_status !== "on_hold") return {};
  const created = d.created_at ?? (await ex.selectFrom("drivers").select("created_at").where("driver_id", "=", d.driver_id).executeTakeFirstOrThrow()).created_at;
  const settings = await onboardingSettings(ex, d.country);
  const sent = await ex.selectFrom("sign_up_reminders").select("sent_at").where("driver_id", "=", d.driver_id).orderBy("sent_at", "desc").execute();
  return {
    signUp: {
      since: created.toISOString(),
      stuck: now.getTime() - created.getTime() >= settings.signUpReminders.stuckAfterDays * 86_400_000,
      remindersSent: sent.length,
      ...(sent[0] ? { lastReminderAt: sent[0].sent_at.toISOString() } : {}),
    },
  };
}
