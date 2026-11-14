import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { sweepAlerts, pokeAlerts, closeLiveAlert, ALERT_SWEEP } from "../../src/alerts/detector.js";
import { MAX_ATTEMPTS } from "../../src/jobs/timers.js";
import { newId } from "../../src/ids.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver, insertRider, insertTrip } from "../support/seed.js";

/**
 * v0.18.23 server-side alerts (contract.json#alertDesk.serverDetection; Rules BASE job 4, owner 2026-11-04 A1–A3).
 * One test per kind, each in Sweden and France: the server raises it, a second sweep makes no duplicate, it is solved
 * by itself (green, with what happened) when the cause ends, and it carries the zone and country it belongs to.
 * Fails before: no detector (src/alerts/detector.ts), no admin_alerts_live table.
 */

let database: TestDatabase;
const NOW = new Date("2026-11-04T16:30:00Z");
const min = (n: number) => new Date(NOW.getTime() - n * 60_000);
const later = (n: number) => new Date(NOW.getTime() + n * 60_000);

beforeEach(async () => {
  database = await freshDatabase();
});
afterEach(async () => {
  await database.drop();
});

const db = () => database.db;
const sweep = (at: Date = NOW) => db().transaction().execute((trx) => sweepAlerts(trx, at));
const live = async (kind?: string) => {
  let q = db().selectFrom("admin_alerts_live").selectAll().orderBy("since");
  if (kind) q = q.where("kind", "=", kind);
  return q.execute();
};
const one = async (kind: string) => {
  const rows = await live(kind);
  expect(rows.length, `${kind} rows`).toBe(1);
  return rows[0]!;
};
/** Raise → no duplicate on a second sweep → same row. */
async function raised(kind: string, at: Date = NOW) {
  await sweep(at);
  const first = await one(kind);
  expect(first.state).toBe("open");
  await sweep(at);
  const again = await one(kind);
  expect(again.alert_id).toBe(first.alert_id);
  return again;
}
async function solved(kind: string, at: Date = NOW) {
  await sweep(at);
  const row = await one(kind);
  expect(row.state).toBe("solved");
  return row;
}
const text = (t: unknown) => {
  const v = t as { t: string; a: unknown[] };
  return v.t.replace(/\{(\d+)\}/g, (_, i: string) => String(v.a[Number(i)]));
};

const COUNTRIES = [
  { country: "SE", zone: "Z001", currency: "SEK", tz: "Europe/Stockholm", local: "17:30" },
  { country: "FR", zone: "FR-PC", currency: "EUR", tz: "Europe/Paris", local: "17:30" },
] as const;

async function rider(firstName = "Lina") {
  const id = await insertRider(db());
  await db().updateTable("riders").set({ first_name: firstName }).where("rider_id", "=", id).execute();
  return id;
}
async function driver(zone: string, set: Record<string, unknown> = {}, firstName = "Ali") {
  const id = await insertDriver(db());
  await db().updateTable("drivers").set({ first_name: firstName, zone_ids: [zone], account_status: "active", ...set } as never).where("driver_id", "=", id).execute();
  return id;
}
/** The driver's latest position, in a zone (the live position the server counts free drivers by). */
async function at(driverId: string, zone: string | null) {
  await db().insertInto("driver_locations").values({ driver_id: driverId, lat: 59.33, lng: 18.06, accuracy: 5, measured_at: NOW, received_at: NOW, zone_id: zone } as never).onConflict((oc) => oc.column("driver_id").doUpdateSet({ zone_id: zone } as never)).execute();
}
async function trip(zone: string, currency: string, set: Record<string, unknown> = {}, kind: "live" | "scheduled" = "live") {
  const riderId = await rider();
  const id = await insertTrip(db(), riderId, { kind });
  await db().updateTable("trips").set({ zone_id: zone, currency, ...set } as never).where("trip_id", "=", id).execute();
  return { id, riderId };
}
async function settings(country: string, doc: unknown, rules: unknown[] = []) {
  await db().insertInto("admin_alert_book").values({ country, settings: JSON.stringify(doc), rules: JSON.stringify(rules) } as never).onConflict((oc) => oc.column("country").doUpdateSet({ settings: JSON.stringify(doc), rules: JSON.stringify(rules) } as never)).execute();
}
async function incident(zone: string, kind: string, set: Record<string, unknown> = {}) {
  const t = await trip(zone, "SEK", { status: "in_trip" });
  const driverId = await driver(zone);
  const id = newId("inc", NOW.getTime());
  await db().insertInto("incidents").values({ incident_id: id, trip_id: t.id, kind, severity: "critical", raised_by: "rider", zone_id: zone, rider_id: t.riderId, driver_id: driverId, opened_at: min(3), updated_at: min(3), alarm: true, ...set } as never).execute();
  return id;
}

for (const c of COUNTRIES) {
  describe(`${c.country}: dispatch kinds`, () => {
    it("long_wait: Important at the zone's live at-risk minutes (A1 default 15), Critical at 30; green 'Driver Ali took it' when taken", async () => {
      const t = await trip(c.zone, c.currency, { status: "searching", search_started_at: min(14) });
      await sweep();
      expect(await live("long_wait")).toHaveLength(0);
      const row = await raised("long_wait", later(1));
      expect(row).toMatchObject({ level: "important", country: c.country, zone_id: c.zone, cause_key: `long_wait:${t.id}` });
      expect(row.since).toEqual(later(1));
      expect(row.title).toBe("Lina has waited 15 min");
      await sweep(later(17));
      expect(await one("long_wait")).toMatchObject({ level: "critical", title: "Lina has waited 31 min" });
      const d = await driver(c.zone);
      await db().updateTable("trips").set({ driver_id: d, status: "accepted", accepted_at: NOW }).where("trip_id", "=", t.id).execute();
      const done = await solved("long_wait", later(18));
      expect(text(done.solved_t)).toBe(`Driver Ali took it ${c.local}`);
      expect(done.since).toEqual(later(1));
    });

    it("long_wait: the zone setting moves the at-risk minutes (admin setting per zone)", async () => {
      await settings(c.country, { zones: { [c.zone]: { liveAtRiskMin: 20 } } });
      await trip(c.zone, c.currency, { status: "searching", search_started_at: min(16) });
      await sweep();
      expect(await live("long_wait")).toHaveLength(0);
      await raised("long_wait", later(5));
    });

    it("few_drivers and no_driver per zone, from the zone limits", async () => {
      for (let i = 0; i < 5; i += 1) await trip(c.zone, c.currency, { status: "searching", search_started_at: min(1) });
      await at(await driver(c.zone, { online_status: "online" }), c.zone);
      expect(await raised("few_drivers")).toMatchObject({ level: "important", zone_id: c.zone, cause_key: `few_drivers:${c.zone}` });
      expect(await one("no_driver")).toMatchObject({ level: "critical", title: expect.stringMatching(/^5 requests without a driver in /) });
      await db().updateTable("trips").set({ status: "cancelled_by_rider" }).where("zone_id", "=", c.zone).execute();
      expect(text((await solved("few_drivers")).solved_t)).toBe(`Enough drivers again ${c.local}`);
      expect((await one("no_driver")).state).toBe("solved");
    });
  });

  describe(`${c.country}: booked rides`, () => {
    it("booked_at_risk: no driver 15 min (A1 default) before pickup; late_reservation (switched on) before that; green when a driver takes it", async () => {
      await settings(c.country, { kinds: { late_reservation: { on: true } } });
      const t = await trip(c.zone, c.currency, { status: "requested", scheduled_at: later(40) }, "scheduled");
      await sweep();
      expect((await one("late_reservation")).level).toBe("important");
      expect(await live("booked_at_risk")).toHaveLength(0);
      const row = await raised("booked_at_risk", later(26));
      expect(row).toMatchObject({ level: "important", zone_id: c.zone });
      expect((await one("late_reservation")).state).toBe("solved");
      const d = await driver(c.zone);
      await db().updateTable("trips").set({ driver_id: d, status: "accepted", accepted_at: later(27), reservation: JSON.stringify({ held: true, leaveAt: later(35).toISOString() }) }).where("trip_id", "=", t.id).execute();
      expect(text((await solved("booked_at_risk", later(27))).solved_t)).toMatch(/^Driver Ali took it \d\d:\d\d$/);
    });

    it("booked_at_risk: the zone's booked minutes are their own setting (separate from live)", async () => {
      await settings(c.country, { zones: { [c.zone]: { bookedAtRiskMin: 30, liveAtRiskMin: 5 } } });
      await trip(c.zone, c.currency, { status: "requested", scheduled_at: later(29) }, "scheduled");
      await raised("booked_at_risk");
    });

    it("booked_late: pickup time passed with no driver", async () => {
      await trip(c.zone, c.currency, { status: "searching", scheduled_at: min(2) }, "scheduled");
      const row = await raised("booked_late");
      expect(row).toMatchObject({ level: "critical" });
      expect(row.title).toBe(`Lina's booked ride: pickup time ${c.country === "SE" ? "17:28" : "17:28"} passed, no driver`);
    });

    it("booked_not_started: leave time passed, driver holds it and has not started; green when he starts", async () => {
      const d = await driver(c.zone);
      const t = await trip(c.zone, c.currency, { status: "accepted", driver_id: d, scheduled_at: later(10), reservation: JSON.stringify({ held: true, leaveAt: min(1).toISOString() }) }, "scheduled");
      expect(await raised("booked_not_started")).toMatchObject({ level: "critical" });
      await db().updateTable("trips").set({ status: "driver_to_pickup", reservation: JSON.stringify({ held: false }) }).where("trip_id", "=", t.id).execute();
      expect(text((await solved("booked_not_started")).solved_t)).toMatch(/^Driver Ali started /);
    });
  });

  describe(`${c.country}: safety kinds`, () => {
    it("sos and sos_slow; green 'Closed in Incidents' when the case is solved", async () => {
      const id = await incident(c.zone, "sos", { status: "investigating", taken_at: min(16), taken_by: null });
      expect(await raised("sos")).toMatchObject({ level: "critical", title: "SOS from Lina", zone_id: c.zone });
      expect(await one("sos_slow")).toMatchObject({ level: "important", title: "SOS from Lina not solved after 16 min" });
      await db().updateTable("incidents").set({ status: "resolved", resolved_at: NOW }).where("incident_id", "=", id).execute();
      expect(text((await solved("sos")).solved_t)).toBe(`Closed in Incidents ${c.local}`);
    });

    it("car_lost from the driver_silent incident", async () => {
      const id = await incident(c.zone, "driver_silent", { raised_by: "system" });
      expect(await raised("car_lost")).toMatchObject({ level: "critical", title: "Car lost: Ali" });
      await db().updateTable("incidents").set({ status: "resolved", resolved_at: NOW }).where("incident_id", "=", id).execute();
      await solved("car_lost");
    });

    it("ride_check from an alarmed ride_check incident (not from a quiet one)", async () => {
      await incident(c.zone, "ride_check", { alarm: false, ride_check: JSON.stringify({ trigger: "stop" }) });
      await sweep();
      expect(await live("ride_check")).toHaveLength(0);
      await incident(c.zone, "ride_check", { ride_check: JSON.stringify({ trigger: "crash" }) });
      const row = await raised("ride_check");
      expect(row.title).toBe("Ride check: Possible crash");
      expect(row.title_t).toMatchObject({ t: "Ride check: {0}", x: [0] });
    });

    it("B-j/P20: a ride_check alert turns solved by itself (green, kept) once its trip ended", async () => {
      const id = await incident(c.zone, "ride_check", { ride_check: JSON.stringify({ trigger: "stop" }) });
      await raised("ride_check");
      const tripId = (await db().selectFrom("incidents").select("trip_id").where("incident_id", "=", id).executeTakeFirstOrThrow()).trip_id!;
      await db().updateTable("trips").set({ status: "completed", ended_at: NOW } as never).where("trip_id", "=", tripId).execute();
      const row = await solved("ride_check");
      expect(text(row.solved_t)).toBe(`Trip ended ${c.local}`);
      // The incident itself is untouched (only the admin closes it).
      expect((await db().selectFrom("incidents").select("status").where("incident_id", "=", id).executeTakeFirstOrThrow()).status).toBe("open");
    });

    it("owner Q-Bj: SOS / car lost never close by themselves; trip ended + 24 h -> Old list (still open)", async () => {
      const sosId = await incident(c.zone, "sos");
      const lostId = await incident(c.zone, "driver_silent", { raised_by: "system" });
      await raised("sos");
      await raised("car_lost");
      const tripOf = async (iid: string) => (await db().selectFrom("incidents").select("trip_id").where("incident_id", "=", iid).executeTakeFirstOrThrow()).trip_id!;
      for (const iid of [sosId, lostId]) await db().updateTable("trips").set({ status: "completed", ended_at: NOW } as never).where("trip_id", "=", await tripOf(iid)).execute();
      // Trip ended: still open, not old yet.
      await sweep(later(60));
      expect(await one("sos")).toMatchObject({ state: "open", old_since: null });
      expect(await one("car_lost")).toMatchObject({ state: "open", old_since: null });
      // 24 h after the trip ended: still open, now on the Old list; same alert.
      const first = (await one("sos")).alert_id;
      await sweep(later(24 * 60 + 1));
      const sos = await one("sos");
      expect(sos).toMatchObject({ state: "open", alert_id: first });
      expect(sos.old_since?.toISOString()).toBe(later(24 * 60).toISOString());
      expect((await one("car_lost")).old_since?.toISOString()).toBe(later(24 * 60).toISOString());
      // Days later: never closed by the server.
      await sweep(later(10 * 24 * 60));
      expect((await one("sos")).state).toBe("open");
      // The admin closes it in Incidents -> green as before.
      await db().updateTable("incidents").set({ status: "resolved", resolved_at: NOW }).where("incident_id", "=", sosId).execute();
      expect(text((await solved("sos", later(10 * 24 * 60))).solved_t)).toMatch(/^Closed in Incidents/);
    });
  });

  describe(`${c.country}: drivers, money, riders, system`, () => {
    it("doc_expiring by days left; green when the renewal is approved", async () => {
      const d = await driver(c.zone, { country: c.country });
      await db().insertInto("documents").values({ document_id: newId("doc"), driver_id: d, owner_kind: "driver", owner_id: d, type: "driving_licence", status: "approved", expires_at: later(5 * 1440 + 60) } as never).execute();
      expect(await raised("doc_expiring")).toMatchObject({ level: "important", title: "Ali: driving licence expires in 5 days" });
      // A renewal approved: the current document's date moves (one current document per type).
      await db().updateTable("documents").set({ expires_at: later(800 * 1440) }).where("driver_id", "=", d).execute();
      await solved("doc_expiring");
    });

    it("low_rating from the driver's average", async () => {
      await driver(c.zone, { rating_sum: 41, rating_count: 10 });
      expect(await raised("low_rating")).toMatchObject({ level: "important", title: "Ali has a 4.1 rating" });
    });

    it("auto_offline after offers not accepted; green when back online", async () => {
      const d = await driver(c.zone, { online_status: "offline", offline_reason: "missed_offers", offline_at: min(5) });
      await raised("auto_offline");
      await db().updateTable("drivers").set({ online_status: "online", offline_reason: null }).where("driver_id", "=", d).execute();
      expect(text((await solved("auto_offline")).solved_t)).toBe(`Back online ${c.local}`);
    });

    it("payment_failed; green 'Paid' when the payment goes through", async () => {
      const t = await trip(c.zone, c.currency, { status: "completed", payment_status: "failed", updated_at: min(10) });
      expect(await raised("payment_failed")).toMatchObject({ level: "important", title: `Lina's payment of ${c.currency === "SEK" ? "250,00 kr" : "250,00 €"} failed` });
      await db().updateTable("trips").set({ payment_status: "captured", updated_at: NOW }).where("trip_id", "=", t.id).execute();
      expect(text((await solved("payment_failed")).solved_t)).toBe(`Paid ${c.local}`);
    });

    it("refund_approval while a refund waits", async () => {
      const t = await trip(c.zone, c.currency, { status: "completed" });
      await db().insertInto("refunds").values({ refund_id: newId("rfd"), trip_id: t.id, rider_id: t.riderId, currency: c.currency, amount_minor: 5000, reason: "x", status: "pending_approval", approval_id: null, destination: null, payout_status: null, paid_by: null, created_by: "adm", created_at: NOW } as never).execute();
      expect(await raised("refund_approval")).toMatchObject({ zone_id: c.zone, country: c.country });
    });

    it("payout_big over the limit", async () => {
      const d = await driver(c.zone);
      await db().insertInto("payouts").values({ payout_id: newId("pay"), driver_id: d, zone_id: c.zone, currency: c.currency, amount_minor: 900_000, lines: "[]", trip_count: 3, source: "weekly", status: "pending", period_start: min(10_000), period_end: NOW, note: null, created_by: null, created_at: NOW } as never).execute();
      expect(await raised("payout_big")).toMatchObject({ level: "important" });
    });

    it("rider_cancels from the last 30 days; rider_fraud has no server signal (no fake alert)", async () => {
      const r = await rider("Sara");
      for (let i = 0; i < 6; i += 1) {
        const id = await insertTrip(db(), r);
        await db().updateTable("trips").set({ zone_id: c.zone, status: i < 4 ? "cancelled_by_rider" : "completed", created_at: min(100 + i) }).where("trip_id", "=", id).execute();
      }
      expect(await raised("rider_cancels")).toMatchObject({ level: "important", title: "Sara cancels 67% of rides", zone_id: c.zone });
      expect(await live("rider_fraud")).toHaveLength(0);
    });

    it("ticket_open until someone takes it", async () => {
      const r = await rider();
      const id = newId("tkt");
      await db().insertInto("support_tickets").values({ ticket_id: id, opened_by: "rider", rider_id: r, driver_id: null, trip_id: null, zone_id: c.zone, country: c.country, category: "other", subject: "Help", created_at: NOW, updated_at: NOW, last_message_at: NOW } as never).execute();
      expect(await raised("ticket_open")).toMatchObject({ level: "info", title: "Support ticket from Lina" });
      const adminId = (await db().selectFrom("admins").select("admin_id").executeTakeFirst())?.admin_id ?? null;
      await db().updateTable("support_tickets").set({ status: adminId ? "open" : "resolved", assigned_admin_id: adminId }).where("ticket_id", "=", id).execute();
      await solved("ticket_open");
    });

    it("system_health when background jobs fail and are parked", async () => {
      await db().insertInto("timers").values({ kind: "x_test", ref_id: c.country, due_at: later(600), attempts: MAX_ATTEMPTS }).execute();
      const rows = await (async () => { await sweep(); return live("system_health"); })();
      expect(rows.map((r) => r.country).sort()).toEqual(["FR", "SE", "TN"].filter((x) => rows.some((r) => r.country === x)));
      expect(rows.find((r) => r.country === c.country)).toMatchObject({ zone_id: null, level: "important" });
    });
  });

  describe(`${c.country}: custom rules (owner A3) and the alert life`, () => {
    it("a custom rule alerts once it held forMin minutes, per zone; green when it no longer holds", async () => {
      await settings(c.country, {}, [{ id: "r1", name: "Queue", on: true, metric: "riders_waiting", op: "above", value: 1, forMin: 5, zoneId: c.zone, level: "critical" }]);
      const a = await trip(c.zone, c.currency, { status: "searching", search_started_at: min(1) });
      await trip(c.zone, c.currency, { status: "searching", search_started_at: min(1) });
      await sweep();
      expect(await live("rule")).toHaveLength(0);
      const row = await raised("rule", later(5));
      expect(row).toMatchObject({ level: "critical", title: "Queue: 2 riders in " + row.title.split(" in ")[1], cause_key: `rule:r1:${c.zone}` });
      await db().updateTable("trips").set({ status: "cancelled_by_rider" }).where("trip_id", "=", a.id).execute();
      expect(text((await solved("rule", later(6))).solved_t)).toMatch(/^The rule no longer holds /);
    });

    it("a solved alert whose cause comes back is open again (same alert); done = no new one while the cause stays", async () => {
      const t = await trip(c.zone, c.currency, { status: "searching", search_started_at: min(20) });
      const first = await raised("long_wait");
      await db().updateTable("trips").set({ status: "cancelled_by_rider", updated_at: NOW }).where("trip_id", "=", t.id).execute();
      expect(text((await solved("long_wait")).solved_t)).toBe(`Ride cancelled ${c.local}`);
      await db().updateTable("trips").set({ status: "searching" }).where("trip_id", "=", t.id).execute();
      await sweep();
      expect(await one("long_wait")).toMatchObject({ alert_id: first.alert_id, state: "open", solved_t: null });
      await db().transaction().execute((trx) => closeLiveAlert(trx, first.alert_id, NOW));
      await sweep(later(1));
      expect((await live("long_wait")).map((r) => r.state)).toEqual(["closed"]);
      await db().updateTable("trips").set({ status: "cancelled_by_rider" }).where("trip_id", "=", t.id).execute();
      await sweep(later(2));
      await db().updateTable("trips").set({ status: "searching" }).where("trip_id", "=", t.id).execute();
      await sweep(later(3));
      expect((await live("long_wait")).map((r) => r.state)).toEqual(["closed", "open"]);
    });

    it("a kind switched off in the settings makes no alert and solves its open ones", async () => {
      await trip(c.zone, c.currency, { status: "searching", search_started_at: min(20) });
      await raised("long_wait");
      await settings(c.country, { kinds: { long_wait: { on: false } } });
      await solved("long_wait");
    });
  });
}

describe("one country's settings never change another's", () => {
  it("FR's zone setting does not move a Stockholm alert", async () => {
    await settings("FR", { zones: { Z001: { liveAtRiskMin: 50 } }, kinds: { long_wait: { on: false } } });
    await trip("Z001", "SEK", { status: "searching", search_started_at: min(16) });
    await raised("long_wait");
  });
});

describe("event-driven + periodic", () => {
  it("pokeAlerts books a one-off sweep now; the periodic sweep books itself again in 30 s", async () => {
    await db().transaction().execute((trx) => pokeAlerts(trx, NOW));
    const rows = await db().selectFrom("timers").select(["ref_id", "due_at"]).where("kind", "=", ALERT_SWEEP).execute();
    expect(rows).toEqual([{ ref_id: "poke", due_at: NOW }]);
    const { alertSweepHandler } = await import("../../src/alerts/detector.js");
    await db().transaction().execute((trx) => alertSweepHandler(trx, { timerId: "1", kind: ALERT_SWEEP, refId: "all", dueAt: NOW, payload: {}, attempts: 0, firedAt: NOW }));
    const after = await db().selectFrom("timers").select(["ref_id", "due_at"]).where("kind", "=", ALERT_SWEEP).where("ref_id", "=", "all").execute();
    expect(after).toEqual([{ ref_id: "all", due_at: new Date(NOW.getTime() + 30_000) }]);
    await sql`SELECT 1`.execute(db());
  });
});

/* ---- owner answers 2026-11-04 + checker findings (each failed before the fix) */
for (const c of COUNTRIES) {
  describe(`${c.country}: owner answers and checker fixes`, () => {
    it("owner: 'Booked ride soon with no driver' is OFF by default; an admin can switch it back on", async () => {
      await trip(c.zone, c.currency, { status: "requested", scheduled_at: later(40) }, "scheduled");
      await sweep();
      expect(await live("late_reservation")).toHaveLength(0);
      await settings(c.country, { kinds: { late_reservation: { on: true } } });
      await raised("late_reservation");
    });

    it("owner: free drivers are counted by their live position, not their home zone", async () => {
      for (let i = 0; i < 2; i += 1) await trip(c.zone, c.currency, { status: "searching", search_started_at: min(1) });
      await settings(c.country, { zones: { [c.zone]: { fewDriversLimit: 0 } } });
      const away = await driver(c.zone, { online_status: "online" });
      await at(away, "CDG");
      // His home zone is this one but he is elsewhere: 0 free here.
      expect((await raised("few_drivers")).title).toMatch(/^Only 0 free drivers in /);
      await at(away, c.zone);
      await solved("few_drivers");
    });

    it("checker HIGH 1: a cause that moves zone moves its alert (zone and country)", async () => {
      const t = await trip(c.zone, c.currency, { status: "searching", search_started_at: min(20) });
      await raised("long_wait");
      const other = c.zone === "Z001" ? { zone: "FR-PC", country: "FR" } : { zone: "Z001", country: "SE" };
      await db().updateTable("trips").set({ zone_id: other.zone }).where("trip_id", "=", t.id).execute();
      await sweep(later(1));
      expect(await one("long_wait")).toMatchObject({ zone_id: other.zone, country: other.country, state: "open" });
    });

    it("checker MED 2: a failed payment and an auto-offline stay open past any time window; green only when really solved", async () => {
      const t = await trip(c.zone, c.currency, { status: "completed", payment_status: "failed", updated_at: min(10 * 1440) });
      const d = await driver(c.zone, { online_status: "offline", offline_reason: "missed_offers", offline_at: min(2 * 1440) });
      await raised("payment_failed");
      await raised("auto_offline");
      await sweep(later(20 * 1440));
      expect((await one("payment_failed")).state).toBe("open");
      expect((await one("auto_offline")).state).toBe("open");
      await db().updateTable("trips").set({ payment_status: "captured" }).where("trip_id", "=", t.id).execute();
      await db().updateTable("drivers").set({ online_status: "online", offline_reason: null }).where("driver_id", "=", d).execute();
      expect(text((await solved("payment_failed", later(20 * 1440))).solved_t)).toMatch(/^Paid /);
      expect(text((await solved("auto_offline", later(20 * 1440))).solved_t)).toMatch(/^Back online /);
    });

    it("checker MED 4: an unchanged alert is not written again (seen_at stays)", async () => {
      await trip(c.zone, c.currency, { status: "requested", scheduled_at: min(2) }, "scheduled");
      const first = await raised("booked_late");
      await sweep(later(5));
      expect((await one("booked_late")).seen_at).toEqual(first.seen_at);
    });
  });
}

describe("checker MED 3: two sweeps at once", () => {
  it("both finish, one alert per cause, opened counts only rows written", async () => {
    await trip("Z001", "SEK", { status: "searching", search_started_at: min(20) });
    const [a, b] = await Promise.all([sweep(), sweep()]);
    expect(a.opened + b.opened).toBe((await live()).length);
    expect(await live("long_wait")).toHaveLength(1);
  });

  it("the sweep's scans have their indexes", async () => {
    const rows = await sql<{ indexname: string }>`SELECT indexname FROM pg_indexes WHERE indexname IN ('trips_payment_failed', 'trips_rider_recent', 'drivers_rated_active', 'drivers_missed_offers_offline', 'admin_alerts_live_cause')`.execute(db());
    expect(rows.rows.map((r) => r.indexname).sort()).toEqual(["admin_alerts_live_cause", "drivers_missed_offers_offline", "drivers_rated_active", "trips_payment_failed", "trips_rider_recent"]);
  });
});

describe("live updates (migration 0068): server alerts reach admin screens as alert.changed", () => {
  it("open, solved: each change is one alert.changed event with the alert's zone; an unchanged sweep adds none", async () => {
    const t = await trip("Z001", "SEK", { status: "searching", search_started_at: min(20) });
    const events = () => db().selectFrom("admin_live_events").select(["type", "entity_id", "zone_id"]).where("type", "=", "alert.changed").where("entity_id", "like", "long_wait:%").execute();
    const row = await raised("long_wait");
    expect(await events()).toEqual([{ type: "alert.changed", entity_id: row.alert_id, zone_id: "Z001" }]);
    await db().updateTable("trips").set({ status: "cancelled_by_rider" }).where("trip_id", "=", t.id).execute();
    await solved("long_wait");
    expect(await events()).toHaveLength(2);
  });
});


describe("stress T-A follow-up: a sweep with thousands of new causes", () => {
  it("opens them all (the INSERT goes in chunks; one statement passed 65,535 bind parameters and the sweep was parked)", async () => {
    const first = await trip("Z001", "SEK", { status: "searching", scheduled_at: min(2) }, "scheduled");
    // 4,500 booked rides past their pickup time with no driver: 4,500 booked_late causes, 17 values each.
    await sql`INSERT INTO trips SELECT (jsonb_populate_record(t, jsonb_build_object('trip_id', t.trip_id || '_' || g))).* FROM trips t, generate_series(1, 4499) g WHERE t.trip_id = ${first.id}`.execute(db());
    const result = await sweep();
    expect(result.opened).toBeGreaterThanOrEqual(4_500);
    expect((await live("booked_late")).length).toBe(4_500);
  });
});
