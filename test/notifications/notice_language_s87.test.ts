import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pushIncomingCall } from "../../src/calls/push.js";
import { contract } from "../../src/contract/contract.js";
import type { TripRow } from "../../src/db/tripLog.js";
import { queueOfferPush, OFFER_PUSH } from "../../src/dispatch/offerPush.js";
import { markSetOffline } from "../../src/drivers/offlineReason.js";
import { DRIVER_TRIP_PUSH, pushDriverTripMoment } from "../../src/notifications/driverTripPush.js";
import { pushTripMoment, RIDER_TRIP_PUSH } from "../../src/notifications/tripPush.js";
import { queueRideCheckPush } from "../../src/safety/rideCheckPush.js";
import { pushSupportAnswer, SUPPORT_ANSWER_PUSH } from "../../src/support/answerPush.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver, insertRider, insertTrip } from "../support/seed.js";
import { call, testWorld } from "../support/world.js";

/**
 * v0.18.66 §87 (contract.json#noticeLanguage, owner 2026-11-11 "French for TN"): one language rule for every push and
 * bell notice: the person's language, else the country's (configDefaults.countries.<cc>.defaultLanguage: SE sv, FR fr,
 * TN fr), else en. The country is the trip zone's for a trip notice, else the person's zone's.
 * Rule 36 fail-before: Tunisian notices were English (the "SE sv, FR fr, else en" copies), the wallet credit Swedish.
 */
let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-11-11T12:00:00Z") };
type T = Record<"sv" | "fr" | "en", string>;
const C = contract as unknown as {
  onTrip: { rideCheck: { texts: Record<string, T> } };
  inAppCalls: { push: { texts: { fromDriver: T; fromRider: T } } };
  driverHome: { setOffline: { text: { title: T } } };
  walletCredit: { riderText: Record<string, T> };
};

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

/** A rider and a driver with no language set, and a trip of theirs in `zoneId`. */
async function people(zoneId: string, language: string | null = null) {
  const riderId = await insertRider(database.db);
  const driverId = await insertDriver(database.db);
  await database.db.updateTable("riders").set({ language }).where("rider_id", "=", riderId).execute();
  await database.db.updateTable("drivers").set({ language }).where("driver_id", "=", driverId).execute();
  const tripId = await insertTrip(database.db, riderId, { driverId, status: "accepted" });
  await database.db.updateTable("trips").set({ zone_id: zoneId }).where("trip_id", "=", tripId).execute();
  const trip = (await database.db.selectFrom("trips").selectAll().where("trip_id", "=", tripId).executeTakeFirstOrThrow()) as TripRow;
  return { riderId, driverId, trip };
}
const notices = (subjectId: string) => database.db.selectFrom("notifications").select(["kind", "title", "body"]).where("subject_id", "=", subjectId).orderBy("created_at").execute();

describe("§87 notice language: person, else country (TN fr), else en", () => {
  it("TN trip, rider and driver with no language: every trip push and bell is French (fail-before: English)", async () => {
    const { riderId, driverId, trip } = await people("TN-TC");
    await database.db.transaction().execute(async (trx) => {
      await pushTripMoment(trx, trip, "driver_found", clock.now);
      await queueRideCheckPush(trx, trip, "rider", riderId, { checkId: "rck_tn1", trigger: "long_stop", answerBy: clock.now.toISOString() }, clock.now);
      await pushIncomingCall(trx, trip, "cll_tn1", "rider", 30, clock.now);
      await pushDriverTripMoment(trx, driverId, trip, "rider_cancelled", clock.now);
      await queueOfferPush(trx, driverId, { offerId: "ofr_tn1", tripId: trip.trip_id, kind: "exclusive", expiresAt: clock.now.toISOString() }, clock.now);
    });
    const rider = await notices(riderId);
    expect(rider.map((n) => n.title)).toEqual([RIDER_TRIP_PUSH.texts.driver_found.title.fr, C.onTrip.rideCheck.texts["title"]!.fr, "Movera"]);
    expect(rider[2]!.body).toBe(C.inAppCalls.push.texts.fromDriver.fr);
    const driver = await notices(driverId);
    expect(driver.map((n) => n.title)).toEqual([DRIVER_TRIP_PUSH.title.fr, OFFER_PUSH.texts.title.exclusive.fr]);
    expect(driver[0]!.body).toBe(DRIVER_TRIP_PUSH.texts.rider_cancelled.fr);
  });

  it("support answer on a TN ticket, and a TN driver set offline (his own zone's country): French (fail-before: English)", async () => {
    const { riderId, driverId } = await people("TN-TC");
    await database.db.updateTable("drivers").set({ country: "TN", zone_ids: ["TN-TC"] }).where("driver_id", "=", driverId).execute();
    await pushSupportAnswer(database.db, { ticket_id: "tkt_tn1", opened_by: "rider", rider_id: riderId, driver_id: null, zone_id: "TN-TC" }, clock.now);
    await markSetOffline(database.db, driverId, "no_position", {}, clock.now);
    expect((await notices(riderId)).map((n) => n.title)).toEqual([SUPPORT_ANSWER_PUSH.texts.title.fr]);
    expect((await notices(driverId)).map((n) => n.title)).toEqual([C.driverHome.setOffline.text.title.fr]);
  });

  it("wallet credit to a TN rider with no language: French (fail-before: Swedish)", async () => {
    const { riderId } = await people("TN-TC");
    const admin = await adminSession(app, database.db, "super", { now: clock.now });
    const res = await call(app, "POST", `/admin/riders/${riderId}/wallet-credit`, admin.headers, { amount: { amountMinor: 5000, currency: "TND" }, reason: "Goodwill" });
    expect(res.statusCode, res.body).toBe(200);
    const notice = (await notices(riderId)).find((n) => n.kind === "wallet_credit")!;
    expect(notice.title).toBe(C.walletCredit.riderText["pushTitle"]!.fr);
  });

  it("SE stays Swedish, FR stays French, and the person's own language always wins", async () => {
    const se = await people("Z001");
    const fr = await people("FR-PC");
    const tnEn = await people("TN-TC", "en");
    for (const p of [se, fr, tnEn]) await pushTripMoment(database.db, p.trip, "driver_arrived", clock.now);
    const title = async (id: string) => (await notices(id))[0]!.title;
    expect(await title(se.riderId)).toBe(RIDER_TRIP_PUSH.texts.driver_arrived.title.sv);
    expect(await title(fr.riderId)).toBe(RIDER_TRIP_PUSH.texts.driver_arrived.title.fr);
    expect(await title(tnEn.riderId)).toBe(RIDER_TRIP_PUSH.texts.driver_arrived.title.en);
  });

  it("one rule: no other server file keeps its own country → language list", () => {
    const root = new URL("../../src/", import.meta.url).pathname;
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (name.endsWith(".ts")) files.push(path);
      }
    };
    walk(root);
    const copies = files.filter((f) => !f.endsWith("noticeLanguage.ts")).filter((f) => {
      const text = readFileSync(f, "utf8");
      return /SE:\s*"sv"/.test(text) || /=== "FR" \? "fr"/.test(text) || /\?\? "sv"\)/.test(text);
    });
    expect(copies.map((f) => f.slice(root.length))).toEqual([]);
  });
});
