import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { countDay } from "../../src/admin/kpis.js";
import { driverPayouts, listPayouts, makePayouts } from "../../src/admin/payouts.js";
import type { Principal } from "../../src/auth/guard.js";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { forgetGeometry } from "../../src/config/geometryCache.js";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import type { TripRow } from "../../src/db/tripLog.js";
import { commissionOf } from "../../src/rules/commission.js";
import { tripProjection } from "../../src/trips/projection.js";
import { creditTrip } from "../../src/trips/ride/finish.js";
import { boundsOf, type Polygon } from "../../src/zones/geometry.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver, insertRider, insertTrip, seedPhone } from "../support/seed.js";
import { call, signIn, testWorld } from "../support/world.js";

/**
 * v0.18.103 BQ-V44 (contract.json#bonusCampaigns; Rules audits/impact/v44-driver-bonuses.md §10): EVERY case of
 * contracts/fixtures/bonus_campaigns.json replayed through the server's real code paths, not a copy of the engine:
 * - validate: POST /admin/bonuses (the route, its rules and the CountryRules.bonusCampaignMax default) → 201 or 400 reason;
 * - trips: the campaign made through the admin route, paused / resumed / ended through the admin routes at the fixture's
 *   times, each paid end credited by creditTrip (the one step every paid end goes through); progress read back through
 *   GET /admin/bonuses/{id}/drivers, entries from earnings_entries;
 * - hours: every fix posted through POST /driver/location at its receivedAt (one batch per receivedAt), the driver's
 *   status set as the fixture says;
 * - payout: the entries in a real payout (makePayouts), Payout.lines / amount, and Payout.summary in BOTH views (admin
 *   listPayouts, driver driverPayouts) — MF4, with the J8 paid_to_movera and the lost-driver entry in one payout;
 * - kpi: countDay (the live day, the nightly summary, resumTripDay and kpi-resum all use it) — MF8.
 * Money in minor units: SEK öre, EUR cent, TND millime (×1000).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped fixture JSON from the contract
type Json = Record<string, any>;
const F = JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/bonus_campaigns.json`, "utf8")) as Record<string, Json[]>;
let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-11-14T10:00:00Z") };

let adminAt = -1;
let adminHeaders: Record<string, string> | undefined;
/** A super admin signed in at the test clock (an access token lasts 15 min, and the clock moves days). */
async function A(): Promise<Record<string, string>> {
  const t = clock.now.getTime();
  if (adminHeaders === undefined || t < adminAt || t - adminAt > 600_000) {
    adminHeaders = (await adminSession(app, database.db, "super", { now: clock.now })).headers;
    adminAt = t;
  }
  return adminHeaders;
}
const ZONE_OF: Record<string, string> = { SEK: "Z001", EUR: "FR-PC", TND: "TN-TC" };
const NAMES = { sv: "Kampanj", fr: "Campagne", en: "Campaign" };
const CREATE_AT = new Date("2026-11-14T10:00:00Z");
const ts = (s: string) => new Date(s);
/** The fixtures write whole-second times without milliseconds. */
const iso = (s: string) => s.replace(".000Z", "Z");

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  // The zones' outlines of the fixtures (MF6: a campaign area lies inside its zone).
  for (const x of F["validate"]!) {
    const zoneId = ZONE_OF[x["zone"]["currency"]]!;
    const polygon = x["zone"]["polygon"] as Polygon;
    await database.db.updateTable("zones").set({ polygon: JSON.stringify(polygon), ...boundsOf(polygon) }).where("zone_id", "=", zoneId).execute();
  }
  forgetGeometry();
});
afterAll(async () => {
  await app?.close();
  await database?.drop();
});

async function create(zoneId: string, input: Json) {
  clock.now = CREATE_AT;
  return call(app, "POST", "/admin/bonuses", await A(), { zoneId, names: NAMES, ...input });
}
async function makeCampaign(c: Json): Promise<Json> {
  const res = await create(c["zoneId"], { measure: c["measure"], target: c["target"], amount: c["amount"], startDate: c["startDate"], endDate: c["endDate"], polygon: c["polygon"] });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}
/** The admin's pause / resume / end at the fixture's times, through the admin routes. */
function adminEvents(c: Json): Array<{ at: Date; command: "pause" | "resume" | "end" }> {
  const out: Array<{ at: Date; command: "pause" | "resume" | "end" }> = [];
  for (const [from, to] of c["pauses"] as [string, string][]) out.push({ at: ts(from), command: "pause" }, { at: ts(to), command: "resume" });
  if (c["endedAt"]) out.push({ at: ts(c["endedAt"]), command: "end" });
  return out;
}
async function command(bonusId: string, name: "pause" | "resume" | "end", at: Date) {
  clock.now = at;
  const current = (await call(app, "GET", `/admin/bonuses/${bonusId}`, await A())).json();
  const res = await call(app, "POST", `/admin/bonuses/${bonusId}/${name}`, await A(), { expectedVersion: current.version });
  expect(res.statusCode, res.body).toBe(200);
}
/** Progress as the admin reads it (GET /admin/bonuses/{id}/drivers), keyed by the fixture's driver ids. */
async function progressOf(bonusId: string, ids: Map<string, string>) {
  const items = (await call(app, "GET", `/admin/bonuses/${bonusId}/drivers?limit=200`, await A())).json().items as Json[];
  const byDb = new Map(items.map((p) => [p["driverId"], p]));
  const out: Record<string, Json | null> = {};
  for (const [fixtureId, dbId] of ids) {
    const p = byDb.get(dbId);
    out[fixtureId] = p ? { done: p["progress"]["done"], target: p["progress"]["target"], earned: p["earned"], ...(p["earnedAt"] ? { earnedAt: iso(p["earnedAt"]) } : {}) } : null;
  }
  return out;
}
async function entriesOf(bonusId: string, ids: Map<string, string>) {
  const back = new Map([...ids].map(([f, d]) => [d, f]));
  const rows = await database.db.selectFrom("earnings_entries").select(["driver_id", "kind", "trip_id", "amount_minor", "currency", "at"]).where("bonus_id", "=", bonusId).orderBy("at").execute();
  return rows.map((r) => ({ driverId: back.get(r.driver_id), kind: r.kind, tripId: r.trip_id, amount: { amountMinor: Number(r.amount_minor), currency: r.currency }, at: iso(r.at.toISOString()) }));
}
/** The fixture's drivers: d → { done, target, earned }; a driver with no progress row reads as done 0. */
function expectDrivers(got: Record<string, Json | null>, want: Record<string, Json>, target: number) {
  for (const [d, w] of Object.entries(want)) expect(got[d] ?? { done: 0, target, earned: false }, d).toEqual(w);
}

describe("fixtures validate: POST /admin/bonuses answers each case (SEK, EUR, TND; MF6 area inside the zone)", () => {
  for (const x of F["validate"]!) {
    it(`${x["id"]} → ${x["expect"]}`, async () => {
      expect(x["today"]).toBe("2026-11-14");
      const res = await create(ZONE_OF[x["zone"]["currency"]]!, x["input"]);
      if (x["expect"] === "ok") {
        expect(res.statusCode, res.body).toBe(201);
        expect(res.json()).toMatchObject({ amount: x["input"]["amount"], target: x["input"]["target"], measure: x["input"]["measure"], currency: x["zone"]["currency"], status: "active", state: x["input"]["startDate"] > x["today"] ? "scheduled" : "active", driversEarned: 0, paidTotal: { amountMinor: 0, currency: x["zone"]["currency"] } });
      } else {
        expect(res.statusCode, res.body).toBe(400);
        expect(res.json()).toMatchObject({ code: "invalid_request", reason: x["expect"] });
      }
    });
  }
});

describe("fixtures trips: creditTrip counts paid ends (window, pickup in the area, pause, end, once per trip, MF5 zone drivers, MF7 rider limit)", () => {
  for (const x of F["trips"]!) {
    it(x["id"], async () => {
      const c = x["campaign"];
      const campaign = await makeCampaign(c);
      const phones = new Map<string, string>();
      const phone = (p: string) => (phones.has(p) ? phones.get(p)! : (phones.set(p, seedPhone("+4673")), phones.get(p)!));
      const ids = new Map<string, string>();
      for (const [d, info] of Object.entries(x["drivers"] as Record<string, Json>)) {
        const id = await insertDriver(database.db);
        await database.db.updateTable("drivers").set({ zone_ids: info["zoneIds"], account_status: "active", phone: phone(info["phone"]) }).where("driver_id", "=", id).execute();
        ids.set(d, id);
      }
      const riders = new Map<string, string>();
      const trips = new Map<string, TripRow>();
      type Ev = { at: Date; trip?: Json; command?: "pause" | "resume" | "end" };
      const events: Ev[] = [...adminEvents(c), ...(x["trips"] as Json[]).map((t) => ({ at: ts(t["paidEndAt"]), trip: t }))];
      events.sort((a, b) => a.at.getTime() - b.at.getTime() || (a.command ? -1 : 0) - (b.command ? -1 : 0));
      for (const ev of events) {
        if (ev.command) { await command(campaign["bonusId"], ev.command, ev.at); continue; }
        const t = ev.trip!;
        clock.now = ev.at;
        if (!riders.has(t["riderId"])) riders.set(t["riderId"], await insertRider(database.db, { phone: phone(t["riderPhone"]) }));
        let trip = trips.get(t["tripId"]);
        if (!trip) {
          const id = await insertTrip(database.db, riders.get(t["riderId"])!, { status: "accepted", driverId: ids.get(t["driverId"])! });
          const lines = [{ code: "base", amount: { amountMinor: 10_000, currency: c["amount"]["currency"] } }];
          await database.db.updateTable("trips").set({
            zone_id: c["zoneId"], currency: c["amount"]["currency"], pickup: JSON.stringify({ lat: t["pickup"][0], lng: t["pickup"][1], address: "Pickup" }),
            status: t["paidEnd"] ? "completed" : "cancelled_by_rider", fare_minor: 10_000, fare_lines: JSON.stringify(lines), driver_earnings_minor: 8_000, pickup_pay_minor: 0, driver_bonus_minor: 0,
            commission_minor: commissionOf(10_000, lines, 8_000, 0, 0), ended_at: ev.at, payment_status: t["paidEnd"] ? "captured" : null,
          }).where("trip_id", "=", id).execute();
          trip = (await database.db.selectFrom("trips").selectAll().where("trip_id", "=", id).executeTakeFirstOrThrow()) as unknown as TripRow;
          trips.set(t["tripId"], trip);
        }
        // An unpaid end never reaches creditTrip (the server credits paid ends only).
        if (t["paidEnd"]) await database.db.transaction().execute((trx) => creditTrip(trx, trip!, ev.at));
      }
      const want = x["expect"];
      expectDrivers(await progressOf(campaign["bonusId"], ids), want["drivers"], c["target"]);
      // MF5: a driver outside the campaign's zone is never counted and not listed.
      for (const [d, id] of ids) if (!(d in want["drivers"])) expect((await progressOf(campaign["bonusId"], new Map([[d, id]])))[d]).toBeNull();
      expect(await entriesOf(campaign["bonusId"], ids)).toEqual(want["entries"]);
    });
  }
});

describe("fixtures hours: POST /driver/location counts online time (gap, accuracy, offline, on_trip, MF3 online_since / server time / jump / 30 s)", () => {
  for (const x of F["hours"]!) {
    it(x["id"], async () => {
      const c = x["campaign"];
      const campaign = await makeCampaign(c);
      const ids = new Map<string, string>();
      const phoneOf = new Map<string, string>();
      let k = 1;
      for (const [d, info] of Object.entries(x["drivers"] as Record<string, Json>)) {
        const phone = TEST_PHONES[k++]!;
        await signIn(app, phone, "driver");
        const row = await database.db.selectFrom("drivers").select("driver_id").where("phone", "=", phone).executeTakeFirstOrThrow();
        await database.db.updateTable("drivers").set({ zone_ids: info["zoneIds"], account_status: "active", online_status: "online", online_since: ts(info["onlineSince"]) }).where("driver_id", "=", row.driver_id).execute();
        ids.set(d, row.driver_id);
        phoneOf.set(d, phone);
      }
      const all: Json[] = [...(x["fixes"] as Json[])];
      for (const s of x["series"] as Json[]) {
        for (let i = 0; i < s["count"]; i++) all.push({ driverId: s["driverId"], at: new Date(ts(s["from"]).getTime() + s["everySeconds"] * 1000 * i).toISOString(), point: s["point"], accuracyMeters: s["accuracyMeters"], status: s["status"] });
      }
      // One POST per arrival: fixes that name the same receivedAt arrived together (one batch); the rest one by one.
      type Post = { driverId: string; receivedAt: Date; status: string; fixes: Json[] };
      const posts: Post[] = [];
      for (const f of all) {
        const last = posts.at(-1);
        if (f["receivedAt"] && last && last.driverId === f["driverId"] && last.receivedAt.toISOString() === ts(f["receivedAt"]).toISOString()) { last.fixes.push(f); continue; }
        posts.push({ driverId: f["driverId"], receivedAt: ts(f["receivedAt"] ?? f["at"]), status: f["status"], fixes: [f] });
      }
      type Ev = { at: Date; post?: Post; command?: "pause" | "resume" | "end" };
      const events: Ev[] = [...adminEvents(c), ...posts.map((p) => ({ at: p.receivedAt, post: p }))];
      // Arrival order (the fixture's list order) is kept; the admin's commands go in at their times.
      const ordered: Ev[] = [];
      const admins = events.filter((e) => e.command).sort((a, b) => a.at.getTime() - b.at.getTime());
      for (const e of events.filter((e) => e.post)) {
        while (admins.length && admins[0]!.at.getTime() <= e.at.getTime()) ordered.push(admins.shift()!);
        ordered.push(e);
      }
      ordered.push(...admins);
      for (const ev of ordered) {
        if (ev.command) { await command(campaign["bonusId"], ev.command, ev.at); continue; }
        const p = ev.post!;
        clock.now = p.receivedAt;
        const id = ids.get(p.driverId)!;
        await database.db.updateTable("drivers").set({ online_status: p.status as "online" }).where("driver_id", "=", id).execute();
        const headers = (await signIn(app, phoneOf.get(p.driverId)!, "driver")).headers;
        const res = await call(app, "POST", "/driver/location", headers, { fixes: p.fixes.map((f) => ({ lat: f["point"][0], lng: f["point"][1], accuracy: f["accuracyMeters"], measuredAt: f["at"] })) });
        expect(res.statusCode, res.body).toBe(200);
      }
      const want = x["expect"];
      expectDrivers(await progressOf(campaign["bonusId"], ids), want["drivers"], c["target"] * 60);
      expect(await entriesOf(campaign["bonusId"], ids)).toEqual(want["entries"]);
      // The driver's own view shows the same numbers (GET /driver/bonuses).
      for (const [d, w] of Object.entries(want["drivers"] as Record<string, Json>)) {
        const mine = (await call(app, "GET", "/driver/bonuses", (await signIn(app, phoneOf.get(d)!, "driver")).headers)).json().items.find((i: Json) => i["bonusId"] === campaign["bonusId"]);
        expect({ ...mine["progress"], earned: mine["earned"], ...(mine["earnedAt"] ? { earnedAt: iso(mine["earnedAt"]) } : {}) }).toEqual(w);
      }
      for (const id of ids.values()) await database.db.updateTable("drivers").set({ online_status: "offline", zone_ids: [] }).where("driver_id", "=", id).execute();
    });
  }
});

const SUPER = { actor: "admin", subjectId: "adm_v44", sessionId: "s_v44", zones: ["*"], role: "super", perms: [] } as unknown as Principal;

describe("fixtures payout: Payout.lines / amount and Driver gets / Movera gets in both views (MF4)", () => {
  for (const x of F["payout"]!) {
    it(x["id"], async () => {
      const cur = x["currency"] as string;
      const zoneId = ZONE_OF[cur]!;
      const m = (n: number) => ({ amountMinor: n, currency: cur });
      const driverId = await insertDriver(database.db);
      const riderId = await insertRider(database.db);
      const IN = new Date("2026-11-20T10:00:00Z");
      // A campaign for the campaign entries (the entry's bonus_id).
      clock.now = CREATE_AT;
      const zone = await database.db.selectFrom("zones").select("polygon").where("zone_id", "=", zoneId).executeTakeFirstOrThrow();
      const area = (zone.polygon as Polygon).slice(0, 3) as Polygon;
      const campaign = (await create(zoneId, { measure: "trips", target: 1, amount: m(1000), startDate: "2026-11-16", endDate: "2026-11-30", polygon: area })).json();
      const tripEntries = (x["entries"] as Json[]).filter((e) => e["kind"] === "trip");
      // Each trip: Movera keeps its share of moveraKeepsNowOfTrips (split over the trips, the rest on the last).
      let keptLeft = x["moveraKeepsNowOfTrips"] as number;
      let tripTotal = 0;
      let lastTrip: string | null = null;
      for (const [i, e] of tripEntries.entries()) {
        const kept = i === tripEntries.length - 1 ? keptLeft : Math.round((x["moveraKeepsNowOfTrips"] * e["amountMinor"]) / tripEntries.reduce((s: number, t: Json) => s + t["amountMinor"], 0));
        keptLeft -= kept;
        const tripBonus = (x["entries"] as Json[]).filter((b) => b["kind"] === "bonus" && !b["campaign"] && !b["lostDriver"]).reduce((s: number, b: Json) => s + b["amountMinor"], 0);
        const bonus = i === 0 ? tripBonus : 0;
        const fare = e["amountMinor"] + kept + bonus;
        const lines = [{ code: "base", amount: m(fare - e["waitingMinor"]) }, ...(e["waitingMinor"] ? [{ code: "waiting", amount: m(e["waitingMinor"]) }] : [])];
        const id = await insertTrip(database.db, riderId, { status: "completed", driverId });
        const cash = e["cashMinor"] > 0;
        await database.db.updateTable("trips").set({
          zone_id: zoneId, currency: cur, fare_minor: fare, booked_fare_minor: fare, fare_lines: JSON.stringify(lines), driver_earnings_minor: e["amountMinor"], pickup_pay_minor: 0, driver_bonus_minor: bonus,
          commission_minor: commissionOf(fare, lines, e["amountMinor"], 0, bonus), driver_adjustments_minor: 0, lost_driver_paid_minor: 0, payment_method: cash ? "cash" : "card", ended_at: IN,
          ended_by_command: "complete", payment_status: "captured", cash_collected_minor: cash ? e["cashMinor"] : 0,
        }).where("trip_id", "=", id).execute();
        const row = (await database.db.selectFrom("trips").selectAll().where("trip_id", "=", id).executeTakeFirstOrThrow()) as unknown as TripRow;
        tripTotal += ((tripProjection(row, "admin")["moveraKeepsNow"] as { amountMinor: number }) ?? { amountMinor: 0 }).amountMinor;
        await database.db.insertInto("earnings_entries").values({ entry_id: `ern_v44p_${id}`, driver_id: driverId, trip_id: id, kind: "trip", currency: cur, amount_minor: e["amountMinor"], gross_minor: null, commission_minor: null, cash_minor: e["cashMinor"], at: IN }).execute();
        if (bonus) await database.db.insertInto("earnings_entries").values({ entry_id: `ern_v44p_${id}_b`, driver_id: driverId, trip_id: id, kind: "bonus", currency: cur, amount_minor: bonus, gross_minor: null, commission_minor: null, cash_minor: null, at: IN }).execute();
        lastTrip = id;
      }
      expect(lastTrip).not.toBeNull();
      // The fixture's moveraKeepsNowOfTrips is what the server's own projection gives for these trips.
      expect(tripTotal).toBe(x["moveraKeepsNowOfTrips"]);
      let n = 0;
      for (const e of x["entries"] as Json[]) {
        if (e["kind"] === "bonus" && e["campaign"]) {
          await database.db.insertInto("earnings_entries").values({ entry_id: `ern_v44c_${driverId}`, driver_id: driverId, trip_id: null, kind: "bonus", currency: cur, amount_minor: e["amountMinor"], gross_minor: null, commission_minor: null, cash_minor: null, at: IN, bonus_id: campaign["bonusId"] }).execute();
        } else if (e["kind"] === "bonus" && e["lostDriver"]) {
          // The lost-driver payment: a bonus on a trip he lost (cancelled, no paid end).
          const lost = await insertTrip(database.db, riderId, { status: "cancelled_by_admin", driverId: null });
          await database.db.updateTable("trips").set({ zone_id: zoneId, currency: cur, lost_driver_paid_minor: e["amountMinor"], ended_at: IN }).where("trip_id", "=", lost).execute();
          await database.db.insertInto("earnings_entries").values({ entry_id: `ern_v44l_${driverId}_${++n}`, driver_id: driverId, trip_id: lost, kind: "bonus", currency: cur, amount_minor: e["amountMinor"], gross_minor: null, commission_minor: null, cash_minor: null, at: IN }).execute();
        } else if (e["kind"] === "paid_to_movera") {
          await database.db.insertInto("earnings_entries").values({ entry_id: `ern_v44m_${driverId}_${++n}`, driver_id: driverId, trip_id: null, kind: "paid_to_movera", currency: cur, amount_minor: e["amountMinor"], gross_minor: null, commission_minor: null, cash_minor: null, at: IN }).execute();
        }
      }
      const [payout] = await database.db.transaction().execute((trx) => makePayouts(trx, { driverId, from: new Date("2026-11-16T00:00:00Z"), to: new Date("2026-11-23T00:00:00Z"), source: "manual", by: null }, new Date("2026-11-23T01:00:00Z")));
      const want = x["expect"];
      const lines = Object.fromEntries((payout!.lines as Array<{ code: string; amountMinor: number }>).filter((l) => l.amountMinor !== 0).map((l) => [l.code, l.amountMinor]));
      expect(lines).toEqual(want["lines"]);
      expect(payout!.trip_count).toBe(want["tripCount"]);
      expect(Number(payout!.amount_minor)).toBe(want["amountMinor"]);
      const adminView = (await listPayouts(database.db, SUPER, { limit: 10, driverId })).items.find((p) => p.payoutId === payout!.payout_id)!;
      const driverView = (await driverPayouts(database.db, driverId, { limit: 10 })).items.find((p) => p.payoutId === payout!.payout_id)!;
      expect(adminView.summary).toEqual({ driverGets: want["driverGets"], moveraGets: want["moveraGets"]["admin"] });
      expect(driverView.summary).toEqual({ driverGets: want["driverGets"], moveraGets: want["moveraGets"]["driver"] });
    });
  }
});

describe("fixtures kpi: countDay puts a campaign award on its zone and zone-local day, once (MF8)", () => {
  for (const x of F["kpi"]!) {
    it(x["id"], async () => {
      const tz = x["timeZone"] as string;
      const zone = await database.db.selectFrom("zones").select(["zone_id", "time_zone", "currency"]).where("time_zone", "=", tz).where("zone_id", "in", Object.values(ZONE_OF)).executeTakeFirstOrThrow();
      const before = await countDay(database.db, zone, x["day"]);
      const area = ((await database.db.selectFrom("zones").select("polygon").where("zone_id", "=", zone.zone_id).executeTakeFirstOrThrow()).polygon as Polygon).slice(0, 3) as Polygon;
      const campaign = (await create(zone.zone_id, { measure: "trips", target: 1, amount: { amountMinor: 1000, currency: zone.currency }, startDate: "2026-11-15", endDate: "2026-11-30", polygon: area })).json();
      for (const [i, e] of (x["campaignEntries"] as Json[]).entries()) {
        const driverId = await insertDriver(database.db);
        const entryId = `ern_v44k_${x["id"]}_${i}`;
        await database.db.insertInto("earnings_entries").values({ entry_id: entryId, driver_id: driverId, trip_id: null, kind: "bonus", currency: zone.currency, amount_minor: e["amountMinor"], gross_minor: null, commission_minor: null, cash_minor: null, at: ts(e["at"]), bonus_id: campaign["bonusId"] }).execute();
        await database.db.insertInto("bonus_progress").values({ bonus_id: campaign["bonusId"], driver_id: driverId, trips: 1, earned_at: ts(e["at"]), entry_id: entryId, updated_at: ts(e["at"]) }).execute();
      }
      const after = await countDay(database.db, zone, x["day"]);
      const want = x["expect"];
      expect(after.driverBonus - before.driverBonus).toBe(want["driverBonus"] - x["before"]["driverBonus"]);
      expect(after.moveraEarnings - before.moveraEarnings).toBe(want["moveraEarnings"] - x["before"]["moveraEarnings"]);
      // Nothing else of the day moves.
      expect({ ...after, driverBonus: 0, moveraEarnings: 0 }).toEqual({ ...before, driverBonus: 0, moveraEarnings: 0 });
    });
  }
});
