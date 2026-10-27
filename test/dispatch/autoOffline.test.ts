import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { autoOfflineIfDue } from "../../src/dispatch/autoOffline.js";
import { newId } from "../../src/ids.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver, insertRider, insertTrip } from "../support/seed.js";

/** contract.json#autoOffline (v0.8.0): every case of contracts/fixtures/settings_flow.json#autoOffline, on the database. */
const cases = (JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/settings_flow.json`, "utf8")) as { autoOffline: Array<{ id: string; limit: number; offers: string[]; expectOfflineAt: number | null }> }).autoOffline;

let database: TestDatabase;
beforeAll(async () => {
  database = await freshDatabase();
});
afterAll(async () => {
  await database.drop();
});

const KIND = { x: "exclusive", t: "exclusive", r: "radar", a: "assigned", s: "reservation" } as const;
const STATUS = { d: "declined", e: "expired", a: "claimed" } as const;

describe("auto-offline (fixtures/settings_flow.json)", () => {
  for (const c of cases) {
    it(c.id, async () => {
      const db = database.db;
      const zoneId = `ao-${c.id}`.slice(0, 60);
      await db.insertInto("config_live").values({ doc: "driver_app_config", zone_id: zoneId, version: 1, document: JSON.stringify({ offers: { autoOffline: { missedExclusive: c.limit } } }), published_at: new Date(), published_by: null }).execute();
      const driverId = await insertDriver(db);
      let at = new Date("2026-10-27T08:00:00Z").getTime();
      const tick = () => new Date((at += 1000));
      await db.updateTable("drivers").set({ online_status: "online", online_since: tick() }).where("driver_id", "=", driverId).execute();
      let offlineAt: number | null = null;
      for (const [index, token] of c.offers.entries()) {
        if (token === "on") {
          await db.updateTable("drivers").set({ online_status: "online", online_since: tick() }).where("driver_id", "=", driverId).execute();
          continue;
        }
        const kind = KIND[token[0] as keyof typeof KIND];
        const status = STATUS[token[1] as keyof typeof STATUS];
        const tripId = await insertTrip(db, await insertRider(db), { kind: token[0] === "s" ? "scheduled" : "live", status: "cancelled_by_rider" });
        await db.updateTable("trips").set({ zone_id: zoneId }).where("trip_id", "=", tripId).execute();
        // 't': an Exclusive offer sent while the driver is on a trip (the trigger notes it at insert).
        if (token[0] === "t") await db.updateTable("drivers").set({ online_status: "on_trip" }).where("driver_id", "=", driverId).execute();
        const sent = tick();
        await db.insertInto("offers").values({ offer_id: newId("ofr"), trip_id: tripId, driver_id: driverId, kind, status, round: 1, currency: "SEK", fare_minor: 25000, driver_earnings_minor: 20000, pickup_meters: 900, pickup_eta_seconds: 120, sent_at: sent, expires_at: sent, answered_at: tick(), group_id: null, reason_code: null, decline_reason: null }).execute();
        if (token[0] === "t") await db.updateTable("drivers").set({ online_status: "online" }).where("driver_id", "=", driverId).execute();
        const done = await db.transaction().execute((trx) => autoOfflineIfDue(trx, driverId, tripId, new Date(at)));
        if (done && offlineAt === null) offlineAt = index;
      }
      expect(offlineAt).toBe(c.expectOfflineAt);
      const driver = await db.selectFrom("drivers").select("online_status").where("driver_id", "=", driverId).executeTakeFirstOrThrow();
      expect(driver.online_status).toBe(c.expectOfflineAt === null ? "online" : "offline");
    });
  }
});
