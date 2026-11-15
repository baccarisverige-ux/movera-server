import { contract } from "../contract/contract.js";
import { inPolygon, polygonProblem, type Polygon } from "../zones/geometry.js";

/**
 * v0.18.110 BQ-V44 (contract.json#bonusCampaigns; owner G10-5 "Make bonuses real (Recommended)", Rules
 * decisions/driver-g10.md:9): the pure rules of a bonus campaign, the same steps as the reference engine
 * (contracts/reference_check.py bonus_validate / bonus_hours), so the fixtures replay through this code
 * (test/bonuses/bonus_fixtures.test.ts). The database steps around them are in counting.ts and campaigns.ts.
 */

type Range = [number, number];
type Spec = {
  limits: { target: { trips: Range; online_hours: Range }; maxDays: number };
  counting: { gapMaxSeconds: number; accuracyMaxMeters: number; maxSpeedKmh: number; writeEverySeconds: number };
};
export const BONUS = (contract as unknown as { bonusCampaigns: Spec }).bonusCampaigns;
export const COUNTING = BONUS.counting;
/** D11: an ended campaign he took part in stays in his list this long after its end. */
export const ENDED_SHOWN_DAYS = 30;

export type Measure = "trips" | "online_hours";
export type Money = { amountMinor: number; currency: string };
export type CampaignInput = { measure: Measure; target: unknown; amount: Money; startDate: string; endDate: string; polygon: Polygon };
export type Reason = "ok" | "bonus_target_invalid" | "bonus_amount_invalid" | "bonus_amount_above_max" | "bonus_dates_invalid" | "bonus_area_invalid";

const DAY_MS = 86_400_000;
const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / DAY_MS;

/** Whole days from a to b, both counted (local dates YYYY-MM-DD). */
export const daysBetween = (a: string, b: string) => dayNumber(b) - dayNumber(a) + 1;

/** limits.dates: start ≤ end, start not before today (zone time), at most maxDays days, both counted. */
export function datesValid(today: string, startDate: string, endDate: string): boolean {
  return startDate <= endDate && startDate >= today && daysBetween(startDate, endDate) <= BONUS.limits.maxDays;
}

/**
 * A new campaign against its zone (limits; the order of the reference engine): target, amount, the largest amount
 * (CountryRules.bonusCampaignMax), dates, then the area — 3-500 points, not closed, not self-crossing, and every point
 * inside the zone's polygon, a point on the zone's edge counting as inside (MF6).
 */
export function validateCampaign(zone: { currency: string; polygon: Polygon }, today: string, input: CampaignInput, maxMinor: number): Reason {
  const [lo, hi] = BONUS.limits.target[input.measure];
  const t = input.target;
  if (typeof t !== "number" || !Number.isInteger(t) || t < lo || t > hi) return "bonus_target_invalid";
  if (input.amount.currency !== zone.currency || input.amount.amountMinor <= 0) return "bonus_amount_invalid";
  if (input.amount.amountMinor > maxMinor) return "bonus_amount_above_max";
  if (!datesValid(today, input.startDate, input.endDate)) return "bonus_dates_invalid";
  const pg = input.polygon;
  if (pg.length < 3 || pg.length > 500 || polygonProblem(pg) !== null) return "bonus_area_invalid";
  if (!pg.every(([lat, lng]) => inPolygon(lat, lng, zone.polygon))) return "bonus_area_invalid";
  return "ok";
}

export type Bounds = { south: number; west: number; north: number; east: number };
/** The area holds the point (bounds first, then the polygon; a point on the edge is inside). */
export const insideArea = (area: Bounds & { polygon: Polygon }, lat: number, lng: number) =>
  lat >= area.south && lat <= area.north && lng >= area.west && lng <= area.east && inPolygon(lat, lng, area.polygon);

export type Window = { startsAt: Date; endsAt: Date; status: string; endedAt: Date | null; pauses: ReadonlyArray<readonly [string, string | null]> };

/** The campaign counts at this moment: inside its window, not ended, and in no pause (contract window + paused). */
export function activeAt(c: Window, at: Date): boolean {
  const t = at.getTime();
  if (t < c.startsAt.getTime() || t >= c.endsAt.getTime()) return false;
  if (c.endedAt !== null && t >= c.endedAt.getTime()) return false;
  if (c.status === "ended" && c.endedAt === null) return false;
  return !c.pauses.some(([from, to]) => t >= Date.parse(from) && (to === null || t < Date.parse(to)));
}

/** BonusState (contract window): ended / scheduled / paused / active. */
export function stateOf(c: { startsAt: Date; endsAt: Date; status: string }, now: Date): "scheduled" | "active" | "paused" | "ended" {
  if (c.status === "ended" || now.getTime() >= c.endsAt.getTime()) return "ended";
  if (now.getTime() < c.startsAt.getTime()) return "scheduled";
  return c.status === "paused" ? "paused" : "active";
}

/**
 * MF7 / supervisor note 2: phone numbers compared in one E.164 form — spaces, dashes, dots and brackets dropped, a
 * leading 00 read as +. "+46 70-111 22 33" and "0046701112233" are the same number as "+46701112233".
 */
export function e164(phone: string): string {
  const compact = phone.replace(/[\s\-().]/g, "");
  return compact.startsWith("00") ? `+${compact.slice(2)}` : compact;
}
export const samePhone = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && e164(a) === e164(b);

/** Straight-line distance in km (haversine, as reference_check.py _km). */
export function kmBetween(a: readonly [number, number], b: readonly [number, number]): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const [la1, lo1, la2, lo2] = [rad(a[0]), rad(a[1]), rad(b[0]), rad(b[1])];
  const h = Math.sin((la2 - la1) / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin((lo2 - lo1) / 2) ** 2;
  return 6371.0 * 2 * Math.asin(Math.sqrt(h));
}

/** The last counted fix of a driver in an online_hours campaign, and the seconds counted (bonus_progress). */
export type HoursState = { seconds: number; lastAt: Date | null; lastReceivedAt: Date | null; lastLat: number | null; lastLng: number | null };
export type HoursFix = { at: Date; lat: number; lng: number; accuracy: number };
export type HoursContext = {
  /** The server's now: receivedAt of every fix of this batch. */
  now: Date;
  /** online or on_trip when the batch arrives (D6). */
  statusCounts: boolean;
  onlineSince: Date | null;
  campaign: Window & Bounds & { polygon: Polygon };
  /** target × 3600. */
  needSeconds: number;
};

/**
 * MF3 counting.onlineHours, one batch (all with the same receivedAt = now), fix by fix in time order. A fix is counted
 * only when: status online / on_trip, accuracy ≤ accuracyMaxMeters, inside the area, the campaign active at the fix time
 * AND at now, fix time ≥ online_since and ≤ now, later than the last counted fix by at least writeEverySeconds (sooner
 * only waits), and no jump faster than maxSpeedKmh from the last counted fix. It adds min(fix gap, now − the last
 * counted receivedAt) when the fix gap is ≤ gapMaxSeconds, else 0; the first counted fix adds 0. Never above the need.
 * Returns the new state and whether anything was counted (nothing counted = nothing to write, Rule 33).
 */
export function foldFixes(start: HoursState, fixes: readonly HoursFix[], ctx: HoursContext): { state: HoursState; counted: boolean } {
  const s: HoursState = { ...start };
  let counted = false;
  if (!ctx.statusCounts || !activeAt(ctx.campaign, ctx.now)) return { state: s, counted };
  for (const f of [...fixes].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    if (s.seconds >= ctx.needSeconds) break;
    if (f.accuracy > COUNTING.accuracyMaxMeters || !insideArea(ctx.campaign, f.lat, f.lng)) continue;
    if (!activeAt(ctx.campaign, f.at) || ctx.onlineSince === null || f.at < ctx.onlineSince || f.at > ctx.now) continue;
    if (s.lastAt !== null) {
      const gap = (f.at.getTime() - s.lastAt.getTime()) / 1000;
      if (gap <= 0 || gap < COUNTING.writeEverySeconds) continue;
      if (s.lastLat !== null && s.lastLng !== null && kmBetween([s.lastLat, s.lastLng], [f.lat, f.lng]) / (gap / 3600) > COUNTING.maxSpeedKmh) continue;
      if (gap <= COUNTING.gapMaxSeconds) {
        const server = s.lastReceivedAt === null ? gap : (ctx.now.getTime() - s.lastReceivedAt.getTime()) / 1000;
        s.seconds = Math.min(ctx.needSeconds, s.seconds + Math.max(0, Math.trunc(Math.min(gap, server))));
      }
    }
    s.lastAt = f.at;
    s.lastReceivedAt = ctx.now;
    s.lastLat = f.lat;
    s.lastLng = f.lng;
    counted = true;
  }
  return { state: s, counted };
}
