import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { sweepAlerts } from "../../src/alerts/detector.js";
import { insertRider, insertTrip } from "../support/seed.js";
import { fakeOsrm, Sim, type Admin, type Json } from "./harness.js";

/**
 * v0.18.20 server-side alerts through the admin API (contract.json#alertDesk.serverDetection): the book carries the
 * alerts the server found, only of the admin's country / zones / groups; a command on a server alert uses the server's
 * kind, zone and title (never the panel's); done closes it. Fails before: no `alerts` in AlertBookState.
 */

let sim: Sim;
let osrm: Awaited<ReturnType<typeof fakeOsrm>>;
let owner: Admin;
let se: Admin;
let fr: Admin;
const NOW = new Date("2026-11-04T16:30:00Z");

async function waitingTrip(zone: string, currency: string) {
  const riderId = await insertRider(sim.db);
  const id = await insertTrip(sim.db, riderId);
  await sim.db.updateTable("trips").set({ zone_id: zone, currency, status: "searching", search_started_at: new Date(NOW.getTime() - 20 * 60_000) }).where("trip_id", "=", id).execute();
  return id;
}

beforeAll(async () => {
  osrm = await fakeOsrm({ distance: 8000, duration: 1080 });
  sim = await Sim.start({ osrmUrl: osrm.url, now: NOW });
  owner = await sim.owner();
  se = await sim.admin("dispatcher", ["Z001"]);
  fr = await sim.admin("dispatcher", ["FR-PC"]);
});
afterAll(async () => {
  await sim.stop();
  await osrm.close();
});

const longWaits = (book: Json) => (book["alerts"] as Json[]).filter((a) => a["kind"] === "long_wait");

describe("the admin reads the server's alerts", () => {
  it("SE and FR each see their own; a FR admin cannot read SE; a command uses the server's values; done closes it", async () => {
    const seTrip = await waitingTrip("Z001", "SEK");
    const frTrip = await waitingTrip("FR-PC", "EUR");
    await sim.db.transaction().execute((trx) => sweepAlerts(trx, NOW));

    const seBook = (await se.get("/admin/alerts/book?country=SE")).body;
    expect(longWaits(seBook).map((a) => a["causeKey"])).toEqual([`long_wait:${seTrip}`]);
    const alert = longWaits(seBook)[0]!;
    expect(alert).toMatchObject({ state: "open", level: "important", zoneId: "Z001", country: "SE", since: NOW.toISOString(), titleT: { t: "{0} has waited {1} min" }, ref: { tripId: seTrip } });
    const frBook = (await fr.get("/admin/alerts/book?country=FR")).body;
    expect(longWaits(frBook).map((a) => a["causeKey"])).toEqual([`long_wait:${frTrip}`]);
    expect((await fr.get("/admin/alerts/book?country=SE")).status).toBe(403);
    expect(longWaits((await owner.get("/admin/alerts/book?country=SE")).body)).toHaveLength(1);

    // The panel sends something else: the server's kind, zone and title win.
    const taken = await se.post(`/admin/alerts/${alert["alertId"]}/take`, { kind: "few_drivers", level: "info", title: "made up", zoneId: "Z002", since: "2020-01-01T00:00:00Z" });
    expect(taken.status).toBe(200);
    const record = (taken.body["records"] as Json[]).find((r) => r["alertId"] === alert["alertId"])!;
    expect(record).toMatchObject({ kind: "long_wait", zoneId: "Z001", title: alert["title"], since: NOW.toISOString(), owner: se.id });
    const outside = await fr.post(`/admin/alerts/${alert["alertId"]}/take`, { kind: "long_wait", level: "info", title: "x", zoneId: "FR-PC", since: NOW.toISOString() });
    expect([outside.status, outside.body["reason"]]).toEqual([403, "zone_out_of_scope"]);

    const done = await se.post(`/admin/alerts/${alert["alertId"]}/done`, { kind: "long_wait", level: "important", title: "x", since: NOW.toISOString(), note: "Called a driver" });
    expect(done.status).toBe(200);
    expect(longWaits(done.body)).toHaveLength(0);
    // Still waiting: no new alert for the same cause after done.
    await sim.db.transaction().execute((trx) => sweepAlerts(trx, new Date(NOW.getTime() + 60_000)));
    expect(longWaits((await se.get("/admin/alerts/book?country=SE")).body)).toHaveLength(0);
  });
});

describe("checker LOW fixes", () => {
  it("the zone filter runs before the 1000-row limit; an action on a no-zone alert answers with its own country's book", async () => {
    const now = new Date(NOW.getTime() + 3_600_000);
    // 1 000 open alerts of another SE zone, then one of Z001: the Z001 admin still sees his.
    await sim.db.executeQuery(sql`INSERT INTO admin_alerts_live (alert_id, cause_key, kind, country, zone_id, level, title, title_t, since, state, seen_at, updated_at)
      SELECT 'few_drivers:x' || g, 'few_drivers:x' || g, 'few_drivers', 'SE', 'Z002', 'important', 'x', '{"t":"x","a":[]}', ${new Date(NOW.getTime() - 3_600_000)}, 'open', ${now}, ${now} FROM generate_series(1, 1000) g`.compile(sim.db));
    await sim.db.executeQuery(sql`INSERT INTO admin_alerts_live (alert_id, cause_key, kind, country, zone_id, level, title, title_t, since, state, seen_at, updated_at)
      VALUES ('no_driver:Z001.z', 'no_driver:Z001', 'no_driver', 'SE', 'Z001', 'critical', 'mine', '{"t":"mine","a":[]}', ${now}, 'open', ${now}, ${now})`.compile(sim.db));
    const book = (await se.get("/admin/alerts/book?country=SE")).body;
    expect((book["alerts"] as Json[]).map((a) => a["alertId"])).toContain("no_driver:Z001.z");
    await sim.db.executeQuery(sql`INSERT INTO admin_alerts_live (alert_id, cause_key, kind, country, zone_id, level, title, title_t, since, state, seen_at, updated_at)
      VALUES ('system_health:timers:FR.z', 'system_health:timers:FR', 'system_health', 'FR', NULL, 'important', 'jobs', '{"t":"jobs","a":[]}', ${now}, 'open', ${now}, ${now})`.compile(sim.db));
    const taken = await owner.post("/admin/alerts/system_health:timers:FR.z/take", { kind: "system_health", level: "important", title: "jobs", since: now.toISOString() });
    expect(taken.status).toBe(200);
    expect(taken.body["country"]).toBe("FR");
  });
});

