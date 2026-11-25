import { CURRENCY_CODES, exponentOf, moneyText, toMajorNumber, type CurrencyCode } from "../rules/money.js";
import { sql } from "kysely";
import type { Db, Executor, Trx } from "../db/db.js";
import { scheduleTimer, type TimerHandler, MAX_ATTEMPTS } from "../jobs/timers.js";
import "./schema.js";
import { LANE_LATE_LIMITS, LOUD_PARKED_KINDS } from "../jobs/parkedKinds.js";
import { OTHER_HOME, callingCodeOfPhone, nearCap, otherSmsLastDay, servedCountries, callingCodeOf, smsLastMinute, signInSmsLastDay, smsSignInFor, smsSignInOtherFor } from "../auth/smsSignIn.js";
import { serverStripeStatus, type StripeOffReason } from "../payments/stripeKeys.js";
import { AlertSettings, hhmm, levelFor, METRIC_UNITS, render, rulesOf, SWEEP_MS, type Level, type Text } from "./kinds.js";

/**
 * v0.18.23 server-side alerts (contract.json#alertDesk.serverDetection; owner 2026-11-04 A1 per-zone at-risk minutes,
 * A2 solved-by-itself turns green with new info, A3 custom rules checked by the server 24/7). Alerts are SERVER-CREATED
 * only: one sweep finds every cause from the server's own data, then makes the stored alerts match:
 *   new cause            → a new open alert (since = now, never a made-up time);
 *   cause still there    → level / title / detail follow the numbers (since stays);
 *   cause gone           → solved, with what happened ("Driver Ali took it 17:48"), until an admin marks it done;
 *   solved cause back    → the same alert is open again;
 *   closed (done) alert  → no new alert while its cause is still there.
 * The sweep runs on the timer worker every 30 s (one instance at a time) and at once after key events (pokeAlerts).
 * Running it twice changes nothing.
 */

export const ALERT_SWEEP = "alert_sweep";

type Ref = { tripId?: string; driverId?: string; riderId?: string; incidentId?: string; ticketId?: string; payoutId?: string; refundId?: string; ruleId?: string; documentId?: string; vehicleId?: string };
/** oldSince (v0.18.31, owner Q-Bj): an SOS / safety alert whose trip ended more than OLD_AFTER_MS ago — kept open, listed as old. */
export type Cause = { key: string; kind: string; country: string; zoneId: string | null; level: Level; title: Text; detail?: Text; ref: Ref; oldSince?: Date };
type Zone = { zone_id: string; country: string; time_zone: string; name: string };

type Ctx = {
  ex: Executor;
  now: Date;
  zones: Map<string, Zone>;
  settings: Map<string, AlertSettings>;
  rules: Map<string, ReturnType<typeof rulesOf>>;
};

const MIN = 60_000;
const DAY = 86_400_000;
/** v0.18.31 contract.json#alertsOldList.oldAfterHours: an SOS / safety case moves to the Old list 24 h after its trip ended. */
export const OLD_AFTER_MS = 24 * 3600_000;
/** A trip that has ended (contract TripStatus terminal set, or its end time set). */
const TRIP_ENDED_SQL = sql`(t.ended_at IS NOT NULL OR t.status IN ('completed', 'no_show', 'expired') OR t.status LIKE 'cancelled%')`;
const TRIGGER_LABEL: Record<string, string> = { far: "Dropped far away", stop: "Long stop", route: "Off the route", longer: "Longer than expected", crash: "Possible crash", help: "Asked for help", sos: "SOS" };

/** Key order does not count (jsonb stores keys in its own order). */
const stable = (v: unknown) => JSON.stringify(Object.fromEntries(Object.entries((v ?? {}) as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))));
const T = (t: string, a: (string | number)[] = [], x?: number[]): Text => (x ? { t, a, x } : { t, a });
const settingsOf = (ctx: Ctx, country: string) => ctx.settings.get(country) ?? new AlertSettings({});
const countryOf = (ctx: Ctx, zoneId: string | null | undefined, fallback = "SE") => (zoneId ? ctx.zones.get(zoneId)?.country : undefined) ?? fallback;
const zoneName = (ctx: Ctx, zoneId: string | null | undefined) => (zoneId ? ctx.zones.get(zoneId)?.name ?? zoneId : "");
const tz = (ctx: Ctx, zoneId: string | null | undefined) => (zoneId ? ctx.zones.get(zoneId)?.time_zone : undefined) ?? "Europe/Stockholm";
const minutesBetween = (from: Date, to: Date) => Math.max(0, Math.floor((to.getTime() - from.getTime()) / MIN));
const name = (first: string | null | undefined, fallback: string) => (first && first.trim() ? first.trim() : fallback);

/* ------------------------------------------------------------------ causes, one function per group of kinds */

async function safetyCauses(ctx: Ctx): Promise<Cause[]> {
  const rows = await sql<{ incident_id: string; kind: string; zone_id: string | null; raised_by: string; taken_at: Date | null; status: string; alarm: boolean; trip_id: string | null; trigger: string | null; rider: string | null; driver: string | null; driver_id: string | null; trip_ended: boolean | null; trip_ended_at: Date | null }>`
    SELECT ${TRIP_ENDED_SQL} AS trip_ended, CASE WHEN ${TRIP_ENDED_SQL} THEN coalesce(t.ended_at, t.updated_at) END AS trip_ended_at,
           i.incident_id, i.kind, i.zone_id, i.raised_by, i.taken_at, i.status, i.alarm, i.trip_id, i.driver_id,
           i.ride_check->>'trigger' AS trigger, r.first_name AS rider, d.first_name AS driver
      FROM incidents i LEFT JOIN riders r ON r.rider_id = i.rider_id LEFT JOIN drivers d ON d.driver_id = i.driver_id
                       LEFT JOIN trips t ON t.trip_id = i.trip_id
     WHERE i.status IN ('open', 'investigating') AND i.kind IN ('sos', 'driver_silent', 'ride_check')`.execute(ctx.ex);
  const out: Cause[] = [];
  for (const r of rows.rows) {
    const country = countryOf(ctx, r.zone_id);
    const s = settingsOf(ctx, country);
    const ref: Ref = { incidentId: r.incident_id, ...(r.trip_id ? { tripId: r.trip_id } : {}), ...(r.driver_id ? { driverId: r.driver_id } : {}) };
    const detail = T("{0} · {1}", [zoneName(ctx, r.zone_id), r.incident_id]);
    // Owner Q-Bj: SOS / safety cases never close by themselves; 24 h after the trip ended they move to the Old list.
    const oldAt = r.trip_ended && r.trip_ended_at ? new Date(r.trip_ended_at.getTime() + OLD_AFTER_MS) : null;
    const old = oldAt && oldAt.getTime() <= ctx.now.getTime() ? { oldSince: oldAt } : {};
    const who = r.raised_by === "rider" ? name(r.rider, "Rider") : r.raised_by === "driver" ? name(r.driver, "Driver") : name(r.driver, "Driver");
    if (r.kind === "sos") {
      if (s.kind("sos").on) out.push({ key: `sos:${r.incident_id}`, kind: "sos", country, zoneId: r.zone_id, level: s.kind("sos").level, title: T("SOS from {0}", [who]), detail, ref, ...old });
      const slow = s.kind("sos_slow");
      if (slow.on && r.taken_at) {
        const minutes = minutesBetween(r.taken_at, ctx.now);
        const level = levelFor(minutes, slow.limits, "up");
        if (level) out.push({ key: `sos_slow:${r.incident_id}`, kind: "sos_slow", country, zoneId: r.zone_id, level, title: T("SOS from {0} not solved after {1} min", [who, minutes]), detail, ref, ...old });
      }
    } else if (r.kind === "driver_silent") {
      if (s.kind("car_lost").on) out.push({ key: `car_lost:${r.incident_id}`, kind: "car_lost", country, zoneId: r.zone_id, level: s.kind("car_lost").level, title: T("Car lost: {0}", [name(r.driver, "Driver")]), detail, ref, ...old });
    } else if (r.alarm && !r.trip_ended && s.kind("ride_check").on) {
      // B-j/P20: a ride check is about a ride in progress; once its trip ended the alert is solved by itself (green, kept).
      const label = TRIGGER_LABEL[r.trigger ?? ""] ?? "Asked for help";
      out.push({ key: `ride_check:${r.incident_id}`, kind: "ride_check", country, zoneId: r.zone_id, level: s.kind("ride_check").level, title: T("Ride check: {0}", [label], [0]), detail, ref });
    }
  }
  return out;
}

async function dispatchCauses(ctx: Ctx): Promise<Cause[]> {
  const out: Cause[] = [];
  const waiting = await sql<{ trip_id: string; zone_id: string; rider: string | null; rider_id: string; started: Date; step: string | null }>`
    SELECT t.trip_id, t.zone_id, t.rider_id, r.first_name AS rider, coalesce(t.search_started_at, t.created_at) AS started, t.search_step->>'kind' AS step
      FROM trips t JOIN riders r ON r.rider_id = t.rider_id
     WHERE t.kind = 'live' AND t.driver_id IS NULL AND t.status IN ('requested', 'searching', 'offered')`.execute(ctx.ex);
  // Owner 2026-11-04: a zone's free drivers are counted by their LIVE position (the zone of their latest fix,
  // driver_locations.zone_id), never their first or home zone; a driver with no position counts nowhere.
  const free = await sql<{ zone_id: string; n: string }>`
    SELECT l.zone_id, count(*) AS n FROM drivers d JOIN driver_locations l ON l.driver_id = d.driver_id
     WHERE d.online_status = 'online' AND d.account_status = 'active' AND l.zone_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM trips t WHERE t.driver_id = d.driver_id AND t.status IN ('accepted', 'driver_to_pickup', 'arrived', 'rider_onboard', 'in_trip', 'approaching_dropoff')
                         AND NOT (t.kind = 'scheduled' AND t.status = 'accepted' AND coalesce(t.reservation->>'held', 'false') = 'true'))
     GROUP BY 1`.execute(ctx.ex);
  const freeBy = new Map(free.rows.map((r) => [r.zone_id, Number(r.n)]));
  // Checker MED 4: one count per zone, not a filter over every waiting trip per zone.
  const waitingBy = new Map<string, number>();
  for (const w of waiting.rows) waitingBy.set(w.zone_id, (waitingBy.get(w.zone_id) ?? 0) + 1);
  for (const w of waiting.rows) {
    const country = countryOf(ctx, w.zone_id);
    const s = settingsOf(ctx, country);
    const minutes = minutesBetween(w.started, ctx.now);
    // v0.18.39 §63 (N2): the rider was shown "No driver nearby" (searchStep no_driver_nearby), at the same moment.
    const nd = s.kind("no_driver_nearby");
    if (nd.on && w.step === "no_driver_nearby") out.push({ key: `no_driver_nearby:${w.trip_id}`, kind: "no_driver_nearby", country, zoneId: w.zone_id, level: nd.level, title: T("{0} has no driver nearby ({1} min)", [name(w.rider, "Rider"), minutes]), detail: T("{0} · {1}", [zoneName(ctx, w.zone_id), w.trip_id]), ref: { tripId: w.trip_id, riderId: w.rider_id } });
    const k = s.kind("long_wait");
    if (!k.on) continue;
    // Owner A1: Important from the zone's live at-risk minutes; Critical from the kind's own limit.
    const level = levelFor(minutes, { info: null, important: s.zone(w.zone_id).liveAtRiskMin, critical: k.limits.critical }, "up");
    if (level) out.push({ key: `long_wait:${w.trip_id}`, kind: "long_wait", country, zoneId: w.zone_id, level, title: T("{0} has waited {1} min", [name(w.rider, "Rider"), minutes]), detail: T("{0} · {1}", [zoneName(ctx, w.zone_id), w.trip_id]), ref: { tripId: w.trip_id, riderId: w.rider_id } });
  }
  for (const zone of ctx.zones.values()) {
    const s = settingsOf(ctx, zone.country);
    const z = s.zone(zone.zone_id);
    const riders = waitingBy.get(zone.zone_id) ?? 0;
    const freeHere = freeBy.get(zone.zone_id) ?? 0;
    const few = s.kind("few_drivers");
    // G3-D5: only when riders really wait and the free drivers are short.
    if (few.on && freeHere <= z.fewDriversLimit && riders > freeHere) {
      out.push({ key: `few_drivers:${zone.zone_id}`, kind: "few_drivers", country: zone.country, zoneId: zone.zone_id, level: few.level, title: freeHere === 1 ? T("Only 1 free driver in {0}", [zone.name]) : T("Only {0} free drivers in {1}", [freeHere, zone.name]), detail: T("Limit {0}", [z.fewDriversLimit]), ref: {} });
    }
    const none = s.kind("no_driver");
    if (none.on && riders >= z.noDriverLimit) {
      out.push({ key: `no_driver:${zone.zone_id}`, kind: "no_driver", country: zone.country, zoneId: zone.zone_id, level: none.level, title: T("{0} requests without a driver in {1}", [riders, zone.name]), detail: T("Limit {0}", [z.noDriverLimit]), ref: {} });
    }
  }
  return out;
}

async function bookedCauses(ctx: Ctx): Promise<Cause[]> {
  const out: Cause[] = [];
  const rows = await sql<{ trip_id: string; zone_id: string; status: string; driver_id: string | null; scheduled_at: Date; rider: string | null; rider_id: string; driver: string | null; leave_at: string | null; held: string | null; taken_from: string | null; taken_name: string | null }>`
    SELECT t.trip_id, t.zone_id, t.status, t.driver_id, t.scheduled_at, t.rider_id, r.first_name AS rider, d.first_name AS driver,
           t.reservation->>'leaveAt' AS leave_at, t.reservation->>'held' AS held,
           t.reservation->'takenBack'->>'driverId' AS taken_from, tb.first_name AS taken_name
      FROM trips t JOIN riders r ON r.rider_id = t.rider_id LEFT JOIN drivers d ON d.driver_id = t.driver_id
      LEFT JOIN drivers tb ON tb.driver_id = t.reservation->'takenBack'->>'driverId'
     WHERE t.kind = 'scheduled' AND t.scheduled_at IS NOT NULL AND t.scheduled_at <= ${new Date(ctx.now.getTime() + 4 * 3600_000)}
       AND t.status IN ('requested', 'searching', 'offered', 'accepted')`.execute(ctx.ex);
  // v0.18.39 §63 (P17): booked rides the server ended with no driver found, for 24 h (or until an admin marks it done).
  const ended = await sql<{ trip_id: string; zone_id: string; rider_id: string; rider: string | null; scheduled_at: Date }>`
    SELECT t.trip_id, t.zone_id, t.rider_id, r.first_name AS rider, t.scheduled_at
      FROM trips t JOIN riders r ON r.rider_id = t.rider_id
     WHERE t.kind = 'scheduled' AND t.status = 'expired' AND t.scheduled_at IS NOT NULL AND t.reservation->>'noDriverFound' = 'true'
       AND t.ended_at > ${new Date(ctx.now.getTime() - 24 * 3600_000)}`.execute(ctx.ex);
  for (const t of ended.rows) {
    const country = countryOf(ctx, t.zone_id);
    const k = settingsOf(ctx, country).kind("booked_no_driver_ended");
    if (k.on) out.push({ key: `booked_no_driver_ended:${t.trip_id}`, kind: "booked_no_driver_ended", country, zoneId: t.zone_id, level: k.level, title: T("{0}'s booked ride at {1} ended: no driver found", [name(t.rider, "Rider"), hhmm(t.scheduled_at, tz(ctx, t.zone_id))]), detail: T("{0} · {1}", [zoneName(ctx, t.zone_id), t.trip_id]), ref: { tripId: t.trip_id, riderId: t.rider_id } });
  }
  for (const t of rows.rows) {
    const country = countryOf(ctx, t.zone_id);
    const s = settingsOf(ctx, country);
    const time = hhmm(t.scheduled_at, tz(ctx, t.zone_id));
    const rider = name(t.rider, "Rider");
    const detail = T("{0} · {1}", [zoneName(ctx, t.zone_id), t.trip_id]);
    const ref: Ref = { tripId: t.trip_id, riderId: t.rider_id, ...(t.driver_id ? { driverId: t.driver_id } : {}) };
    const left = Math.ceil((t.scheduled_at.getTime() - ctx.now.getTime()) / MIN);
    if (!t.driver_id) {
      // v0.18.35 job 4 (contract.json#bookedTakeBack.alert): taken back from a late driver, no new driver yet.
      const taken = s.kind("booked_taken_back");
      if (t.taken_from && taken.on) out.push({ key: `booked_taken_back:${t.trip_id}`, kind: "booked_taken_back", country, zoneId: t.zone_id, level: taken.level, title: T("{0}'s booked ride at {1} was taken from {2} (late)", [rider, time, name(t.taken_name, "Driver")]), detail, ref: { ...ref, driverId: t.taken_from } });
      if (left <= 0) {
        const k = s.kind("booked_late");
        if (k.on) out.push({ key: `booked_late:${t.trip_id}`, kind: "booked_late", country, zoneId: t.zone_id, level: k.level, title: T("{0}'s booked ride: pickup time {1} passed, no driver", [rider, time]), detail, ref });
        continue;
      }
      const risk = s.kind("booked_at_risk");
      // Owner A1: at risk = no driver bookedAtRiskMin minutes (zone setting, default 15) or less before pickup.
      if (risk.on && left <= s.zone(t.zone_id).bookedAtRiskMin) {
        out.push({ key: `booked_at_risk:${t.trip_id}`, kind: "booked_at_risk", country, zoneId: t.zone_id, level: risk.level, title: T("{0}'s booked ride at {1} has no driver ({2} min left)", [rider, time, left]), detail, ref });
        continue;
      }
      const late = s.kind("late_reservation");
      const level = late.on ? levelFor(left, late.limits, "down") : null;
      if (level) out.push({ key: `late_reservation:${t.trip_id}`, kind: "late_reservation", country, zoneId: t.zone_id, level, title: T("{0}'s booked ride in {1} min has no driver", [rider, left]), detail, ref });
      continue;
    }
    // A driver holds it: not started once its leave time (else the pickup time) passed.
    const leaveAt = t.leave_at ? new Date(t.leave_at) : t.scheduled_at;
    const k = s.kind("booked_not_started");
    if (k.on && t.status === "accepted" && t.held !== "false" && leaveAt.getTime() <= ctx.now.getTime()) {
      out.push({ key: `booked_not_started:${t.trip_id}`, kind: "booked_not_started", country, zoneId: t.zone_id, level: k.level, title: T("{0} has not started {1}'s booked ride at {2}", [name(t.driver, "Driver"), rider, time]), detail, ref });
    }
  }
  return out;
}

/**
 * Sup1 P10 (G34 proof: every sweep sent ALL documents (21,579 at 2k) and ALL pending payouts (41,428) to Node): the SQL now
 * keeps only rows that can reach a level under ANY country's settings (and the defaults). Node still checks each row
 * against its own country's limits exactly as before, so the alerts are the same; only rows that never alert stay home.
 */
function allSettings(ctx: Ctx): AlertSettings[] {
  return [new AlertSettings({}), ...ctx.settings.values()];
}
/** The largest doc_expiring limit (days) of any country that has the kind on; 400 (the old fixed window) at most. */
export function docHorizonDays(ctx: Ctx): number | null {
  const days = allSettings(ctx).map((s) => s.kind("doc_expiring")).filter((k) => k.on).flatMap((k) => [k.limits.info, k.limits.important, k.limits.critical]).filter((v): v is number => typeof v === "number");
  return days.length === 0 ? null : Math.min(400, Math.max(...days) + 1);
}
/** The smallest payout_big limit of any country with the kind on, as the lowest minor amount over every currency (right for negative limits too): a lower bound. */
export function payoutFloorMinor(ctx: Ctx): number | bigint | null {
  const limits = allSettings(ctx).map((s) => s.kind("payout_big")).filter((k) => k.on).flatMap((k) => [k.limits.info, k.limits.important, k.limits.critical]).filter((v): v is number => typeof v === "number");
  if (limits.length === 0) return null;
  // The lowest bound over every currency: for a negative limit the currency with the MOST decimals reads lowest.
  const floor = Math.min(...CURRENCY_CODES.map((c) => Math.floor(Math.min(...limits) * 10 ** exponentOf(c))));
  // The settings document is free JSON: a limit Postgres bigint cannot read (e.g. -1e17) would stop the whole sweep.
  return floor < Number.MIN_SAFE_INTEGER ? -(2n ** 63n) : floor;
}

async function driverCauses(ctx: Ctx): Promise<Cause[]> {
  const out: Cause[] = [];
  const horizon = docHorizonDays(ctx);
  const docs = horizon === null ? { rows: [] } : await sql<{ document_id: string; driver_id: string; type: string; expires_at: Date; first_name: string; zone_id: string | null; country: string | null }>`
    SELECT doc.document_id, doc.driver_id, doc.type, doc.expires_at, d.first_name, d.zone_ids[1] AS zone_id, d.country
      FROM documents doc JOIN drivers d ON d.driver_id = doc.driver_id
     WHERE doc.status IN ('approved', 'expired') AND doc.expires_at IS NOT NULL AND d.account_status IN ('active', 'on_hold')
       AND doc.expires_at <= ${new Date(ctx.now.getTime() + horizon * DAY)}`.execute(ctx.ex);
  for (const d of docs.rows) {
    const country = countryOf(ctx, d.zone_id, d.country ?? "SE");
    const k = settingsOf(ctx, country).kind("doc_expiring");
    if (!k.on) continue;
    const days = Math.floor((d.expires_at.getTime() - ctx.now.getTime()) / DAY);
    const level = levelFor(days, k.limits, "down");
    const docName = d.type.replace(/_/g, " ");
    if (level) out.push({ key: `doc_expiring:${d.driver_id}:${d.type}`, kind: "doc_expiring", country, zoneId: d.zone_id, level, title: days <= 0 ? T("{0}: {1} has expired", [name(d.first_name, "Driver"), docName], [1]) : days === 1 ? T("{0}: {1} expires in 1 day", [name(d.first_name, "Driver"), docName], [1]) : T("{0}: {1} expires in {2} days", [name(d.first_name, "Driver"), docName, days], [1]), ref: { driverId: d.driver_id, documentId: d.document_id } });
  }
  const rated = await sql<{ driver_id: string; first_name: string; zone_id: string | null; country: string | null; rating: number }>`
    SELECT driver_id, first_name, zone_ids[1] AS zone_id, country, rating_sum::float / rating_count AS rating
      FROM drivers WHERE account_status = 'active' AND rating_count > 0`.execute(ctx.ex);
  for (const d of rated.rows) {
    const country = countryOf(ctx, d.zone_id, d.country ?? "SE");
    const k = settingsOf(ctx, country).kind("low_rating");
    const rating = Math.round(Number(d.rating) * 10) / 10;
    const level = k.on ? levelFor(rating, k.limits, "down") : null;
    if (level) out.push({ key: `low_rating:${d.driver_id}`, kind: "low_rating", country, zoneId: d.zone_id, level, title: T("{0} has a {1} rating", [name(d.first_name, "Driver"), rating.toFixed(1)]), detail: T("{0}", [zoneName(ctx, d.zone_id)]), ref: { driverId: d.driver_id } });
  }
  const offline = await sql<{ driver_id: string; first_name: string; zone_id: string | null; country: string | null; offline_at: Date }>`
    SELECT driver_id, first_name, zone_ids[1] AS zone_id, country, offline_at FROM drivers
     WHERE offline_reason = 'missed_offers' AND online_status = 'offline' AND offline_at IS NOT NULL`.execute(ctx.ex);
  for (const d of offline.rows) {
    const country = countryOf(ctx, d.zone_id, d.country ?? "SE");
    const k = settingsOf(ctx, country).kind("auto_offline");
    if (k.on) out.push({ key: `auto_offline:${d.driver_id}:${d.offline_at.toISOString()}`, kind: "auto_offline", country, zoneId: d.zone_id, level: k.level, title: T("{0} went offline after offers not accepted", [name(d.first_name, "Driver")]), detail: T("{0} · {1}", [zoneName(ctx, d.zone_id), hhmm(d.offline_at, tz(ctx, d.zone_id))]), ref: { driverId: d.driver_id } });
  }
  return out;
}

export const major = (minor: string | number, currency: string) => moneyText({ amountMinor: Number(minor), currency: currency as CurrencyCode });

async function moneyCauses(ctx: Ctx): Promise<Cause[]> {
  const out: Cause[] = [];
  const failed = await sql<{ trip_id: string; zone_id: string; rider_id: string; rider: string | null; fare_minor: string; currency: string }>`
    SELECT t.trip_id, t.zone_id, t.rider_id, r.first_name AS rider, t.fare_minor, t.currency
      FROM trips t JOIN riders r ON r.rider_id = t.rider_id
     WHERE t.payment_status = 'failed'`.execute(ctx.ex);
  for (const p of failed.rows) {
    const country = countryOf(ctx, p.zone_id);
    const k = settingsOf(ctx, country).kind("payment_failed");
    if (k.on) out.push({ key: `payment_failed:${p.trip_id}`, kind: "payment_failed", country, zoneId: p.zone_id, level: k.level, title: T("{0}'s payment of {1} failed", [name(p.rider, "Rider"), major(p.fare_minor, p.currency)]), detail: T("{0} · {1}", [zoneName(ctx, p.zone_id), p.trip_id]), ref: { tripId: p.trip_id, riderId: p.rider_id } });
  }
  const refunds = await sql<{ refund_id: string; trip_id: string; zone_id: string | null; amount_minor: string; currency: string }>`
    SELECT f.refund_id, f.trip_id, t.zone_id, f.amount_minor, f.currency FROM refunds f LEFT JOIN trips t ON t.trip_id = f.trip_id
     WHERE f.status = 'pending_approval'`.execute(ctx.ex);
  for (const f of refunds.rows) {
    const country = countryOf(ctx, f.zone_id);
    const k = settingsOf(ctx, country).kind("refund_approval");
    if (k.on) out.push({ key: `refund_approval:${f.refund_id}`, kind: "refund_approval", country, zoneId: f.zone_id, level: k.level, title: T("A refund of {0} waits for approval", [major(f.amount_minor, f.currency)]), detail: T("{0}", [f.trip_id]), ref: { refundId: f.refund_id, tripId: f.trip_id } });
  }
  const floor = payoutFloorMinor(ctx);
  const payouts = floor === null ? { rows: [] } : await sql<{ payout_id: string; driver_id: string; zone_id: string | null; amount_minor: string; currency: string; first_name: string; country: string | null }>`
    SELECT p.payout_id, p.driver_id, coalesce(p.zone_id, d.zone_ids[1]) AS zone_id, p.amount_minor, p.currency, d.first_name, d.country
      FROM payouts p JOIN drivers d ON d.driver_id = p.driver_id WHERE p.status = 'pending' AND p.amount_minor >= ${floor}`.execute(ctx.ex);
  for (const p of payouts.rows) {
    const country = countryOf(ctx, p.zone_id, p.country ?? "SE");
    const k = settingsOf(ctx, country).kind("payout_big");
    const level = k.on ? levelFor(toMajorNumber({ amountMinor: Number(p.amount_minor), currency: p.currency as CurrencyCode }), k.limits, "up") : null;
    if (level) out.push({ key: `payout_big:${p.payout_id}`, kind: "payout_big", country, zoneId: p.zone_id, level, title: T("{0}'s payout is {1}", [name(p.first_name, "Driver"), major(p.amount_minor, p.currency)]), detail: T("{0}", [p.payout_id]), ref: { payoutId: p.payout_id, driverId: p.driver_id } });
  }
  return out;
}

async function riderCauses(ctx: Ctx): Promise<Cause[]> {
  const out: Cause[] = [];
  // rider_fraud: the server has no fraud signal yet (contract kindDefaults.rider_fraud): no alert, never a fake one.
  const cancels = await sql<{ rider_id: string; first_name: string; zone_id: string; rides: string; cancelled: string }>`
    SELECT t.rider_id, r.first_name, (array_agg(t.zone_id ORDER BY t.created_at DESC))[1] AS zone_id, count(*) AS rides,
           count(*) FILTER (WHERE t.status = 'cancelled_by_rider') AS cancelled
      FROM trips t JOIN riders r ON r.rider_id = t.rider_id
     WHERE t.created_at >= ${new Date(ctx.now.getTime() - 30 * DAY)} AND t.status IN ('completed', 'cancelled_by_rider', 'no_show')
     GROUP BY t.rider_id, r.first_name HAVING count(*) >= 5`.execute(ctx.ex);
  for (const r of cancels.rows) {
    const country = countryOf(ctx, r.zone_id);
    const k = settingsOf(ctx, country).kind("rider_cancels");
    const rate = Math.round((Number(r.cancelled) / Number(r.rides)) * 100);
    const level = k.on ? levelFor(rate, k.limits, "up") : null;
    if (level) out.push({ key: `rider_cancels:${r.rider_id}`, kind: "rider_cancels", country, zoneId: r.zone_id, level, title: T("{0} cancels {1}% of rides", [name(r.first_name, "Rider"), rate]), detail: T("{0} rides", [Number(r.rides)]), ref: { riderId: r.rider_id } });
  }
  const tickets = await sql<{ ticket_id: string; zone_id: string | null; country: string | null; opened_by: string; rider: string | null; driver: string | null }>`
    SELECT s.ticket_id, s.zone_id, s.country, s.opened_by, r.first_name AS rider, d.first_name AS driver
      FROM support_tickets s LEFT JOIN riders r ON r.rider_id = s.rider_id LEFT JOIN drivers d ON d.driver_id = s.driver_id
     WHERE s.status = 'open' AND s.assigned_admin_id IS NULL AND s.opened_by <> 'admin'`.execute(ctx.ex);
  for (const t of tickets.rows) {
    const country = countryOf(ctx, t.zone_id, t.country ?? "SE");
    const k = settingsOf(ctx, country).kind("ticket_open");
    const who = t.opened_by === "driver" ? name(t.driver, "Driver") : name(t.rider, "Rider");
    if (k.on) out.push({ key: `ticket_open:${t.ticket_id}`, kind: "ticket_open", country, zoneId: t.zone_id, level: k.level, title: T("Support ticket from {0}", [who]), detail: T("{0} · {1}", [zoneName(ctx, t.zone_id), t.ticket_id]), ref: { ticketId: t.ticket_id } });
  }
  return out;
}

/** B1.6b: how many parked refs the alert's detail names before "…". */
const PARKED_REFS_SHOWN = 3;

/**
 * Parked timers (attempts at the limit), one alert per kind and country book (B1.6b, owner W1 Q70): the detail names the
 * kind and its first refs; a trip or safety kind (LOUD_PARKED_KINDS) is critical, any kind is critical from 10.
 * Also run by the worker that parks a timer (sweepAlerts scope "system"), so it fires even when alert_sweep is parked.
 */
async function systemCauses(ctx: Ctx): Promise<Cause[]> {
  const parked = await sql<{ kind: string; n: string; refs: string[] }>`
    SELECT kind, count(*) AS n, (array_agg(ref_id ORDER BY ref_id))[1:${sql.lit(PARKED_REFS_SHOWN)}] AS refs
      FROM timers WHERE attempts >= ${MAX_ATTEMPTS} GROUP BY kind ORDER BY kind`.execute(ctx.ex);
  const late = [...(await laneLateCauses(ctx)), ...(await smsCapCauses(ctx)), ...stripeKeyCauses(ctx)];
  if (parked.rows.length === 0) return late;
  // No zone: one per country book (Super admins see alerts without a zone).
  const countries = [...new Set([...ctx.zones.values()].map((z) => z.country))];
  return countries.flatMap((country): Cause[] => {
    const k = settingsOf(ctx, country).kind("system_health");
    if (!k.on) return [];
    return parked.rows.map((p) => {
      const n = Number(p.n);
      const level = LOUD_PARKED_KINDS.includes(p.kind) || n >= 10 ? ("critical" as const) : k.level;
      const named = `${p.kind}: ${p.refs.join(", ")}${n > p.refs.length ? ", …" : ""}`;
      return { key: `system_health:timers:${p.kind}:${country}`, kind: "system_health", country, zoneId: null, level, title: T("{0} background jobs failed on the server", [n]), detail: T("{0}", [named]), ref: {} };
    });
  }).concat(late);
}

/**
 * L20-6 (load test 20k): the trip-timer lane running late is an admin alert, not only a /healthz/jobs line. Same
 * groups and limits as the heartbeat (LANE_LATE_LIMITS: trip_timers 60 s, dispatch 30 s): when a group's oldest due
 * timer is at least lateMs past due, one critical system_health alert per country book; it turns solved by itself when
 * the lane catches up. Parked timers (due 'infinity') never count here (they have their own alert above).
 */
async function laneLateCauses(ctx: Ctx): Promise<Cause[]> {
  const kinds = LANE_LATE_LIMITS.flatMap((group) => group.kinds);
  const due = await sql<{ kind: string; n: number; oldest_ms: number }>`
    SELECT kind, count(*)::int AS n, (extract(epoch FROM min(due_at)) * 1000)::float8 AS oldest_ms
      FROM timers WHERE due_at <= ${ctx.now} AND kind IN (${sql.join(kinds)}) GROUP BY kind`.execute(ctx.ex);
  if (due.rows.length === 0) return [];
  const late = LANE_LATE_LIMITS.flatMap((group) => {
    const rows = due.rows.filter((row) => group.kinds.includes(row.kind));
    if (rows.length === 0) return [];
    const lateMs = ctx.now.getTime() - Math.min(...rows.map((row) => Number(row.oldest_ms)));
    return lateMs >= group.lateMs ? [{ group: group.group, seconds: Math.floor(lateMs / 1000), overdue: rows.reduce((sum, row) => sum + row.n, 0) }] : [];
  });
  if (late.length === 0) return [];
  const countries = [...new Set([...ctx.zones.values()].map((z) => z.country))];
  return countries.flatMap((country) => {
    if (!settingsOf(ctx, country).kind("system_health").on) return [];
    return late.map((l) => ({
      key: `system_health:lane_late:${l.group}:${country}`,
      kind: "system_health",
      country,
      zoneId: null,
      level: "critical" as const,
      // contract v0.18.125: whole sentences (no English word as an argument) so the admin can translate them.
      title: l.group === "trip_timers" ? T("Server trip timers are running {0} s late", [l.seconds]) : T("Server dispatch rounds are running {0} s late", [l.seconds]),
      detail: l.group === "trip_timers" ? T("{0} trip timers overdue", [l.overdue]) : T("{0} dispatch rounds overdue", [l.overdue]),
      ref: {},
    }));
  });
}

/**
 * Contract v0.18.133 (contract.json#smsSignIn.alert): the daily sign-in SMS limit of a country. From nearPercent % of
 * the limit an important alert, at the limit a critical one (new sign-in codes are refused there, fail closed); each
 * turns solved by itself when the 24 h count falls below its line. Only for a country whose switch is on.
 */
async function smsCapCauses(ctx: Ctx): Promise<Cause[]> {
  const countries = [...new Set([...ctx.zones.values()].map((z) => z.country))];
  const out: Cause[] = [];
  for (const country of countries) {
    if (!settingsOf(ctx, country).kind("system_health").on) continue;
    const setting = await smsSignInFor(ctx.ex, country);
    if (!setting.enabled) continue;
    const { count } = await signInSmsLastDay(ctx.ex, country, ctx.now);
    const detail = T("Raise the daily limit in Tips & limits per country if these are real people");
    if (count >= setting.dailyCap) {
      out.push({ key: `system_health:sms_cap:${country}`, kind: "system_health", country, zoneId: null, level: "critical", title: T("Sign-in SMS limit reached: {0} of {1} in the last 24 hours. New sign-in codes are stopped", [count, setting.dailyCap]), detail, ref: {} });
    } else if (count >= nearCap(setting.dailyCap)) {
      out.push({ key: `system_health:sms_cap_near:${country}`, kind: "system_health", country, zoneId: null, level: "important", title: T("Sign-in SMS: {0} of {1} sent in the last 24 hours", [count, setting.dailyCap]), detail, ref: {} });
    }
  }
  // v0.18.157 (contract.json#smsSignIn.otherCountries.alert): the one other-countries limit, in the home country's book.
  if (countries.includes(OTHER_HOME) && settingsOf(ctx, OTHER_HOME).kind("system_health").on) {
    const other = await smsSignInOtherFor(ctx.ex);
    if (other.enabled) {
      const { count } = await otherSmsLastDay(ctx.ex, ctx.now);
      const detail = T("Raise the daily limit for other countries in Tips & limits (Sweden) if these are real people");
      if (count >= other.dailyCap) {
        out.push({ key: "system_health:sms_cap:other", kind: "system_health", country: OTHER_HOME, zoneId: null, level: "critical", title: T("Sign-in SMS limit for other countries reached: {0} of {1} in the last 24 hours. New sign-in codes for these numbers are stopped", [count, other.dailyCap]), detail, ref: {} });
      } else if (count >= nearCap(other.dailyCap)) {
        out.push({ key: "system_health:sms_cap_near:other", kind: "system_health", country: OTHER_HOME, zoneId: null, level: "important", title: T("Sign-in SMS to other countries: {0} of {1} sent in the last 24 hours", [count, other.dailyCap]), detail, ref: {} });
      }
    }
    // v0.18.157 guards.alerts: a spike from one calling code (its own cap reached) and a burst of all sign-in SMS.
    if (other.enabled) {
      const prefixes = (await servedCountries(ctx.ex)).map(callingCodeOf).filter((p): p is string => p !== undefined);
      const rows = await ctx.ex.selectFrom("sms_outbox").select("phone").where("kind", "in", ["sign_in_code", "sos_contact"]).where("status", "in", ["queued", "sent"]).where("created_at", ">", new Date(ctx.now.getTime() - 24 * 3_600_000)).execute();
      const perCode = new Map<string, number>();
      for (const { phone } of rows) if (!prefixes.some((p) => phone.startsWith(p))) perCode.set(callingCodeOfPhone(phone), (perCode.get(callingCodeOfPhone(phone)) ?? 0) + 1);
      for (const [code, count] of perCode) {
        if (count < other.perCodeDailyCap) continue;
        out.push({ key: `system_health:sms_cap:other:${code}`, kind: "system_health", country: OTHER_HOME, zoneId: null, level: "important", title: T("Sign-in SMS spike to {0}: {1} of {2} in the last 24 hours. New codes for this calling code are stopped", [code, count, other.perCodeDailyCap]), detail: T("Check for SMS pumping; block the calling code in Tips & limits (Sweden) if these are not real people"), ref: {} });
      }
    }
    const minute = await smsLastMinute(ctx.ex, ctx.now);
    if (minute.count >= other.perMinuteCap) {
      out.push({ key: "system_health:sms_burst", kind: "system_health", country: OTHER_HOME, zoneId: null, level: "critical", title: T("Sign-in SMS burst: the limit of {0} per minute was reached. New codes wait", [other.perMinuteCap]), detail: T("Check for SMS pumping; block the calling code in Tips & limits (Sweden) if these are not real people"), ref: {} });
    }
  }
  return out;
}

/** contract.json#stripeFees.status: one whole sentence per setup mistake (the admin translates it). */
const STRIPE_KEY_TITLE: Record<Exclude<StripeOffReason, "no_keys">, string> = {
  mixed_keys: "Card payments are off: the server has a mix of Stripe test and live keys",
  keys_incomplete: "Card payments are off: a Stripe key is missing on the server",
  bad_webhook_secret: "Card payments are off: the Stripe webhook secret is not valid",
  test_keys_in_production: "Card payments are off: Stripe test keys on the production server",
  live_keys_outside_production: "Card payments are off: Stripe live keys on a test server",
};

/**
 * Live mode (owner 2026-11-21, contract.json#stripeFees.status): Stripe keys this server copy cannot use (a mix, test
 * keys in production, live keys on staging, one missing, a bad webhook secret) are one system_health alert per country
 * book while it lasts; no keys at all is the normal off (no alert). Solved by itself after a start with right keys.
 */
function stripeKeyCauses(ctx: Ctx): Cause[] {
  const status = serverStripeStatus();
  if (status.mode !== "off" || status.reason === "no_keys") return [];
  const title = STRIPE_KEY_TITLE[status.reason];
  const countries = [...new Set([...ctx.zones.values()].map((z) => z.country))];
  return countries.flatMap((country): Cause[] => {
    const k = settingsOf(ctx, country).kind("system_health");
    if (!k.on) return [];
    return [{ key: `system_health:stripe_keys:${country}`, kind: "system_health", country, zoneId: null, level: k.level, title: T(title), detail: T("Fix the Stripe keys in the server settings and restart the server"), ref: {} }];
  });
}

/** v0.18.158 (contract.json#crashCatcher.alert): app crash kinds that alert (never a caught error, never the server). */
const APP_CRASH_KINDS = ["dart_error", "native_crash", "freeze", "crash"] as const;
const APP_CRASH_NEW_MS = 24 * 3600_000;

/**
 * v0.18.158 (crashCatcher.alert, kind app_crash, owner 2026-11-24 "Add to admin all kind of crash"): every open crash
 * group of the rider or driver app first seen in the last 24 h whose count reached the kind's Important limit (default
 * 1: a new crash type alerts at once), Critical from the Critical limit (default 20). One alert per group and country:
 * the country of the latest report's zone (with that zone) when it sent one, else every country that has a zone (no zone).
 */
async function appCrashCauses(ctx: Ctx): Promise<Cause[]> {
  const rows = await sql<{ error_id: string; app: string; kind: string; message: string; count: number; devices: string; zone_id: string | null }>`
    SELECT g.error_id, g.app, g.kind, g.message, g.count,
           (SELECT count(*) FROM error_group_devices d WHERE d.error_id = g.error_id) AS devices,
           (SELECT t.body->>'zoneId' FROM telemetry t WHERE t.error_id = g.error_id ORDER BY t.at DESC LIMIT 1) AS zone_id
      FROM error_groups g
     WHERE g.status = 'open' AND g.app IN ('rider', 'driver') AND g.kind IN (${sql.join(APP_CRASH_KINDS.map((k) => sql.lit(k)))})
       AND g.first_seen > ${new Date(ctx.now.getTime() - APP_CRASH_NEW_MS)}
     ORDER BY g.first_seen`.execute(ctx.ex);
  const countries = [...new Set([...ctx.zones.values()].map((z) => z.country))];
  const out: Cause[] = [];
  for (const g of rows.rows) {
    const zone = g.zone_id !== null ? ctx.zones.get(g.zone_id) : undefined;
    for (const country of zone ? [zone.country] : countries) {
      const k = settingsOf(ctx, country).kind("app_crash");
      if (!k.on) continue;
      const level = levelFor(Number(g.count), k.limits, "up");
      if (level === null) continue;
      out.push({
        key: `app_crash:${g.error_id}:${country}`,
        kind: "app_crash",
        country,
        zoneId: zone ? zone.zone_id : null,
        level,
        title: T("New crash in the {0} app ({1}): {2}", [g.app, g.kind, g.message.slice(0, 160)]),
        detail: T("{0} reports from {1} devices", [Number(g.count), Number(g.devices)]),
        ref: {},
      });
    }
  }
  return out;
}

/**
 * v0.18.161 (alertDesk kind car_no_country; owner 2026-11-25 "Show as errors and must check what happen"): every car
 * whose country is unknown (no fleet, and no driver or a driver with no country) is a data error someone must check.
 * One alert per car and country, in every country that has a zone (the car has none); solved when it gets a country.
 */
async function carNoCountryCauses(ctx: Ctx): Promise<Cause[]> {
  const rows = await sql<{ vehicle_id: string; plate: string; driver_id: string | null }>`
    SELECT v.vehicle_id, v.plate, v.driver_id
      FROM vehicles v LEFT JOIN fleets f ON f.fleet_id = v.fleet_id LEFT JOIN drivers d ON d.driver_id = v.driver_id
     WHERE COALESCE(f.country, d.country) IS NULL
     ORDER BY v.created_at, v.vehicle_id LIMIT 500`.execute(ctx.ex);
  const countries = [...new Set([...ctx.zones.values()].map((z) => z.country))];
  const out: Cause[] = [];
  for (const car of rows.rows) {
    for (const country of countries) {
      const k = settingsOf(ctx, country).kind("car_no_country");
      if (!k.on) continue;
      out.push({ key: `car_no_country:${car.vehicle_id}:${country}`, kind: "car_no_country", country, zoneId: null, level: k.level, title: T("Car with no country: {0}", [car.plate]), detail: T("Car {0}", [car.vehicle_id]), ref: { vehicleId: car.vehicle_id, ...(car.driver_id ? { driverId: car.driver_id } : {}) } });
    }
  }
  return out;
}

/**
 * v0.18.162 (alertDesk kind driver_no_country; contract.json#driverCountryFirst.oneTimeFix): a driver with no country who
 * has data (an account type, a fleet, a car or a status past pending) or signed up over 24 h ago. One alert per driver
 * and country, in every country that has a zone; solved when he has a country.
 */
async function driverNoCountryCauses(ctx: Ctx): Promise<Cause[]> {
  const rows = await sql<{ driver_id: string; first_name: string | null; last_name: string | null }>`
    SELECT d.driver_id, d.first_name, d.last_name
      FROM drivers d
     WHERE d.country IS NULL AND d.erased_at IS NULL
       AND (d.account_type IS NOT NULL OR d.fleet_id IS NOT NULL OR d.account_status <> 'pending'
            OR d.created_at < ${ctx.now}::timestamptz - interval '24 hours'
            OR EXISTS (SELECT 1 FROM vehicles v WHERE v.driver_id = d.driver_id))
     ORDER BY d.created_at, d.driver_id LIMIT 500`.execute(ctx.ex);
  const countries = [...new Set([...ctx.zones.values()].map((z) => z.country))];
  const out: Cause[] = [];
  for (const d of rows.rows) {
    const name = [d.first_name, d.last_name].filter(Boolean).join(" ") || d.driver_id;
    for (const country of countries) {
      const k = settingsOf(ctx, country).kind("driver_no_country");
      if (!k.on) continue;
      out.push({ key: `driver_no_country:${d.driver_id}:${country}`, kind: "driver_no_country", country, zoneId: null, level: k.level, title: T("Driver has no country: {0}", [name]), detail: T("Driver {0}", [d.driver_id]), ref: { driverId: d.driver_id } });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ custom rules (owner A3) */

async function metricValues(ctx: Ctx): Promise<(metric: string, zoneId: string) => number> {
  const waiting = await sql<{ zone_id: string; n: string; longest: number | null }>`
    SELECT zone_id, count(*) AS n, max(extract(epoch FROM (${ctx.now}::timestamptz - coalesce(search_started_at, created_at))) / 60)::float AS longest
      FROM trips WHERE kind = 'live' AND driver_id IS NULL AND status IN ('requested', 'searching', 'offered') GROUP BY zone_id`.execute(ctx.ex);
  const free = await sql<{ zone_id: string; n: string }>`
    SELECT l.zone_id, count(*) AS n FROM drivers d JOIN driver_locations l ON l.driver_id = d.driver_id
     WHERE d.online_status = 'online' AND l.zone_id IS NOT NULL GROUP BY 1`.execute(ctx.ex);
  const failed = await sql<{ zone_id: string; n: string }>`
    SELECT zone_id, count(*) AS n FROM trips WHERE payment_status = 'failed' AND updated_at >= ${new Date(ctx.now.getTime() - DAY)} GROUP BY zone_id`.execute(ctx.ex);
  const sos = await sql<{ zone_id: string; n: string }>`SELECT zone_id, count(*) AS n FROM incidents WHERE kind = 'sos' AND status = 'open' GROUP BY zone_id`.execute(ctx.ex);
  const tickets = await sql<{ zone_id: string; n: string }>`SELECT zone_id, count(*) AS n FROM support_tickets WHERE status = 'open' GROUP BY zone_id`.execute(ctx.ex);
  const by = (rows: { zone_id: string; n: string }[]) => new Map(rows.map((r) => [r.zone_id, Number(r.n)]));
  const maps: Record<string, Map<string, number>> = {
    free_drivers: by(free.rows), riders_waiting: by(waiting.rows), failed_payments: by(failed.rows), open_sos: by(sos.rows), open_tickets: by(tickets.rows),
    longest_wait: new Map(waiting.rows.map((r) => [r.zone_id, Math.floor(Number(r.longest ?? 0))])),
  };
  return (metric, zoneId) => maps[metric]?.get(zoneId) ?? 0;
}

async function ruleCauses(ctx: Ctx): Promise<Cause[]> {
  const out: Cause[] = [];
  const value = await metricValues(ctx);
  const holding = new Map((await ctx.ex.selectFrom("admin_alert_rule_state").selectAll().execute()).map((r) => [r.rule_key, r.holding_since]));
  const still = new Set<string>();
  for (const [country, rules] of ctx.rules) {
    const zones = [...ctx.zones.values()].filter((z) => z.country === country);
    for (const rule of rules.filter((r) => r.on && METRIC_UNITS[r.metric])) {
      for (const zone of zones.filter((z) => rule.zoneId === "all" || z.zone_id === rule.zoneId)) {
        const v = value(rule.metric, zone.zone_id);
        if (!(rule.op === "above" ? v > rule.value : v < rule.value)) continue;
        const key = `rule:${rule.id}:${zone.zone_id}`;
        still.add(key);
        const since = holding.get(key);
        if (!since) await ctx.ex.insertInto("admin_alert_rule_state").values({ rule_key: key, holding_since: ctx.now }).onConflict((oc) => oc.column("rule_key").doNothing()).execute();
        if (ctx.now.getTime() - (since ?? ctx.now).getTime() < rule.forMin * MIN) continue;
        out.push({ key, kind: "rule", country, zoneId: zone.zone_id, level: rule.level, title: T("{0}: {1} {2} in {3}", [rule.name, v, METRIC_UNITS[rule.metric]!, zone.name], [2]), detail: T("Your rule: {0} {1} {2} for {3} min", [rule.metric, rule.op, rule.value, rule.forMin], [0, 1]), ref: { ruleId: rule.id } });
      }
    }
  }
  const gone = [...holding.keys()].filter((k) => !still.has(k));
  if (gone.length) await ctx.ex.deleteFrom("admin_alert_rule_state").where("rule_key", "in", gone).execute();
  return out;
}

/* ------------------------------------------------------------------ what happened when a cause ended (owner A2) */

type LiveRow = { alert_id: string; cause_key: string; kind: string; country: string; zone_id: string | null; level: string; title: string; detail: string; ref: unknown; state: string; cause_live: boolean; old_since: Date | null };
type TripFacts = { status: string; accepted_at: Date | null; updated_at: Date; ended_at: Date | null; payment_status: string | null; driver: string | null };
type Lookups = { trips: Map<string, TripFacts>; incidents: Map<string, { status: string; resolved_at: Date | null }> };

/** Checker MED 4: what every alert about to turn green needs, read in two queries (not one per alert). */
async function lookupsFor(ctx: Ctx, rows: readonly LiveRow[]): Promise<Lookups> {
  const refs = rows.map((r) => (r.ref ?? {}) as Ref);
  const tripIds = [...new Set(refs.flatMap((r) => (r.tripId ? [r.tripId] : [])))];
  const incidentIds = [...new Set(refs.flatMap((r) => (r.incidentId ? [r.incidentId] : [])))];
  const trips = tripIds.length
    ? (await sql<TripFacts & { trip_id: string }>`
        SELECT t.trip_id, t.status, t.accepted_at, t.updated_at, t.ended_at, t.payment_status, d.first_name AS driver
          FROM trips t LEFT JOIN drivers d ON d.driver_id = t.driver_id WHERE t.trip_id = ANY(${tripIds})`.execute(ctx.ex)).rows
    : [];
  const incidents = incidentIds.length ? await ctx.ex.selectFrom("incidents").select(["incident_id", "status", "resolved_at"]).where("incident_id", "in", incidentIds).execute() : [];
  return { trips: new Map(trips.map((r) => [r.trip_id, r])), incidents: new Map(incidents.map((r) => [r.incident_id, r])) };
}

function solvedText(ctx: Ctx, row: LiveRow, look: Lookups): Text {
  const ref = (row.ref ?? {}) as Ref;
  const at = (d: Date | null | undefined) => hhmm(d ?? ctx.now, tz(ctx, row.zone_id));
  if (ref.incidentId && ["sos", "sos_slow", "car_lost", "ride_check"].includes(row.kind)) {
    const i = look.incidents.get(ref.incidentId);
    if (i && (i.status === "resolved" || i.status === "dismissed")) return T("Closed in Incidents {0}", [at(i.resolved_at)]);
    if (row.kind === "ride_check" && ref.tripId) {
      const trip = look.trips.get(ref.tripId);
      if (trip) return T("Trip ended {0}", [at(trip.ended_at ?? trip.updated_at)]);
    }
    if (row.kind === "car_lost") return T("The car's position came back {0}", [at(ctx.now)]);
  }
  if (ref.tripId && ["long_wait", "late_reservation", "booked_at_risk", "booked_late", "booked_not_started", "booked_taken_back", "payment_failed", "no_driver_nearby"].includes(row.kind)) {
    const trip = look.trips.get(ref.tripId);
    if (trip) {
      if (row.kind === "payment_failed") return trip.payment_status === "failed" ? T("Solved by itself {0}", [at(ctx.now)]) : T("Paid {0}", [at(trip.updated_at)]);
      if (trip.status.startsWith("cancelled") || trip.status === "expired") return T("Ride cancelled {0}", [at(trip.updated_at)]);
      if (row.kind === "booked_not_started" && trip.status !== "accepted") return T("Driver {0} started {1}", [name(trip.driver, "Driver"), at(trip.updated_at)]);
      if (trip.driver) return T("Driver {0} took it {1}", [trip.driver, at(trip.accepted_at ?? trip.updated_at)]);
    }
  }
  if (row.kind === "few_drivers" || row.kind === "no_driver") return T("Enough drivers again {0}", [at(ctx.now)]);
  if (row.kind === "auto_offline") return T("Back online {0}", [at(ctx.now)]);
  if (row.kind === "doc_expiring") return T("New document approved {0}", [at(ctx.now)]);
  if (row.kind === "ticket_open") return T("Taken or answered in Support {0}", [at(ctx.now)]);
  if (row.kind === "rule") return T("The rule no longer holds {0}", [at(ctx.now)]);
  return T("Solved by itself {0}", [at(ctx.now)]);
}

/* ------------------------------------------------------------------ the sweep */

async function loadCtx(ex: Executor, now: Date): Promise<Ctx> {
  const zones = await ex.selectFrom("zones").select(["zone_id", "country", "time_zone", "name"]).execute();
  const books = await ex.selectFrom("admin_alert_book").select(["country", "settings", "rules"]).execute();
  return {
    ex,
    now,
    zones: new Map(zones.map((z) => [z.zone_id, z])),
    settings: new Map(books.map((b) => [b.country, new AlertSettings((b.settings ?? {}) as Record<string, unknown>)])),
    rules: new Map(books.map((b) => [b.country, rulesOf(b.rules)])),
  };
}

export async function findCauses(ex: Executor, now: Date): Promise<Cause[]> {
  const ctx = await loadCtx(ex, now);
  return findAll(ctx);
}

async function findAll(ctx: Ctx): Promise<Cause[]> {
  const all = [
    ...(await safetyCauses(ctx)),
    ...(await dispatchCauses(ctx)),
    ...(await bookedCauses(ctx)),
    ...(await driverCauses(ctx)),
    ...(await moneyCauses(ctx)),
    ...(await riderCauses(ctx)),
    ...(await systemCauses(ctx)),
    ...(await appCrashCauses(ctx)),
    ...(await carNoCountryCauses(ctx)),
    ...(await driverNoCountryCauses(ctx)),
    ...(await ruleCauses(ctx)),
  ];
  // One cause key, one cause (a cause found twice keeps the first).
  const seen = new Map<string, Cause>();
  for (const cause of all) if (!seen.has(cause.key)) seen.set(cause.key, cause);
  return [...seen.values()];
}

/** Rows per INSERT of new alerts (17 values each: far below the 65,535 bind parameters of one statement). */
export const ALERT_INSERT_CHUNK = 500;

/**
 * One sweep: find every cause and make the stored alerts match. Returns what changed (for tests and logs).
 * B1.6b: scope "system" looks only at the parked-job causes and the system_health alerts (the worker runs it when it
 * parks a timer, so that alert never waits on a sweep that may itself be parked).
 */
export async function sweepAlerts(trx: Trx, now: Date, scope: "all" | "system" = "all"): Promise<{ opened: number; solved: number; reopened: number }> {
  // One sweep at a time across instances (a poke and the periodic run may meet). The worker's scoped sweep never waits
  // (supervisor B1.6b F2): if a sweep runs now, it skips — that sweep, or the next one, sees the parked row.
  if (scope === "system") {
    const got = await sql<{ ok: boolean }>`SELECT pg_try_advisory_xact_lock(hashtext('movera_alert_sweep')) AS ok`.execute(trx);
    if (!got.rows[0]?.ok) {
      // G10 (2026-11-11): the running sweep may have read the timers before this parking; a one-off sweep right after
      // it ends sees the parked row. A poke row being run right now (deleted, not yet committed) would make this insert
      // wait for that sweep: never more than 200 ms (then the periodic sweep, every 30 s, sees it).
      await sql`SAVEPOINT alert_poke`.execute(trx);
      try {
        await sql`SET LOCAL lock_timeout = '200ms'`.execute(trx);
        await pokeAlerts(trx, now);
      } catch {
        await sql`ROLLBACK TO SAVEPOINT alert_poke`.execute(trx);
      }
      return { opened: 0, solved: 0, reopened: 0 };
    }
  } else {
    await sql`SELECT pg_advisory_xact_lock(hashtext('movera_alert_sweep'))`.execute(trx);
  }
  const ctx = await loadCtx(trx, now);
  const causes = new Map((scope === "system" ? await systemCauses(ctx) : await findAll(ctx)).map((c) => [c.key, c]));
  let live = trx
    .selectFrom("admin_alerts_live")
    .select(["alert_id", "cause_key", "kind", "country", "zone_id", "level", "title", "detail", "ref", "state", "cause_live", "old_since"])
    .where((eb) => eb.or([eb("state", "!=", "closed"), eb("cause_live", "=", true)]));
  if (scope === "system") live = live.where("kind", "=", "system_health");
  const rows = (await live.execute()) as LiveRow[];
  const handled = new Set<string>();
  const result = { opened: 0, solved: 0, reopened: 0 };
  const ending = rows.filter((r) => r.state === "open" && !causes.has(r.cause_key));
  const look = await lookupsFor(ctx, ending);
  const endedClosed: string[] = [];
  for (const row of rows) {
    const cause = causes.get(row.cause_key);
    if (row.state === "closed") {
      // Done by an admin: no new alert while its cause is still there; once it ends, the next one is new.
      if (cause) handled.add(row.cause_key);
      else endedClosed.push(row.alert_id);
      continue;
    }
    if (cause) {
      handled.add(row.cause_key);
      const reopen = row.state === "solved";
      const title = render(cause.title);
      const detail = cause.detail ? render(cause.detail) : "";
      const ref = JSON.stringify(cause.ref);
      // Checker MED 4: write only what changed (an unchanged open alert costs no write).
      const same = !reopen && row.level === cause.level && row.title === title && row.detail === detail && row.zone_id === cause.zoneId && row.country === cause.country && stable(row.ref ?? {}) === stable(cause.ref) && (row.old_since?.getTime() ?? null) === (cause.oldSince?.getTime() ?? null);
      if (same) continue;
      if (reopen) result.reopened += 1;
      await trx
        .updateTable("admin_alerts_live")
        .set({
          level: cause.level,
          title,
          title_t: JSON.stringify(cause.title),
          detail,
          detail_t: cause.detail ? JSON.stringify(cause.detail) : null,
          // Checker HIGH 1: a cause that moved zone (or country) moves its alert with it.
          zone_id: cause.zoneId,
          country: cause.country,
          ref,
          old_since: cause.oldSince ?? null,
          seen_at: now,
          cause_live: true,
          updated_at: now,
          ...(reopen ? { state: "open" as const, solved_at: null, solved_t: null } : {}),
        })
        .where("alert_id", "=", row.alert_id)
        .execute();
      continue;
    }
    if (row.state === "open") {
      // Owner A2: the problem ended by itself → the alert stays, green, with what happened.
      const text = solvedText(ctx, row, look);
      await trx.updateTable("admin_alerts_live").set({ state: "solved", cause_live: false, solved_at: now, solved_t: JSON.stringify(text), updated_at: now }).where("alert_id", "=", row.alert_id).execute();
      result.solved += 1;
    }
  }
  if (endedClosed.length) await trx.updateTable("admin_alerts_live").set({ cause_live: false, updated_at: now }).where("alert_id", "in", endedClosed).execute();
  const fresh = [...causes.values()].filter((c) => !handled.has(c.key));
  if (fresh.length) {
    // Checker MED 3: a clash on the one-open-alert-per-cause index is skipped, never an error that undoes the sweep;
    // only rows really written count as opened.
    // Stress T-A follow-up: in chunks; one INSERT of ~4,400 new causes (17 values each) passed 65,535 bind parameters
    // and failed every sweep until the timer was parked.
    const inserted: { alert_id: string }[] = [];
    for (let i = 0; i < fresh.length; i += ALERT_INSERT_CHUNK) inserted.push(...(await trx
      .insertInto("admin_alerts_live")
      .values(fresh.slice(i, i + ALERT_INSERT_CHUNK).map((cause) => ({
        // The admin routes take [A-Za-z0-9_:.-] ids (realdataRoutes ALERT_ID).
        alert_id: `${cause.key.replace(/[^A-Za-z0-9_:.-]/g, "_").slice(0, 180)}.${now.getTime().toString(36)}`,
        cause_key: cause.key,
        kind: cause.kind,
        country: cause.country,
        zone_id: cause.zoneId,
        level: cause.level,
        title: render(cause.title),
        title_t: JSON.stringify(cause.title),
        detail: cause.detail ? render(cause.detail) : "",
        detail_t: cause.detail ? JSON.stringify(cause.detail) : null,
        since: now,
        state: "open" as const,
        cause_live: true,
        ref: JSON.stringify(cause.ref),
        old_since: cause.oldSince ?? null,
        seen_at: now,
        updated_at: now,
      })))
      .onConflict((oc) => oc.doNothing())
      .returning("alert_id")
      .execute()));
    result.opened += inserted.length;
  }
  return result;
}

/**
 * Event-driven: a one-off sweep right after the event's transaction (its own timer row "poke", so the caller never
 * waits on a running sweep; the periodic row "all" books itself again).
 */
export async function pokeAlerts(ex: Executor, now: Date): Promise<void> {
  await scheduleTimer(ex, { kind: ALERT_SWEEP, refId: "poke", dueAt: now });
}

export const alertSweepHandler: TimerHandler = async (trx, timer) => {
  await sweepAlerts(trx, timer.firedAt);
  if (timer.refId === "all") await scheduleTimer(trx, { kind: ALERT_SWEEP, refId: "all", dueAt: new Date(timer.firedAt.getTime() + SWEEP_MS) });
};

/** B1.6b: the worker's onParked hook: the parked-job alert at once, in its own transaction. */
export const raiseParkedAlert = async (db: Db, _timer: unknown, now: Date): Promise<void> => {
  await db.transaction().execute((trx) => sweepAlerts(trx, now, "system"));
};

export async function ensureAlertSweep(ex: Executor, now: Date = new Date()): Promise<void> {
  await ex.insertInto("timers").values({ kind: ALERT_SWEEP, ref_id: "all", due_at: now }).onConflict((oc) => oc.columns(["kind", "ref_id"]).doNothing()).execute();
}

/** When an admin marks a server alert done, it is closed (contract serverDetection.states.done). */
export async function closeLiveAlert(trx: Trx, alertId: string, now: Date): Promise<void> {
  await trx.updateTable("admin_alerts_live").set({ state: "closed", updated_at: now }).where("alert_id", "=", alertId).where("state", "!=", "closed").execute();
}

export async function liveAlertRow(ex: Executor, alertId: string) {
  return ex.selectFrom("admin_alerts_live").selectAll().where("alert_id", "=", alertId).executeTakeFirst();
}
