import { isTestDriver } from "../drivers/readiness.js";
import { sql } from "kysely";
import { adminCoversZone, type Principal } from "../auth/guard.js";
import type { Executor, Trx } from "../db/db.js";
import { driverView, driverViews, fixView, loadDriver } from "../drivers/service.js";
import { activationBlockers } from "../drivers/readiness.js";
import { onboardingSettings } from "../drivers/onboardingSettings.js";

export { activationBlockers };
import { ApiError, badRequest } from "../http/errors.js";
import { moderationColumns, type ModerationInput } from "../riders/moderation.js";
import { scheduleTimer } from "../jobs/timers.js";
import { markSetOffline } from "../drivers/offlineReason.js";
import { riderView } from "../riders/service.js";
import "../riders/walletSchema.js";
import { withEta } from "../trips/eta.js";
import { TERMINAL, type TripStatus } from "../rules/transitions.js";
import { audit } from "./audit.js";
import { firstPageTotal, totalAfterPage, withTotal } from "./listTotal.js";
import { maskDriverView, maskRiderView } from "./masking.js";

/** Admin lists (contract §7: cursor pages, newest first) and account status changes. */

export const cursorOf = (at: Date, id: string) => Buffer.from(`${at.toISOString()}|${id}`).toString("base64url");
export function readCursor(cursor: string): { at: Date; id: string } {
  const [at, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  if (!at || !id || Number.isNaN(Date.parse(at))) throw badRequest("The cursor is not valid.", "invalid_cursor");
  return { at: new Date(at), id };
}
export const zonesOf = (who: Principal) => (who.zones.includes("*") ? null : who.zones);

export type TripQuery = { cursor?: string; limit: number; status?: string[]; kind?: string; zoneId?: string; categoryId?: string; riderId?: string; driverId?: string; paymentStatus?: string; from?: string; to?: string; q?: string; flagged?: boolean; total?: boolean; scheduledBefore?: string };

export async function listTrips(ex: Executor, who: Principal, input: TripQuery, now: Date = new Date()) {
  let q = ex.selectFrom("trips").selectAll();
  const zones = zonesOf(who);
  if (zones) q = q.where("zone_id", "in", zones.length ? zones : ["-"]);
  if (input.zoneId) q = q.where("zone_id", "=", input.zoneId);
  if (input.status?.length) q = q.where("status", "in", input.status);
  if (input.kind) q = q.where("kind", "=", input.kind as "live" | "scheduled");
  if (input.categoryId) q = q.where("category_id", "=", input.categoryId);
  if (input.riderId) q = q.where("rider_id", "=", input.riderId);
  if (input.driverId) q = q.where("driver_id", "=", input.driverId);
  if (input.paymentStatus) q = q.where("payment_status", "=", input.paymentStatus);
  // v0.18.9 (contract.json#onTrip.adminTrip.new.flag): only the flagged trips (or only the others).
  if (input.flagged === true) q = q.where(sql<boolean>`(admin_flag->>'flagged')::boolean IS TRUE`);
  if (input.flagged === false) q = q.where(sql<boolean>`(admin_flag->>'flagged')::boolean IS NOT TRUE`);
  if (input.from) q = q.where("created_at", ">=", new Date(input.from));
  if (input.to) q = q.where("created_at", "<", new Date(input.to));
  // G34 A2 (contract v0.18.83 adminListFilters.scheduledBefore; owner 2026-11-13 12:24 UTC "Exact contract filter"): a
  // live trip always passes; a booked ride only when its scheduledAt is at or before the value. It only narrows, for the
  // page and the count alike, so the Dashboard's waiting read never reads booked rides that are not due.
  if (input.scheduledBefore) {
    const before = new Date(input.scheduledBefore);
    q = q.where((eb) => eb.or([eb("kind", "<>", "scheduled"), eb("scheduled_at", "<=", before)]));
  }
  if (input.q) {
    // A trip id, or the rider's phone number.
    const text = input.q.trim();
    q = q.where((eb) => eb.or([eb("trip_id", "=", text), eb("rider_id", "in", eb.selectFrom("riders").select("rider_id").where("phone", "like", `%${text.replace(/[%_\\]/g, "")}%`))]));
  }
  // L78-S (v0.18.78 adminListFilters.total): the first page counts the same query, next to the page read.
  const filtered = q;
  if (input.cursor) {
    const c = readCursor(input.cursor);
    q = q.where(sql<boolean>`(created_at, trip_id) < (${c.at}, ${c.id})`);
  }
  const reading = q.orderBy("created_at", "desc").orderBy("trip_id", "desc").limit(input.limit + 1).execute();
  // The page asked first; the count follows it (L78-S, listTotal.ts).
  const counting = firstPageTotal(ex, filtered, input);
  const rows = await reading;
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  // v0.18.7 (contract.json#pickupWaiting.adminLiveRow): a row of a trip going on with a driver carries his position and
  // the live ETA, for the live table's ETA column and map link.
  const liveDrivers = [...new Set(page.filter((r) => r.driver_id && !TERMINAL.has(r.status as TripStatus)).map((r) => r.driver_id!))];
  const fixes = liveDrivers.length ? await ex.selectFrom("driver_locations").selectAll().where("driver_id", "in", liveDrivers).execute() : [];
  const fixOf = new Map(fixes.map((f) => [f.driver_id, f]));
  const items = page.map((r) => {
    const fix = r.driver_id && !TERMINAL.has(r.status as TripStatus) ? fixOf.get(r.driver_id) : undefined;
    const projection = withEta(r, fix, now, "admin");
    return fix ? { ...projection, driverLocation: fixView(fix) } : projection;
  });
  return withTotal({ items, nextCursor: rows.length > input.limit && last ? cursorOf(last.created_at, last.trip_id) : null }, await totalAfterPage(counting));
}

/** Riders have no zone: a zone-limited admin sees only riders with a trip in their zones (P4-6). */
export function riderInZones(zones: string[]) {
  return sql<boolean>`exists (select 1 from trips t where t.rider_id = riders.rider_id and t.zone_id = any(${sql.val(zones.length ? zones : ["-"])}::text[]))`;
}

export async function listRiders(ex: Executor, who: Principal, input: { cursor?: string; limit: number; status?: string; q?: string; total?: boolean }, currency: string) {
  let q = ex.selectFrom("riders").selectAll();
  const zones = zonesOf(who);
  if (zones) q = q.where(riderInZones(zones));
  if (input.status) q = q.where("status", "=", input.status as "active" | "suspended");
  if (input.q) {
    const text = `%${input.q.trim().replace(/[%_\\]/g, "")}%`;
    q = q.where((eb) => eb.or([eb("phone", "like", text), eb("first_name", "ilike", text), eb("rider_id", "=", input.q!.trim())]));
  }
  const filtered = q;
  if (input.cursor) {
    const c = readCursor(input.cursor);
    q = q.where(sql<boolean>`(created_at, rider_id) < (${c.at}, ${c.id})`);
  }
  const reading = q.orderBy("created_at", "desc").orderBy("rider_id", "desc").limit(input.limit + 1).execute();
  // The page asked first; the count follows it (L78-S, listTotal.ts).
  const counting = firstPageTotal(ex, filtered, input);
  const rows = await reading;
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  // v0.18.7 (Q3): what each rider owes per currency, oldest debt first (contract.json#pickupWaiting.debtByCurrency).
  const owed = page.length ? await ex.selectFrom("rider_fees").select(["rider_id", "currency", "amount_minor"]).where("rider_id", "in", page.map((r) => r.rider_id)).where("status", "=", "owed").orderBy("created_at").orderBy("trip_id").execute() : [];
  const byRider = new Map<string, Array<{ amountMinor: number; currency: string }>>();
  for (const fee of owed) {
    const list = byRider.get(fee.rider_id) ?? [];
    const entry = list.find((e) => e.currency === fee.currency);
    if (entry) entry.amountMinor += Number(fee.amount_minor);
    else list.push({ amountMinor: Number(fee.amount_minor), currency: fee.currency });
    byRider.set(fee.rider_id, list);
  }
  const wallets = await riderWallets(ex, page.map((r) => r.rider_id));
  return withTotal({ items: page.map((r) => adminRiderView(r, currency, byRider.get(r.rider_id) ?? [], wallets.get(r.rider_id), who)), nextCursor: rows.length > input.limit && last ? cursorOf(last.created_at, last.rider_id) : null }, await totalAfterPage(counting));
}

type RiderWallets = { balances: Array<{ amountMinor: number; currency: string }>; zoneCurrency: string | null };

/** v0.18.28 (owner Q4): each rider's wallet balances, one per currency, and the currency of his zone. */
export async function riderWallets(ex: Executor, riderIds: string[]): Promise<Map<string, RiderWallets>> {
  const out = new Map<string, RiderWallets>();
  if (!riderIds.length) return out;
  const zones = await ex.selectFrom("riders").leftJoin("zones", "zones.zone_id", "riders.last_seen_zone_id").select(["riders.rider_id", "zones.currency"]).where("riders.rider_id", "in", riderIds).execute();
  for (const z of zones) out.set(z.rider_id, { balances: [], zoneCurrency: z.currency });
  const rows = await ex.selectFrom("rider_wallets").select(["rider_id", "currency", "balance_minor"]).where("rider_id", "in", riderIds).where("balance_minor", "<>", "0").orderBy("currency").execute();
  for (const r of rows) out.get(r.rider_id)?.balances.push({ amountMinor: Number(r.balance_minor), currency: r.currency });
  return out;
}

/**
 * `wallet` is the balance in the currency of the rider's zone (else the first he holds, else `currency`); `wallets`
 * (v0.18.28) lists every non-zero balance, one per currency (owner Q4: never added across currencies).
 */
/* v0.18.54 §76: `who` (the admin) decides whether phone / email come back masked (riders.viewSensitive). */
export function adminRiderView(row: Record<string, unknown>, currency: string, byCurrency: Array<{ amountMinor: number; currency: string }> | undefined, wallets: RiderWallets | undefined, who: Pick<Principal, "perms">) {
  const balances = wallets?.balances ?? [];
  const shown = wallets?.zoneCurrency ?? balances[0]?.currency ?? currency;
  const wallet = balances.find((b) => b.currency === shown)?.amountMinor ?? 0;
  return maskRiderView({ ...riderView(row as never, currency, byCurrency), wallet: { amountMinor: wallet, currency: shown }, wallets: balances, ...(row["deletion_requested_at"] ? { deletionRequestedAt: (row["deletion_requested_at"] as Date).toISOString() } : {}) }, who);
}

export async function listDrivers(ex: Executor, who: Principal, input: { cursor?: string; limit: number; accountStatus?: string[]; onlineStatus?: string[]; zoneId?: string; categoryId?: string; q?: string; total?: boolean }) {
  let q = ex.selectFrom("drivers").selectAll();
  const zones = zonesOf(who);
  if (zones) q = q.where(sql<boolean>`zone_ids && ${sql.val(zones.length ? zones : ["-"])}::text[]`);
  if (input.accountStatus?.length) q = q.where("account_status", "in", input.accountStatus as never);
  if (input.onlineStatus?.length) q = q.where("online_status", "in", input.onlineStatus as never);
  if (input.zoneId) q = q.where(sql<boolean>`${input.zoneId} = ANY(zone_ids)`);
  if (input.categoryId) q = q.where(sql<boolean>`${input.categoryId} = ANY(category_ids)`);
  if (input.q) {
    const text = `%${input.q.trim().replace(/[%_\\]/g, "")}%`;
    q = q.where((eb) => eb.or([eb("phone", "like", text), eb("first_name", "ilike", text), eb("driver_id", "=", input.q!.trim())]));
  }
  const filtered = q;
  if (input.cursor) {
    const c = readCursor(input.cursor);
    q = q.where(sql<boolean>`(created_at, driver_id) < (${c.at}, ${c.id})`);
  }
  const reading = q.orderBy("created_at", "desc").orderBy("driver_id", "desc").limit(input.limit + 1).execute();
  // The page asked first; the count follows it (L78-S, listTotal.ts).
  const counting = firstPageTotal(ex, filtered, input);
  const rows = await reading;
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  const items = [];
  for (const view of await driverViews(ex, page as never, "admin")) items.push(maskDriverView(view, who));
  return withTotal({ items, nextCursor: rows.length > input.limit && last ? cursorOf(last.created_at, last.driver_id) : null }, await totalAfterPage(counting));
}

/** Payments in the cash week: one per paid trip (PaymentIntent, purpose trip). */
export async function listPayments(ex: Executor, who: Principal, input: { cursor?: string; limit: number; status?: string; method?: string; tripId?: string; riderId?: string; zoneId?: string; from?: string; to?: string; total?: boolean }) {
  let q = ex.selectFrom("trips").selectAll().where("payment_status", "is not", null);
  const zones = zonesOf(who);
  if (zones) q = q.where("zone_id", "in", zones.length ? zones : ["-"]);
  if (input.status) q = q.where("payment_status", "=", input.status);
  if (input.method) q = q.where("payment_method", "=", input.method);
  if (input.tripId) q = q.where("trip_id", "=", input.tripId);
  if (input.riderId) q = q.where("rider_id", "=", input.riderId);
  if (input.zoneId) q = q.where("zone_id", "=", input.zoneId);
  if (input.from) q = q.where("updated_at", ">=", new Date(input.from));
  if (input.to) q = q.where("updated_at", "<", new Date(input.to));
  const filtered = q;
  if (input.cursor) {
    const c = readCursor(input.cursor);
    q = q.where(sql<boolean>`(created_at, trip_id) < (${c.at}, ${c.id})`);
  }
  const reading = q.orderBy("created_at", "desc").orderBy("trip_id", "desc").limit(input.limit + 1).execute();
  // The page asked first; the count follows it (L78-S, listTotal.ts).
  const counting = firstPageTotal(ex, filtered, input);
  const rows = await reading;
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return withTotal({
    items: page.map((t) => ({
      paymentId: `pay_${t.trip_id}`,
      tripId: t.trip_id,
      amount: { amountMinor: Number(t.fare_minor), currency: t.currency },
      method: t.payment_method,
      purpose: "trip",
      status: t.payment_status,
      createdAt: (t.ended_at ?? t.updated_at).toISOString(),
      // Cash week: what the driver took and what the wallet paid.
      cashCollected: { amountMinor: Number(t.cash_collected_minor ?? 0), currency: t.currency },
      walletApplied: { amountMinor: Number(t.wallet_applied_minor ?? 0), currency: t.currency },
    })),
    nextCursor: rows.length > input.limit && last ? cursorOf(last.created_at, last.trip_id) : null,
  }, await totalAfterPage(counting));
}

export async function listAudit(ex: Executor, who: Principal, input: { cursor?: string; limit: number; actorId?: string; targetType?: string; targetId?: string; action?: string; from?: string; to?: string }) {
  let q = ex.selectFrom("admin_audit").leftJoin("admins", "admins.admin_id", "admin_audit.admin_id").select(["admin_audit.audit_id", "admin_audit.admin_id", "admin_audit.action", "admin_audit.target_type", "admin_audit.target_id", "admin_audit.zone_id", "admin_audit.detail", "admin_audit.at", "admins.role"]);
  const zones = zonesOf(who);
  if (zones) q = q.where((eb) => eb.or([eb("admin_audit.zone_id", "in", zones.length ? zones : ["-"]), eb("admin_audit.admin_id", "=", who.subjectId)]));
  if (input.actorId) q = q.where("admin_audit.admin_id", "=", input.actorId);
  if (input.targetType) q = q.where("admin_audit.target_type", "=", input.targetType);
  if (input.targetId) q = q.where("admin_audit.target_id", "=", input.targetId);
  if (input.action) q = q.where("admin_audit.action", "=", input.action);
  if (input.from) q = q.where("admin_audit.at", ">=", new Date(input.from));
  if (input.to) q = q.where("admin_audit.at", "<", new Date(input.to));
  if (input.cursor) {
    const c = readCursor(input.cursor);
    if (!/^\d+$/.test(c.id)) throw badRequest("The cursor is not valid.", "invalid_cursor");
    q = q.where(sql<boolean>`(admin_audit.at, admin_audit.audit_id) < (${c.at}, ${c.id}::bigint)`);
  }
  const rows = await q.orderBy("admin_audit.at", "desc").orderBy("admin_audit.audit_id", "desc").limit(input.limit + 1).execute();
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => {
      const detail = (r.detail ?? {}) as Record<string, unknown>;
      return {
        auditId: String(r.audit_id),
        at: r.at.toISOString(),
        actor: r.admin_id ? "admin" : "system",
        actorId: r.admin_id ?? "system",
        ...(r.role ? { actorRole: r.role } : {}),
        action: r.action,
        targetType: r.target_type,
        targetId: r.target_id,
        ...(typeof detail["note"] === "string" ? { reason: detail["note"] } : typeof detail["reason"] === "string" ? { reason: detail["reason"] } : {}),
        result: r.action.endsWith(".requested") ? "pending_approval" : "committed",
        after: detail,
        requestId: String(r.audit_id),
      };
    }),
    nextCursor: rows.length > input.limit && last ? cursorOf(last.at, String(last.audit_id)) : null,
  };
}

/* ---------------------------------------------------------------- account status */

export async function setDriverStatus(trx: Trx, who: Principal, driverId: string, body: { expectedVersion: number; accountStatus: "pending" | "active" | "on_hold" | "suspended"; note: string }, now: Date) {
  const row = await loadDriver(trx, driverId, true);
  if (!row.zone_ids.some((z) => adminCoversZone(who, z)) && !who.zones.includes("*")) throw new ApiError("forbidden", "This driver is outside your zones.", { reason: "zone_out_of_scope" });
  if (row.version !== body.expectedVersion) throw new ApiError("version_mismatch", "The driver changed since you last saw them.", { projection: maskDriverView(await driverView(trx, row, "admin", now), who) });
  if (body.accountStatus === "active" && row.account_status !== "active") {
    // Deep fix 2026-11-02 (g1-g3 M4): a driver who never sent his details (no country, no name) cannot be activated.
    if (row.country === null && !(await isTestDriver(trx, driverId))) {
      throw new ApiError("invalid_transition", "The driver has not sent his details yet.", { reason: "details_missing", projection: maskDriverView(await driverView(trx, row, "admin", now), who) });
    }
    const missing = await activationBlockers(trx, row, now);
    if (missing.length > 0) throw new ApiError("documents_not_approved", "The driver's required documents are not all approved.", { details: missing });
    // G30 v0.18.76 (contract.json#emailVerified.approvalSetting, owner Q6 + S3): with the country's setting on, a driver
    // who was never active needs a verified e-mail; re-activating a once-active driver is not checked.
    if (row.first_activated_at == null && row.email_verified_at == null && (await onboardingSettings(trx, row.country)).emailVerifiedForApproval === true) {
      throw new ApiError("invalid_transition", "The driver's e-mail is not verified yet.", { reason: "email_not_verified", projection: maskDriverView(await driverView(trx, row, "admin", now), who) });
    }
  }
  const blocked = body.accountStatus !== "active";
  // A blocked driver goes offline (one on a trip keeps it to the end) and loses their open offers.
  const online = blocked && ["online", "going_online"].includes(row.online_status) ? { online_status: "offline" as const, online_since: null } : {};
  // G30 (emailVerified.neverActive): the first time he becomes active is recorded once, never cleared.
  const firstActive = body.accountStatus === "active" && row.first_activated_at == null ? { first_activated_at: now } : {};
  await trx.updateTable("drivers").set({ account_status: body.accountStatus, ...online, ...firstActive, version: row.version + 1, updated_at: now }).where("driver_id", "=", driverId).execute();
  if (blocked) await scheduleTimer(trx, { kind: "withdraw_driver_offers", refId: driverId, dueAt: now, payload: {} });
  // v0.18.6 (owner "Send the real reason"): account_status.
  if ("online_status" in online) await markSetOffline(trx, driverId, "account_status", {}, now);
  await audit(trx, { adminId: who.subjectId, action: "driver.status", targetType: "driver", targetId: driverId, zoneId: row.zone_ids[0] ?? null, detail: { from: row.account_status, to: body.accountStatus, note: body.note }, at: now });
  return maskDriverView(await driverView(trx, await loadDriver(trx, driverId), "admin", now), who);
}

export async function setRiderStatus(trx: Trx, who: Principal, riderId: string, body: { expectedVersion: number; status: "active" | "suspended"; note: string }, currency: string, now: Date) {
  const row = await trx.selectFrom("riders").selectAll().where("rider_id", "=", riderId).forUpdate().executeTakeFirst();
  if (!row) throw new ApiError("not_found", "No such rider.", { reason: "rider_not_found" });
  const zones = zonesOf(who);
  if (zones) {
    const seen = await trx.selectFrom("riders").select("rider_id").where("rider_id", "=", riderId).where(riderInZones(zones)).executeTakeFirst();
    if (!seen) throw new ApiError("forbidden", "This rider has not ridden in your zones.", { reason: "zone_out_of_scope" });
  }
  if (row.version !== body.expectedVersion) throw new ApiError("version_mismatch", "The rider changed since you last saw them.", { projection: adminRiderView(row, currency, undefined, (await riderWallets(trx, [riderId])).get(riderId), who) });
  // A suspended rider cannot book; a ride already going runs to its end. v0.18.39 A2: active = level none,
  // suspended = banned with the note as reason (contract.json#riderModeration.statusCommand).
  const level = moderationColumns({ level: body.status === "active" ? "none" : "banned", reason: body.note }, now);
  await trx.updateTable("riders").set({ ...level, version: row.version + 1, updated_at: now }).where("rider_id", "=", riderId).execute();
  await audit(trx, { adminId: who.subjectId, action: "rider.status", targetType: "rider", targetId: riderId, detail: { from: row.status, to: body.status, note: body.note }, at: now });
  return adminRiderView((await trx.selectFrom("riders").selectAll().where("rider_id", "=", riderId).executeTakeFirstOrThrow()), currency, undefined, (await riderWallets(trx, [riderId])).get(riderId), who);
}

/** v0.18.39 A2 (owner G16 Q16-2, contract.json#riderModeration): Warn → Pause → Ban with a reason; none undoes it. */
export async function moderateRider(trx: Trx, who: Principal, riderId: string, body: ModerationInput, currency: string, now: Date) {
  const row = await trx.selectFrom("riders").selectAll().where("rider_id", "=", riderId).forUpdate().executeTakeFirst();
  if (!row) throw new ApiError("not_found", "No such rider.", { reason: "rider_not_found" });
  const zones = zonesOf(who);
  if (zones) {
    const seen = await trx.selectFrom("riders").select("rider_id").where("rider_id", "=", riderId).where(riderInZones(zones)).executeTakeFirst();
    if (!seen) throw new ApiError("forbidden", "This rider has not ridden in your zones.", { reason: "zone_out_of_scope" });
  }
  if (row.version !== body.expectedVersion) throw new ApiError("version_mismatch", "The rider changed since you last saw them.", { projection: adminRiderView(row, currency, undefined, (await riderWallets(trx, [riderId])).get(riderId), who) });
  const columns = moderationColumns(body, now);
  await trx.updateTable("riders").set({ ...columns, version: row.version + 1, updated_at: now }).where("rider_id", "=", riderId).execute();
  await audit(trx, {
    adminId: who.subjectId, action: "rider.moderation", targetType: "rider", targetId: riderId,
    detail: { from: row.moderation_level, to: body.level, reason: body.reason, ...(body.pauseDays !== undefined ? { pauseDays: body.pauseDays } : {}), until: columns.moderation_until?.toISOString() ?? null }, at: now,
  });
  return adminRiderView((await trx.selectFrom("riders").selectAll().where("rider_id", "=", riderId).executeTakeFirstOrThrow()), currency, undefined, (await riderWallets(trx, [riderId])).get(riderId), who);
}
