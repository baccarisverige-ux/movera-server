import { sessionsRevoked } from "../auth/sessionCache.js";
import { sql } from "kysely";
import type { Executor, Trx } from "../db/db.js";
import { ApiError } from "../http/errors.js";
import { TERMINAL, type TripStatus } from "../rules/transitions.js";
import { owedByDriver } from "../drivers/owes.js";
import { COUNTRY_CURRENCY } from "../drivers/onboardingRules.js";
import { outstandingByCurrency } from "../riders/service.js";
import { audit } from "../admin/audit.js";

/**
 * contract v0.18.134 (contract.json#accountDeletion; owner button 2026-11-20 "Accept, keep debt (Rec.)", Rules
 * decisions/session-2026-11-06.md). WAITS FOR THE NEW SERVER (owner 2026-11-19: nothing on the current server).
 *
 * - The request (rider or driver) closes the account at once: sessions end, push addresses go, a driver goes offline;
 *   sign-in answers 403 account_closed until the erase is done (closedError, used by auth/service.ts).
 * - A debt never blocks the request; it is copied to kept_debts (name, number, amount) and kept until paid / written off.
 * - account_erase (hourly housekeeping kind, so it has a heartbeat) erases accounts due eraseAfterDays after the
 *   request, at most ERASE_BATCH per run, one savepoint per account, erased_at set last (idempotent). While
 *   CountryRules.accountDeletion.eraseEnabled is off (default) it only counts (dry-run).
 * - Kept (bookkeeping, 7 years, FLAGGED for the lawyer): trips, fees, wallet, refunds, earnings, payouts, ratings, audit,
 *   the debt record; the driver's first + last name (privacy Q2 open).
 */

export const ACCOUNT_ERASE = "account_erase";
export const ERASE_BATCH = 10;
const DAY_MS = 86_400_000;
type Kind = "rider" | "driver";
type Setting = { eraseEnabled: boolean; eraseAfterDays: number };
const DEFAULT_SETTING: Setting = { eraseEnabled: false, eraseAfterDays: 30 };

export function closedError(): ApiError {
  return new ApiError("forbidden", "This account is closed. It is being deleted.", { reason: "account_closed" });
}

/** CountryRules.accountDeletion of the country standard, read without the live cache (a job, rarely). */
export async function deletionSetting(ex: Executor, country: string | null): Promise<Setting> {
  const row = await ex.selectFrom("config_live").select("document").where("doc", "=", "country_rules").where("zone_id", "=", `standard-${country ?? "SE"}`).executeTakeFirst();
  const set = (row?.document as { accountDeletion?: Partial<Setting> } | undefined)?.accountDeletion;
  const days = typeof set?.eraseAfterDays === "number" && Number.isInteger(set.eraseAfterDays) ? Math.max(30, Math.min(365, set.eraseAfterDays)) : DEFAULT_SETTING.eraseAfterDays;
  return { eraseEnabled: set?.eraseEnabled === true, eraseAfterDays: days };
}

const OPEN = (status: string) => !TERMINAL.has(status as TripStatus);

async function hasOpenTrip(ex: Executor, kind: Kind, id: string): Promise<boolean> {
  const rows = await ex.selectFrom("trips").select("status").where(kind === "rider" ? "rider_id" : "driver_id", "=", id).orderBy("created_at", "desc").limit(50).execute();
  return rows.some((r) => OPEN(r.status));
}

async function debtsOf(trx: Trx, kind: Kind, id: string, row: { country?: string | null; outstanding_minor?: string; outstanding_currency?: string | null }): Promise<Array<{ amountMinor: number; currency: string }>> {
  if (kind === "rider") {
    const list = await outstandingByCurrency(trx, id);
    if (list.length > 0) return list.filter((d) => d.amountMinor > 0);
    const minor = Number(row.outstanding_minor ?? 0);
    return minor > 0 && row.outstanding_currency ? [{ amountMinor: minor, currency: row.outstanding_currency }] : [];
  }
  const currency = COUNTRY_CURRENCY[row.country ?? "SE"] ?? "SEK";
  const owed = (await owedByDriver(trx, [id], currency)).get(id) ?? 0;
  return owed > 0 ? [{ amountMinor: owed, currency }] : [];
}

type DebtRow = { phone: string; first_name: string; last_name: string; country?: string | null; outstanding_minor?: string; outstanding_currency?: string | null };

/** Writes one kept_debts row per currency the account owes now (never overwrites one that exists). */
async function recordDebts(trx: Trx, kind: Kind, id: string, row: DebtRow, now: Date): Promise<void> {
  for (const d of await debtsOf(trx, kind, id, row)) {
    await trx
      .insertInto("kept_debts")
      .values({ account_kind: kind, account_id: id, first_name: row.first_name, last_name: row.last_name, phone: row.phone, amount_minor: d.amountMinor, currency: d.currency, created_at: now })
      .onConflict((c) => c.columns(["account_kind", "account_id", "currency"]).doNothing())
      .execute();
  }
}

/**
 * Review MUST-FIX 1: a kept debt record follows the live debt (wallet / earnings, which stay after the erase): the amount
 * is updated, and 0 = settled (paid in the car, Mark as paid, Driver paid Movera, written off). Called by those admin
 * actions and by every account_erase run.
 */
export async function refreshKeptDebts(trx: Executor, kind: Kind, id: string, now: Date): Promise<void> {
  const rows = await trx.selectFrom("kept_debts").select(["currency"]).where("account_kind", "=", kind).where("account_id", "=", id).where("settled_at", "is", null).execute();
  if (rows.length === 0) return;
  const row =
    kind === "driver"
      ? { country: (await trx.selectFrom("drivers").select("country").where("driver_id", "=", id).executeTakeFirst())?.country ?? null }
      : ((await trx.selectFrom("riders").select(["outstanding_minor", "outstanding_currency"]).where("rider_id", "=", id).executeTakeFirst()) ?? {});
  const live = await debtsOf(trx as Trx, kind, id, row);
  for (const r of rows) {
    const now_ = live.find((d) => d.currency === r.currency)?.amountMinor ?? 0;
    await trx
      .updateTable("kept_debts")
      .set(now_ > 0 ? { amount_minor: now_ } : { settled_at: now })
      .where("account_kind", "=", kind).where("account_id", "=", id).where("currency", "=", r.currency).where("settled_at", "is", null)
      .execute();
  }
}

/** POST /account/deletion and POST /driver/account/deletion: 202 AccountDeletion. */
export async function requestAccountDeletion(trx: Trx, kind: Kind, id: string, now: Date) {
  const row =
    kind === "rider"
      ? await trx.selectFrom("riders").select(["phone", "first_name", sql<string>`''`.as("last_name"), "deletion_requested_at", sql<string | null>`null`.as("country"), "outstanding_minor", "outstanding_currency"]).where("rider_id", "=", id).forUpdate().executeTakeFirstOrThrow()
      : await trx.selectFrom("drivers").select(["phone", "first_name", "last_name", "deletion_requested_at", "country", sql<string>`'0'`.as("outstanding_minor"), sql<string | null>`null`.as("outstanding_currency")]).where("driver_id", "=", id).forUpdate().executeTakeFirstOrThrow();
  const setting = await deletionSetting(trx, kind === "driver" ? row.country : null);
  if (row.deletion_requested_at) return answer(row.deletion_requested_at, setting);
  if (await hasOpenTrip(trx, kind, id)) {
    throw new ApiError("conflict", "Finish or cancel your ride first, then delete your account.", { reason: "deletion_open_trip" });
  }
  await recordDebts(trx, kind, id, row, now);
  if (kind === "rider") await trx.updateTable("riders").set({ deletion_requested_at: now, updated_at: now }).where("rider_id", "=", id).execute();
  else {
    await trx.updateTable("drivers").set({ deletion_requested_at: now, online_status: "offline", online_since: null, updated_at: now }).where("driver_id", "=", id).execute();
    await trx.insertInto("timers").values({ kind: "withdraw_driver_offers", ref_id: id, due_at: now, payload: JSON.stringify({}) }).onConflict((c) => c.columns(["kind", "ref_id"]).doUpdateSet({ due_at: now })).execute();
  }
  const ended = await trx.updateTable("auth_sessions").set({ revoked_at: now, revoked_reason: "account_closed" }).where("actor", "=", kind).where("subject_id", "=", id).where("revoked_at", "is", null).returning("session_id").execute();
  // S4c fix 3 (session check cache): the closed account is refused at once on every server copy.
  await sessionsRevoked(trx, ended.map((r) => r.session_id));
  await trx.deleteFrom("push_devices").where("actor", "=", kind).where("subject_id", "=", id).execute();
  return answer(now, setting);
}

function answer(at: Date, setting: Setting) {
  return { status: "requested" as const, requestedAt: at.toISOString(), eraseDueAt: new Date(at.getTime() + setting.eraseAfterDays * DAY_MS).toISOString() };
}

/** True while the account asked to be deleted and is not erased yet (sign-in and refresh refuse it). */
export function isClosed(row: { deletion_requested_at?: Date | null; erased_at?: Date | null }): boolean {
  return !!row.deletion_requested_at && !row.erased_at;
}

type Due = { kind: Kind; id: string; requestedAt: Date; country: string | null };

const TERMINAL_LIST = [...TERMINAL] as string[];

async function dueAccounts(ex: Executor, now: Date, limit: number): Promise<Due[]> {
  // Due at the shortest period (30 days); a longer per-country period is checked per account below. Review MUST-FIX 3:
  // accounts blocked by an open trip or an open safety case are left out in SQL, so they never fill the batch.
  const cut = new Date(now.getTime() - 30 * DAY_MS);
  const riders = await sql<{ id: string; deletion_requested_at: Date }>`
    SELECT r.rider_id AS id, r.deletion_requested_at FROM riders r
    WHERE r.deletion_requested_at <= ${cut} AND r.erased_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM trips t WHERE t.rider_id = r.rider_id AND NOT (t.status = ANY(${TERMINAL_LIST})))
      AND NOT EXISTS (SELECT 1 FROM incidents i WHERE i.rider_id = r.rider_id AND i.status IN ('open', 'investigating'))
    ORDER BY r.deletion_requested_at LIMIT ${limit}`.execute(ex);
  const drivers = await sql<{ id: string; deletion_requested_at: Date; country: string | null }>`
    SELECT d.driver_id AS id, d.deletion_requested_at, d.country FROM drivers d
    WHERE d.deletion_requested_at <= ${cut} AND d.erased_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM trips t WHERE t.driver_id = d.driver_id AND NOT (t.status = ANY(${TERMINAL_LIST})))
      AND NOT EXISTS (SELECT 1 FROM incidents i WHERE i.driver_id = d.driver_id AND i.status IN ('open', 'investigating'))
    ORDER BY d.deletion_requested_at LIMIT ${limit}`.execute(ex);
  return [
    ...riders.rows.map((r) => ({ kind: "rider" as const, id: r.id, requestedAt: r.deletion_requested_at, country: null })),
    ...drivers.rows.map((d) => ({ kind: "driver" as const, id: d.id, requestedAt: d.deletion_requested_at, country: d.country })),
  ];
}

async function waitingReason(ex: Executor, a: Due, now: Date, setting: Setting): Promise<"erase_off" | "open_trip" | "open_safety_case" | "not_due" | null> {
  if (a.requestedAt.getTime() + setting.eraseAfterDays * DAY_MS > now.getTime()) return "not_due";
  if (await hasOpenTrip(ex, a.kind, a.id)) return "open_trip";
  const open = await ex.selectFrom("incidents").select("incident_id").where(a.kind === "rider" ? "rider_id" : "driver_id", "=", a.id).where("status", "in", ["open", "investigating"]).limit(1).executeTakeFirst();
  if (open) return "open_safety_case";
  return setting.eraseEnabled ? null : "erase_off";
}

/** Deletes the rows that hang off one account and empties its row in place (the id stays: money rows point at it). */
async function eraseOne(trx: Trx, a: Due, now: Date): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const run = async (name: string, q: { execute: (ex: Executor) => Promise<{ numAffectedRows?: bigint }> }) => {
    counts[name] = Number((await q.execute(trx)).numAffectedRows ?? 0n);
  };
  const sessions = sql`SELECT session_id FROM auth_sessions WHERE actor = ${a.kind} AND subject_id = ${a.id}`;
  await run("refresh_tokens", sql`DELETE FROM refresh_tokens WHERE session_id IN (${sessions})`);
  // S4c fix 3 (session check cache): a deleted session row is forgotten at once on every server copy.
  const gone = await sql<{ session_id: string }>`DELETE FROM auth_sessions WHERE actor = ${a.kind} AND subject_id = ${a.id} RETURNING session_id`.execute(trx);
  counts["auth_sessions"] = gone.rows.length;
  await sessionsRevoked(trx, gone.rows.map((r) => r.session_id));
  await run("push_devices", sql`DELETE FROM push_devices WHERE actor = ${a.kind} AND subject_id = ${a.id}`);
  await run("notifications", sql`DELETE FROM notifications WHERE audience = ${a.kind} AND subject_id = ${a.id}`);
  // Review round 3 SHOULD: unused Apple / Google sign-in link tokens of the person's identities (name, e-mail) first.
  await run("auth_link_tokens", sql`DELETE FROM auth_link_tokens WHERE provider_subject IN (SELECT provider_subject FROM auth_provider_links WHERE actor = ${a.kind} AND subject_id = ${a.id}) AND app = ${a.kind}`);
  await run("auth_provider_links", sql`DELETE FROM auth_provider_links WHERE actor = ${a.kind} AND subject_id = ${a.id}`);
  await run("email_changes", sql`DELETE FROM email_changes WHERE actor = ${a.kind} AND subject_id = ${a.id}`);
  await run("account_change_starts", sql`DELETE FROM account_change_starts WHERE actor = ${a.kind} AND subject_id = ${a.id}`);
  // Critical review gap 1: rows found by the number or the e-mail, not the id (sign-in codes, sent SMS, fleet
  // invitations, the sign-in waiting list, outbound notices) go too.
  const me = a.kind === "rider"
    ? await trx.selectFrom("riders").select(["phone", "email"]).where("rider_id", "=", a.id).executeTakeFirstOrThrow()
    : await trx.selectFrom("drivers").select(["phone", "email"]).where("driver_id", "=", a.id).executeTakeFirstOrThrow();
  const addresses = [me.phone, ...(me.email ? [me.email] : [])];
  await run("otp_sessions", sql`DELETE FROM otp_sessions WHERE phone = ${me.phone}`);
  await run("sms_outbox", sql`DELETE FROM sms_outbox WHERE phone = ${me.phone}`);
  await run("fleet_invitations", sql`DELETE FROM fleet_invitations WHERE phone = ${me.phone}`);
  await run("sign_in_waitlist", sql`DELETE FROM sign_in_waitlist WHERE phone = ${me.phone}`);
  await run("outbound_notices", sql`DELETE FROM outbound_notices WHERE to_address IN (${sql.join(addresses)})`);
  const placeholder = `erased-${a.id}`;
  if (a.kind === "rider") {
    await run("rider_places", sql`DELETE FROM rider_places WHERE rider_id = ${a.id}`);
    await run("rider_places_imported", sql`DELETE FROM rider_places_imported WHERE rider_id = ${a.id}`);
    await run("rider_phone_data", sql`DELETE FROM rider_phone_data WHERE rider_id = ${a.id}`);
    await run("rider_favourite_drivers", sql`DELETE FROM rider_favourite_drivers WHERE rider_id = ${a.id}`);
    await trx
      .updateTable("riders")
      .set({ phone: placeholder, first_name: "", email: null, email_verified_at: null, language: null, consents: JSON.stringify({}), moderation_reason: null, last_seen_zone_id: null, erased_at: now, updated_at: now })
      .where("rider_id", "=", a.id)
      .where("erased_at", "is", null)
      .execute();
  } else {
    await run("driver_phone_data", sql`DELETE FROM driver_phone_data WHERE driver_id = ${a.id}`);
    await run("driver_locations", sql`DELETE FROM driver_locations WHERE driver_id = ${a.id}`);
    await run("documents", sql`DELETE FROM documents WHERE driver_id = ${a.id}`);
    // Supervisor MUST: his own cars (no fleet) are anonymised in place, so trips keep their vehicle_id but the plate is
    // freed (unique index vehicles_plate) and make / model / colour go; a fleet's car stays the fleet's, he is only
    // taken off it. If the trip records must show the plate, that is for the lawyer (Rules plan/REMINDERS.md).
    await run("vehicles", sql`UPDATE vehicles SET plate = 'ERASED-' || vehicle_id, make = '', model = '', color = '', status = 'blocked', version = version + 1, updated_at = ${now} WHERE driver_id = ${a.id} AND fleet_id IS NULL`);
    await run("vehicles_fleet", sql`UPDATE vehicles SET driver_id = NULL, version = version + 1, updated_at = ${now} WHERE driver_id = ${a.id} AND fleet_id IS NOT NULL`);
    // Privacy Q2 open (FLAGGED): first_name / last_name stay for the money records (payouts, earnings point at the id).
    await trx
      .updateTable("drivers")
      .set({ phone: placeholder, email: null, email_verified_at: null, date_of_birth: null, home_area: null, offline_note: null, online_status: "offline", online_since: null, erased_at: now, updated_at: now })
      .where("driver_id", "=", a.id)
      .where("erased_at", "is", null)
      .execute();
  }
  return counts;
}

/**
 * The account_erase job: { due, erased }. due = accounts past their period and not blocked (the dry-run count while the
 * switch is off); erased = how many this run erased. Settled debt records go too.
 */
export async function eraseDueAccounts(ex: Executor, now: Date): Promise<{ due: number; erased: number }> {
  let due = 0;
  let erased = 0;
  for (const a of await dueAccounts(ex, now, ERASE_BATCH)) {
    const setting = await deletionSetting(ex, a.country);
    const why = await waitingReason(ex, a, now, setting);
    if (why === "not_due" || why === "open_trip" || why === "open_safety_case") continue;
    due += 1;
    if (why === "erase_off") continue;
    const one = async (trx: Trx) => {
      // Review MUST-FIX 2: a request from before v0.18.134 (riders.deletion_requested_at since 0006) has no debt row yet:
      // it is written now, from the live debt, before anything is emptied; then the amount is brought up to date.
      const who = a.kind === "rider"
        ? await trx.selectFrom("riders").select(["phone", "first_name", sql<string>`''`.as("last_name"), "outstanding_minor", "outstanding_currency"]).where("rider_id", "=", a.id).executeTakeFirstOrThrow()
        : await trx.selectFrom("drivers").select(["phone", "first_name", "last_name", "country"]).where("driver_id", "=", a.id).executeTakeFirstOrThrow();
      await recordDebts(trx, a.kind, a.id, who, now);
      await refreshKeptDebts(trx, a.kind, a.id, now);
      const counts = await eraseOne(trx, a, now);
      await audit(trx, { adminId: null, action: "account.erase", targetType: a.kind, targetId: a.id, detail: { counts }, at: now });
    };
    if (ex.isTransaction) {
      // Inside the timer's transaction: one savepoint per account, so one that fails undoes only itself.
      await sql`SAVEPOINT account_erase_one`.execute(ex);
      try {
        await one(ex as Trx);
        await sql`RELEASE SAVEPOINT account_erase_one`.execute(ex);
        erased += 1;
      } catch (error) {
        await sql`ROLLBACK TO SAVEPOINT account_erase_one`.execute(ex);
        console.warn(JSON.stringify({ msg: "account_erase failed, tried again next run", kind: a.kind, accountId: a.id, error: String(error) }));
      }
    } else {
      try {
        await (ex as unknown as { transaction: () => { execute: (f: (trx: Trx) => Promise<void>) => Promise<void> } }).transaction().execute(one);
        erased += 1;
      } catch (error) {
        // Tried again next run.
        console.warn(JSON.stringify({ msg: "account_erase failed, tried again next run", kind: a.kind, accountId: a.id, error: String(error) }));
      }
    }
  }
  // Erased accounts: their kept debt follows the live debt; a settled one goes (only for erased accounts, so a debt is
  // never dropped while the switch is off or before the erase).
  // Every open record, in pages of 100 in a fixed order. Other money paths (admin trip refunds / fee waivers, a payment
  // in the car) are not hooked: this hourly run brings their records up to date (review nit, noted).
  let after: [string, string] | null = null;
  for (;;) {
    let q = ex.selectFrom("kept_debts").select(["account_kind", "account_id"]).distinct().where("settled_at", "is", null);
    if (after) { const [k, id] = after; q = q.where((eb) => eb.or([eb("account_kind", ">", k as Kind), eb.and([eb("account_kind", "=", k as Kind), eb("account_id", ">", id)])])); }
    const open = await q.orderBy("account_kind").orderBy("account_id").limit(100).execute();
    for (const d of open) await refreshKeptDebts(ex, d.account_kind, d.account_id, now);
    if (open.length < 100) break;
    const last = open[open.length - 1]!;
    after = [last.account_kind, last.account_id];
  }
  await sql`DELETE FROM kept_debts k WHERE k.settled_at IS NOT NULL AND EXISTS (
    SELECT 1 FROM riders r WHERE k.account_kind = 'rider' AND r.rider_id = k.account_id AND r.erased_at IS NOT NULL
    UNION ALL SELECT 1 FROM drivers d WHERE k.account_kind = 'driver' AND d.driver_id = k.account_id AND d.erased_at IS NOT NULL)`.execute(ex);
  return { due, erased };
}

/** GET /admin/deletion-requests: newest first, at most 200; never the phone number. */
export async function deletionRequests(ex: Executor, now: Date) {
  const riders = await ex.selectFrom("riders").select(["rider_id as id", "first_name", "deletion_requested_at", "erased_at", sql<string | null>`null`.as("country")]).where("deletion_requested_at", "is not", null).orderBy("deletion_requested_at", "desc").limit(200).execute();
  const drivers = await ex.selectFrom("drivers").select(["driver_id as id", "first_name", "deletion_requested_at", "erased_at", "country"]).where("deletion_requested_at", "is not", null).orderBy("deletion_requested_at", "desc").limit(200).execute();
  const debts = await ex.selectFrom("kept_debts").select(["account_kind", "account_id", "amount_minor", "currency", "settled_at"]).execute();
  const rows = [...riders.map((r) => ({ ...r, kind: "rider" as const })), ...drivers.map((d) => ({ ...d, kind: "driver" as const }))]
    .sort((x, y) => y.deletion_requested_at!.getTime() - x.deletion_requested_at!.getTime())
    .slice(0, 200);
  const items = [];
  let dueNow = 0;
  for (const r of rows) {
    const setting = await deletionSetting(ex, r.country);
    const a: Due = { kind: r.kind, id: r.id, requestedAt: r.deletion_requested_at!, country: r.country };
    const dueAt = new Date(a.requestedAt.getTime() + setting.eraseAfterDays * DAY_MS);
    const why = r.erased_at ? null : await waitingReason(ex, a, now, setting);
    if (!r.erased_at && (why === null || why === "erase_off")) dueNow += 1;
    const debt = debts.find((d) => d.account_kind === r.kind && d.account_id === r.id);
    items.push({
      accountKind: r.kind,
      accountId: r.id,
      firstName: r.erased_at && r.kind === "rider" ? "" : r.first_name,
      requestedAt: a.requestedAt.toISOString(),
      eraseDueAt: dueAt.toISOString(),
      status: r.erased_at ? "erased" : why === "not_due" ? "requested" : "waiting",
      ...(why && why !== "not_due" ? { waitingReason: why } : {}),
      ...(debt ? { debt: { amount: { amountMinor: Number(debt.amount_minor), currency: debt.currency }, settled: debt.settled_at !== null } } : {}),
      ...(r.erased_at ? { erasedAt: r.erased_at.toISOString() } : {}),
    });
  }
  return { items, dueNow };
}
