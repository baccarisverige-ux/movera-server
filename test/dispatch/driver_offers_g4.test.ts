import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { raiseMaxFactor } from "../../src/config/raiseLimit.js";
import { contract, CONTRACTS_DIR } from "../../src/contract/contract.js";
import { offerSound } from "../../src/dispatch/offerPush.js";
import { dispatchHandlers } from "../../src/dispatch/runtime.js";
import { seedDriver } from "../../src/drivers/service.js";
import { TimerWorker, type Timer } from "../../src/jobs/timers.js";
import { CLEANUP_OFFER_PUSHES, housekeepingHandlers } from "../../src/jobs/housekeeping.js";
import { FcmSender, type PushMessage, type PushSender, type SendResult } from "../../src/push/fcm.js";
import { PushDispatcher } from "../../src/push/dispatcher.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { call, NORRMALM, SODERMALM, signIn, testWorld } from "../support/world.js";

/**
 * Contract v0.18.6 §31, driver group 4 "Incoming offer & exclusive offer" (owner decisions 1-7 of 2026-10-29 and answers
 * G4-E1..E7 of 2026-10-30, Rules decisions/driver-g4.md). One block per decision; each fails on the v0.18.5 server.
 */

let database: TestDatabase;
let app: FastifyInstance;
let worker: TimerWorker;
let admin: Record<string, string>;
const clock = { now: new Date("2026-10-30T12:00:00Z") };
const sample = (name: string) => JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/${name}.json`, "utf8"));

const SPOTS = { A: { lat: 59.3335, lng: 18.0655 }, B: { lat: 59.336, lng: 18.07 } };
const drivers: Record<"A" | "B", { id: string; headers: Record<string, string> }> = {} as never;
let rider: Record<string, string>;
let riderId: string;

async function setDriverDoc(change: (doc: Record<string, unknown>) => void) {
  const doc = sample("driver_app_config");
  change(doc);
  await database.db.deleteFrom("config_live").where("doc", "=", "driver_app_config").where("zone_id", "=", "Z001").execute();
  await database.db.insertInto("config_live").values({ doc: "driver_app_config", zone_id: "Z001", version: 1, document: JSON.stringify(doc), published_at: clock.now, published_by: null }).execute();
}

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  await database.db.insertInto("config_live").values([
    { doc: "dispatch", zone_id: "Z001", version: 1, document: JSON.stringify(sample("dispatch_document")), published_at: clock.now, published_by: null },
    { doc: "rider_app_config", zone_id: "Z001", version: 1, document: JSON.stringify(sample("rider_app_config")), published_at: clock.now, published_by: null },
  ]).execute();
  worker = new TimerWorker(database.db, { handlers: dispatchHandlers, logger: { warn: () => undefined, error: (d, m) => console.error(m, d) }, clock: () => clock.now });
  const phones = { A: TEST_PHONES[1]!, B: TEST_PHONES[2]! };
  for (const key of ["A", "B"] as const) {
    const made = await database.db.transaction().execute((trx) =>
      seedDriver(trx, { phone: phones[key], firstName: `Driver ${key}`, make: "Volvo", model: "V60", year: 2021, color: "Black", plate: `GFR00${key}`, categoryIds: ["economy"], zoneIds: ["Z001"] }, clock.now),
    );
    drivers[key] = { id: made.driverId, headers: {} };
  }
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

beforeEach(async () => {
  clock.now = new Date(clock.now.getTime() + 3600_000);
  await setDriverDoc(() => undefined);
  await database.db.deleteFrom("dispatch_controls").execute();
  await database.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("status", "not in", ["completed", "cancelled_by_admin", "cancelled_by_rider", "expired"]).execute();
  await database.db.deleteFrom("timers").execute();
  await database.db.deleteFrom("offers").execute();
  await database.db.deleteFrom("notifications").execute();
  admin = (await adminSession(app, database.db, "super", { now: clock.now })).headers;
  rider = (await signIn(app, TEST_PHONES[0]!, "rider")).headers;
  riderId = (await call(app, "GET", "/rider/profile", rider)).json().riderId;
  await database.db.updateTable("riders").set({ rating_sum: 0, rating_count: 0 }).where("rider_id", "=", riderId).execute();
  for (const key of ["A", "B"] as const) {
    drivers[key].headers = (await signIn(app, ({ A: TEST_PHONES[1], B: TEST_PHONES[2] } as const)[key]!, "driver")).headers;
    await database.db.updateTable("drivers").set({ online_status: "online", online_since: clock.now, last_free_at: clock.now, language: null }).where("driver_id", "=", drivers[key].id).execute();
    await call(app, "POST", "/driver/location", drivers[key].headers, { fixes: [{ ...SPOTS[key], accuracy: 5, measuredAt: clock.now.toISOString() }] });
  }
});

async function book() {
  const quote = (await call(app, "POST", "/quotes", rider, { pickup: NORRMALM, dropoff: SODERMALM, stops: [], categoryIds: ["economy"] })).json().quotes[0];
  const trip = (await call(app, "POST", "/trips", rider, { quoteId: quote.quoteId, categoryId: "economy", pickup: NORRMALM, dropoff: SODERMALM, stops: [], kind: "live", paymentMethod: "cash" })).json();
  if (typeof trip.tripId !== "string") throw new Error(`booking failed: ${JSON.stringify(trip)}`);
  await worker.runDue();
  return trip.tripId as string;
}
const openOffers = async (key: "A" | "B") => (await call(app, "GET", "/driver/offers", drivers[key].headers)).json().items as Array<Record<string, unknown> & { offerId: string; version: number }>;
const pushRows = (driverId: string) => database.db.selectFrom("notifications").selectAll().where("subject_id", "=", driverId).where("kind", "=", "new_offer").orderBy("created_at").execute();

class FakeSender implements PushSender {
  sent: PushMessage[] = [];
  async send(message: PushMessage): Promise<SendResult> {
    this.sent.push(message);
    return "sent";
  }
}

describe("G4 decision 1 + E6: a push with sound and vibration for a new offer", () => {
  it("an Exclusive offer writes a push (sound + vibrate) that is not a bell notice, in the driver's language", async () => {
    await book();
    const [offer] = await openOffers("A");
    expect(offer).toMatchObject({ kind: "exclusive" });
    const rows = await pushRows(drivers.A.id);
    expect(rows).toHaveLength(1);
    // SE trip, no language on the account: Swedish.
    expect(rows[0]).toMatchObject({ bell: false, title: "Ny resa till dig", body: "Tryck för att se resan", deep_link: `movera-driver://offers/${offer!.offerId}` });
    expect(rows[0]!.push_until!.toISOString()).toBe(offer!["expiresAt"]);
    expect(rows[0]!.data).toMatchObject({ offerId: offer!.offerId, offerKind: "exclusive", sound: "offer", vibrate: "true", expiresAt: offer!["expiresAt"] });
    // Never in the bell list.
    const bell = (await call(app, "GET", "/notifications?limit=50", drivers.A.headers)).json().items as Array<{ kind: string }>;
    expect(bell.map((n) => n.kind)).not.toContain("new_offer");
    expect((await call(app, "POST", `/notifications/${rows[0]!.notification_id}/read`, drivers.A.headers)).statusCode).toBe(404);
  });

  it("a French driver gets it in French; the dispatcher sends it with the offer sound, data and a time to live", async () => {
    await database.db.updateTable("drivers").set({ language: "fr" }).where("driver_id", "=", drivers.A.id).execute();
    await database.db.insertInto("push_devices").values({ token: "g4-a-android", actor: "driver", subject_id: drivers.A.id, session_id: null, provider: "fcm", platform: "android", app_version: null, locale: null, updated_at: clock.now }).execute();
    await book();
    const sender = new FakeSender();
    const pusher = new PushDispatcher(database.db, sender, { clock: () => clock.now, sleep: async () => {} });
    await pusher.sweep();
    const mine = sender.sent.filter((m) => m.token === "g4-a-android" && m.data?.["kind"] !== "signed_in_elsewhere");
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ title: "Nouvelle course pour vous", body: "Appuyez pour voir la course", sound: "offer", data: { kind: "new_offer", offerKind: "exclusive", sound: "offer", vibrate: "true" } });
    expect(mine[0]!.ttlSeconds).toBeGreaterThan(0);
    expect(mine[0]!.ttlSeconds).toBeLessThanOrEqual(15);
    const fcm = FcmSender.body(mine[0]!) as { message: { android: { notification: Record<string, unknown> }; apns: { payload: { aps: Record<string, unknown> } } } };
    expect(fcm.message.android.notification).toMatchObject({ channel_id: "movera_offers", sound: "movera_offer" });
    expect(fcm.message.apns.payload.aps).toMatchObject({ sound: "movera_offer.caf" });
    await database.db.deleteFrom("push_devices").where("token", "=", "g4-a-android").execute();
  });

  it("a push not sent before the offer runs out is dropped", async () => {
    await database.db.insertInto("push_devices").values({ token: "g4-late", actor: "driver", subject_id: drivers.A.id, session_id: null, provider: "fcm", platform: "web", app_version: null, locale: null, updated_at: clock.now }).execute();
    await book();
    clock.now = new Date(clock.now.getTime() + 16_000);
    const sender = new FakeSender();
    await new PushDispatcher(database.db, sender, { clock: () => clock.now, sleep: async () => {} }).sweep();
    expect(sender.sent.filter((m) => m.token === "g4-late" && m.data?.["kind"] !== "signed_in_elsewhere")).toEqual([]);
    await database.db.deleteFrom("push_devices").where("token", "=", "g4-late").execute();
  });

  it("Radar offers are quiet: no sound, no vibration (E6)", async () => {
    await database.db.insertInto("dispatch_controls").values({ zone_id: "Z001", paused: false, mode: "radar", by: null, at: clock.now, version: 1 }).execute();
    await book();
    const [offer] = await openOffers("A");
    expect(offer).toMatchObject({ kind: "radar" });
    const [row] = await pushRows(drivers.A.id);
    expect(row).toMatchObject({ bell: false, title: "Ny resa i närheten" });
    expect(row!.data).toMatchObject({ offerKind: "radar", sound: "none", vibrate: "false" });
    expect(offerSound("assigned")).toEqual({ sound: "offer", vibrate: true });
    const quiet = FcmSender.body({ token: "t", platform: "android", title: "x", body: "y", data: {}, sound: "none" }) as { message: { android: { notification: Record<string, unknown> }; apns: { payload: { aps: Record<string, unknown> } } } };
    expect(quiet.message.android.notification).toMatchObject({ channel_id: "movera_offers_quiet" });
    expect(quiet.message.android.notification).not.toHaveProperty("sound");
    expect(quiet.message.apns.payload.aps).toEqual({});
  });
});

describe("G4 checker LOW 9 / LOW 10: no push for a closed offer; old push rows are purged", () => {
  it("an offer declined before the push went out is not pushed", async () => {
    await database.db.insertInto("push_devices").values({ token: "g4-closed", actor: "driver", subject_id: drivers.A.id, session_id: null, provider: "fcm", platform: "android", app_version: null, locale: null, updated_at: clock.now }).execute();
    await book();
    const [offer] = await openOffers("A");
    expect((await call(app, "POST", `/offers/${offer!.offerId}/decline`, drivers.A.headers, { expectedVersion: offer!.version })).statusCode).toBe(200);
    const sender = new FakeSender();
    await new PushDispatcher(database.db, sender, { clock: () => clock.now, sleep: async () => {} }).sweep();
    expect(sender.sent.filter((m) => m.token === "g4-closed" && m.data["offerId"] === offer!.offerId)).toEqual([]);
    await database.db.deleteFrom("push_devices").where("token", "=", "g4-closed").execute();
  });

  it("the hourly offer-push clean-up deletes new-offer push rows a day after they ran out; bell notices and fresh pushes stay", async () => {
    const old = new Date(clock.now.getTime() - 2 * 86_400_000);
    const row = (id: string, bell: boolean, kind: string, pushUntil: Date | null, created: Date) => ({ notification_id: id, audience: "driver" as const, subject_id: drivers.A.id, kind, title: "t", body: "b", data: "{}", created_at: created, pushed_at: created, bell, push_until: pushUntil });
    await database.db.insertInto("notifications").values([
      row("ntf_g4_old_push", false, "new_offer", old, old),
      row("ntf_g4_fresh_push", false, "new_offer", new Date(clock.now.getTime() - 60_000), clock.now),
      row("ntf_g4_old_bell", true, "set_offline", null, old),
    ]).execute();
    // S4 0.14b: the offer-push clean-up has its own hourly timer (it ran inside the hourly sweep before).
    await database.db.transaction().execute((trx) => housekeepingHandlers[CLEANUP_OFFER_PUSHES]!(trx, { timerId: "t", kind: CLEANUP_OFFER_PUSHES, refId: "all", payload: {}, attempts: 0, firedAt: clock.now } as unknown as Timer));
    const left = (await database.db.selectFrom("notifications").select("notification_id").where("notification_id", "like", "ntf_g4_%").execute()).map((r) => r.notification_id).sort();
    expect(left).toEqual(["ntf_g4_fresh_push", "ntf_g4_old_bell"]);
  });
});

describe("G4 decision 3: the rider's rating on the offer, admin switch per zone", () => {
  it("shows the rider's real average; nothing when he has no rating (no made-up 4.9)", async () => {
    await book();
    const [none] = await openOffers("A");
    expect(none).not.toHaveProperty("riderRating");
    await database.db.updateTable("riders").set({ rating_sum: 14, rating_count: 3 }).where("rider_id", "=", riderId).execute();
    await database.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("status", "in", ["searching", "offered"]).execute();
    await database.db.deleteFrom("timers").execute();
    await database.db.updateTable("offers").set({ status: "withdrawn" }).where("status", "=", "open").execute();
    await book();
    const [rated] = await openOffers("A");
    expect(rated).toMatchObject({ riderRating: 4.67 });
  });

  it("the zone's DriverAppConfig.offers.offerCard.riderRating = false hides it", async () => {
    await database.db.updateTable("riders").set({ rating_sum: 49, rating_count: 10 }).where("rider_id", "=", riderId).execute();
    await setDriverDoc((doc) => ((doc["offers"] as { offerCard: Record<string, boolean> }).offerCard.riderRating = false));
    await book();
    const [offer] = await openOffers("A");
    expect(offer).toBeDefined();
    expect(offer).not.toHaveProperty("riderRating");
  });
});

describe("G4 decision 4: the driver asks whether his accept went through", () => {
  it("open → no trip; another driver's offer → 404; after the accept → claimed with his trip", async () => {
    const tripId = await book();
    const [offer] = await openOffers("A");
    const open = await call(app, "GET", `/driver/offers/${offer!.offerId}`, drivers.A.headers);
    expect(open.statusCode).toBe(200);
    expect(open.json()).toMatchObject({ offer: { offerId: offer!.offerId, status: "open" } });
    expect(open.json()).not.toHaveProperty("trip");
    expect((await call(app, "GET", `/driver/offers/${offer!.offerId}`, drivers.B.headers)).json()).toMatchObject({ code: "not_found", reason: "offer_not_found" });
    // The accept went through but its answer was lost: the check says so and gives the trip.
    expect((await call(app, "POST", `/offers/${offer!.offerId}/accept`, drivers.A.headers, { expectedVersion: offer!.version })).statusCode).toBe(200);
    const after = (await call(app, "GET", `/driver/offers/${offer!.offerId}`, drivers.A.headers)).json();
    expect(after).toMatchObject({ offer: { status: "claimed" }, trip: { tripId, status: "accepted", driverId: drivers.A.id } });
  });

  it("an offer whose time ran out reads expired (no trip): the app shows 'Offer no longer available'", async () => {
    await book();
    const [offer] = await openOffers("A");
    clock.now = new Date(clock.now.getTime() + 16_000);
    const seen = (await call(app, "GET", `/driver/offers/${offer!.offerId}`, drivers.A.headers)).json();
    expect(seen).toMatchObject({ offer: { status: "expired" } });
    expect(seen).not.toHaveProperty("trip");
    const texts = (contract as unknown as { driverOffers: { acceptCheck: { texts: Record<string, Record<string, string>> } } }).driverOffers.acceptCheck.texts;
    expect(texts["gone"]).toEqual({ sv: "Erbjudandet är inte längre tillgängligt", fr: "Cette offre n’est plus disponible", en: "Offer no longer available" });
  });
});

describe("G4-E3: hand-sent offers count toward the in-a-row limit", () => {
  // Owner 2026-11-16 "It's not when driver decline ! It count when driver ignore" (contract v0.18.120): only hand-sent
  // offers the driver let expire count; declined ones never do (was: "two declined hand-sent offers ... set the driver offline").
  for (const answer of ["declined", "expired"] as const) it(`two ${answer} hand-sent offers with a limit of 2: ${answer === "expired" ? "the driver is set offline" : "he stays online"}`, async () => {
    await setDriverDoc((doc) => ((doc["offers"] as { autoOffline: Record<string, number> }).autoOffline.missedExclusive = 2));
    // No automatic offers: only the admin's.
    await database.db.insertInto("dispatch_controls").values({ zone_id: "Z001", paused: true, mode: null, by: null, at: clock.now, version: 1 }).execute();
    for (let n = 1; n <= 2; n += 1) {
      const tripId = await book();
      const trip = (await call(app, "GET", `/admin/trips/${tripId}`, admin)).json();
      const sent = await call(app, "POST", `/admin/trips/${tripId}/assign`, admin, { expectedVersion: trip.version, driverId: drivers.A.id });
      expect(sent.statusCode, sent.body).toBe(200);
      const [offer] = await openOffers("A");
      expect(offer).toMatchObject({ kind: "assigned", source: "admin" });
      clock.now = new Date(clock.now.getTime() + 1000);
      if (answer === "declined") expect((await call(app, "POST", `/offers/${offer!.offerId}/decline`, drivers.A.headers, { expectedVersion: offer!.version })).statusCode).toBe(200);
      else {
        // He ignores it: the offer runs out.
        clock.now = new Date(new Date(offer!["expiresAt"] as string).getTime() + 1000);
        await worker.runDue();
      }
      // The rider gives up on that trip before the next one (one live trip per rider).
      await database.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("trip_id", "=", tripId).execute();
      await database.db.deleteFrom("timers").execute();
    }
    expect((await call(app, "GET", "/driver/profile", drivers.A.headers)).json()).toMatchObject({ onlineStatus: answer === "expired" ? "offline" : "online" });
    const events = await database.db.selectFrom("offer_events").select("offer").where("driver_id", "=", drivers.A.id).orderBy("sequence", "desc").execute();
    const closed = events.map((e) => e.offer as Record<string, unknown>).filter((o) => o["status"] === answer);
    expect(closed.length).toBeGreaterThanOrEqual(2);
    expect(closed[0]).toMatchObject({ kind: "assigned", status: answer });
    if (answer === "expired") expect(closed[0]).toMatchObject({ driverOffline: true });
    else expect(events.some((e) => (e.offer as Record<string, unknown>)["driverOffline"] === true)).toBe(false);
  });
});

describe("G4-E2: auto-offline limit 10 in every zone (migration 0039)", () => {
  it("moves every published or draft limit that is not 10 to 10 as the next version, SE and FR; runs twice safely", async () => {
    const doc = (zoneId: string, country: string, currency: string, limit: number, version: number) => ({
      ...sample("driver_app_config"),
      zoneId,
      country,
      currency,
      version,
      offers: { ...sample("driver_app_config").offers, autoOffline: { missedExclusive: limit, noFixMinutes: 5, hiddenComesBackMin: 2 } },
    });
    const at = new Date("2026-10-25T09:00:00Z");
    await database.db.deleteFrom("config_live").where("doc", "=", "driver_app_config").where("zone_id", "in", ["Z003", "FR-PC", "standard-SE"]).execute();
    await database.db.insertInto("config_live").values([
      { doc: "driver_app_config", zone_id: "Z003", version: 4, document: JSON.stringify(doc("Z003", "SE", "SEK", 3, 4)), published_at: at, published_by: null },
      { doc: "driver_app_config", zone_id: "FR-PC", version: 2, document: JSON.stringify(doc("FR-PC", "FR", "EUR", 3, 2)), published_at: at, published_by: null },
      { doc: "driver_app_config", zone_id: "standard-SE", version: 7, document: JSON.stringify(doc("standard-SE", "SE", "SEK", 10, 7)), published_at: at, published_by: null },
    ]).execute();
    await database.db.insertInto("config_drafts").values({ doc: "driver_app_config", zone_id: "FR-PC", version: 3, document: JSON.stringify(doc("FR-PC", "FR", "EUR", 3, 2)), updated_at: at, updated_by: null }).execute();
    const migration = readFileSync(new URL("../../migrations/0039_driver_offers.sql", import.meta.url), "utf8");
    // Checker LOW 13: the first run tells open config streams to look again (config_published, 'null' = all); the second changes nothing.
    const listener = await database.pool.connect();
    const heard: Array<string | undefined> = [];
    listener.on("notification", (n) => heard.push(n.payload));
    await listener.query("LISTEN movera_config_published");
    await database.pool.query(migration);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(heard).toEqual(["null"]);
    await database.pool.query(migration);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(heard).toEqual(["null"]);
    await listener.query("UNLISTEN *");
    listener.release();
    const live = await database.db.selectFrom("config_live").select(["zone_id", "version", "document"]).where("doc", "=", "driver_app_config").where("zone_id", "in", ["Z003", "FR-PC", "standard-SE"]).orderBy("zone_id").execute();
    const view = Object.fromEntries(live.map((r) => [r.zone_id, { version: r.version, limit: (r.document as { offers: { autoOffline: { missedExclusive: number } } }).offers.autoOffline.missedExclusive, docVersion: (r.document as { version: number }).version }]));
    expect(view).toEqual({ "FR-PC": { version: 3, limit: 10, docVersion: 3 }, Z003: { version: 5, limit: 10, docVersion: 5 }, "standard-SE": { version: 7, limit: 10, docVersion: 7 } });
    const history = await database.db.selectFrom("config_history").select(["zone_id", "version", "note"]).where("doc", "=", "driver_app_config").where("zone_id", "in", ["Z003", "FR-PC"]).orderBy("zone_id").execute();
    expect(history.map((h) => [h.zone_id, h.version])).toEqual([["FR-PC", 3], ["Z003", 5]]);
    expect(history[0]!.note).toContain("G4-E2");
    const draft = await database.db.selectFrom("config_drafts").select(["version", "document"]).where("doc", "=", "driver_app_config").where("zone_id", "=", "FR-PC").executeTakeFirstOrThrow();
    expect(draft.version).toBe(4);
    expect((draft.document as { offers: { autoOffline: { missedExclusive: number } } }).offers.autoOffline.missedExclusive).toBe(10);
    // The served document says 10 too (SE and FR).
    const served = await call(app, "GET", "/driver/config?zoneId=FR-PC", drivers.A.headers);
    expect(served.json().offers.autoOffline.missedExclusive).toBe(10);
    await database.db.deleteFrom("config_live").where("doc", "=", "driver_app_config").where("zone_id", "in", ["Z003", "FR-PC", "standard-SE"]).execute();
    await database.db.deleteFrom("config_drafts").where("doc", "=", "driver_app_config").where("zone_id", "=", "FR-PC").execute();
  });
});

describe("G4-E4: the rider's raise limit is a per-zone admin setting, served to the rider app", () => {
  async function publishDispatch(scope: { zoneId: string } | { country: string }, document: Record<string, unknown>) {
    const q = "zoneId" in scope ? `zoneId=${scope.zoneId}` : `country=${scope.country}`;
    const draft = await call(app, "GET", `/admin/config/dispatch?${q}`, admin);
    const version = draft.statusCode === 200 ? draft.json().version : 1;
    const put = await call(app, "PUT", "/admin/config/dispatch", admin, { expectedVersion: version, ...scope, document });
    if (put.statusCode !== 200) return put;
    return call(app, "POST", "/admin/config/dispatch/publish", admin, { expectedVersion: put.json().version, ...scope });
  }

  it("Stockholm: maxFactor 1.2 reaches GET /rider/config and the server refuses a raise above it", async () => {
    const published = await publishDispatch({ zoneId: "Z001" }, { ...sample("dispatch_document"), raisePrice: { maxFactor: 1.2 } });
    expect(published.statusCode, published.body).toBe(200);
    expect((await call(app, "GET", "/rider/config?zoneId=Z001", rider)).json().raisePrice).toEqual({ maxFactor: 1.2 });
    const stored = await database.db.selectFrom("config_live").select("document").where("doc", "=", "rider_app_config").where("zone_id", "=", "Z001").executeTakeFirstOrThrow();
    expect((stored.document as { raisePrice: unknown }).raisePrice).toEqual({ maxFactor: 1.2 });
    const tripId = await book();
    const trip = (await call(app, "GET", `/trips/${tripId}`, rider)).json();
    const fare = trip.fare.amountMinor as number;
    const tooMuch = await call(app, "POST", `/trips/${tripId}/raise-price`, rider, { expectedVersion: trip.version, increase: { amountMinor: Math.ceil(fare * 0.2) + 100, currency: "SEK" } });
    expect(tooMuch.json()).toMatchObject({ code: "invalid_request", reason: "raise_too_high" });
    const ok = await call(app, "POST", `/trips/${tripId}/raise-price`, rider, { expectedVersion: trip.version, increase: { amountMinor: Math.floor(fare * 0.2), currency: "SEK" } });
    expect(ok.statusCode, ok.body).toBe(200);
    // Back to the default 2 for the other tests.
    expect((await publishDispatch({ zoneId: "Z001" }, sample("dispatch_document"))).statusCode).toBe(200);
    expect((await call(app, "GET", "/rider/config?zoneId=Z001", rider)).json().raisePrice).toEqual({ maxFactor: 2 });
  });

  it("France: the country standard's maxFactor reaches Paris; out of range is refused; no setting = 2", async () => {
    expect(await raiseMaxFactor(database.db, "FR-PC")).toBe(2);
    const riderFr = { ...sample("rider_app_config"), zoneId: "standard-FR", country: "FR", currency: "EUR", timeZone: "Europe/Paris" };
    await database.db.insertInto("config_live").values({ doc: "rider_app_config", zone_id: "standard-FR", version: 1, document: JSON.stringify(riderFr), published_at: clock.now, published_by: null }).execute();
    const dispatchFr = { ...sample("dispatch_document"), zoneId: "standard-FR", country: "FR", timeZone: "Europe/Paris" };
    expect((await publishDispatch({ country: "FR" }, { ...dispatchFr, raisePrice: { maxFactor: 3.5 } })).json()).toMatchObject({ code: "invalid_request", reason: "invalid_document" });
    const published = await publishDispatch({ country: "FR" }, { ...dispatchFr, raisePrice: { maxFactor: 1.5 } });
    expect(published.statusCode, published.body).toBe(200);
    expect(await raiseMaxFactor(database.db, "FR-PC")).toBe(1.5);
    expect((await call(app, "GET", "/rider/config?zoneId=FR-PC", rider)).json().raisePrice).toEqual({ maxFactor: 1.5 });
    const standard = await database.db.selectFrom("config_live").select(["version", "document"]).where("doc", "=", "rider_app_config").where("zone_id", "=", "standard-FR").executeTakeFirstOrThrow();
    expect(standard.version).toBe(2);
    expect((standard.document as { raisePrice: unknown }).raisePrice).toEqual({ maxFactor: 1.5 });
  });
});

describe("G4 self-check: no driver-visible text says surge (sv / fr / en)", () => {
  it("the Home tip and every group 4 text are free of surge words", () => {
    const c = contract as unknown as { driverSurgeMap: { tipTexts: Record<string, string>; forbiddenWords: Record<string, string[]> }; driverOffers: unknown };
    expect(c.driverSurgeMap.tipTexts).toEqual({ sv: "Hög bonus i närheten", fr: "Bonus élevé à proximité", en: "High boost nearby" });
    const texts: Array<Record<string, string>> = [];
    const walk = (o: unknown) => {
      if (o === null || typeof o !== "object") return;
      const r = o as Record<string, unknown>;
      if (["sv", "fr", "en"].every((l) => typeof r[l] === "string")) texts.push(r as Record<string, string>);
      Object.values(r).forEach(walk);
    };
    walk(c.driverOffers);
    expect(texts.length).toBeGreaterThan(5);
    for (const t of [c.driverSurgeMap.tipTexts, ...texts]) {
      for (const lang of ["sv", "fr", "en"]) for (const word of c.driverSurgeMap.forbiddenWords[lang]!) expect(t[lang]!.toLowerCase()).not.toContain(word);
    }
  });
});
