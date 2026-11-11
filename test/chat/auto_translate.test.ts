import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import type { Lang } from "../../src/chat/settings.js";
import { schemaProblem } from "../../src/contract/schemas.js";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { dispatchHandlers } from "../../src/dispatch/runtime.js";
import { seedDriver } from "../../src/drivers/service.js";
import { TimerWorker } from "../../src/jobs/timers.js";
import { purgeOldMessages } from "../../src/trips/messages.js";
import { rideHandlers } from "../../src/trips/ride.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { call, NORRMALM, SODERMALM, signIn, testWorld } from "../support/world.js";

/**
 * v0.18.64 §85 (owner 2026-11-11 "the language must arrive with the receiver language and the translate when click on
 * it must open original language"): Message.lang, the autoTranslate setting, the `auto` flag, the same-language answer
 * and the per-language cache (migration 0097), with a fake provider.
 */

let database: TestDatabase;
let app: FastifyInstance;
let worker: TimerWorker;
const clock = { now: new Date("2026-11-11T12:00:00Z") };
const sample = (name: string) => JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/${name}.json`, "utf8"));
const asked: { text: string; to: Lang }[] = [];
const translator = { translate: async (text: string, to: Lang) => { asked.push({ text, to }); return `[${to}] ${text}`; } };

const SPOT = { lat: 59.3335, lng: 18.0655 };
let driver: { id: string; headers: Record<string, string> };
let rider: Record<string, string>;

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock, { translator });
  await database.db.insertInto("config_live").values([
    { doc: "dispatch", zone_id: "Z001", version: 1, document: JSON.stringify(sample("dispatch_document")), published_at: clock.now, published_by: null },
    { doc: "rider_app_config", zone_id: "Z001", version: 1, document: JSON.stringify(sample("rider_app_config")), published_at: clock.now, published_by: null },
  ]).execute();
  worker = new TimerWorker(database.db, { handlers: { ...dispatchHandlers, ...rideHandlers }, logger: { warn: () => undefined, error: (d, m) => console.error(m, d) }, clock: () => clock.now });
  const made = await database.db.transaction().execute((trx) =>
    seedDriver(trx, { phone: TEST_PHONES[1]!, firstName: "Driver T", make: "Volvo", model: "V60", year: 2021, color: "Black", plate: "TRA001", categoryIds: ["economy"], zoneIds: ["Z001"] }, clock.now),
  );
  driver = { id: made.driverId, headers: {} };
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

beforeEach(async () => {
  clock.now = new Date(clock.now.getTime() + 3600_000);
  asked.length = 0;
  await database.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("status", "not in", ["completed", "cancelled_by_admin", "cancelled_by_rider", "cancelled_by_driver", "no_show", "expired"]).execute();
  await database.db.deleteFrom("timers").execute();
  await database.db.deleteFrom("offers").execute();
  await database.db.deleteFrom("config_live").where("doc", "=", "country_rules").execute();
  await database.db.updateTable("riders").set({ language: null }).execute();
  await database.db.updateTable("drivers").set({ language: null }).execute();
  rider = (await signIn(app, TEST_PHONES[0]!, "rider")).headers;
  driver.headers = (await signIn(app, TEST_PHONES[1]!, "driver")).headers;
  await database.db.updateTable("drivers").set({ online_status: "online", last_free_at: clock.now, rating_sum: 0, rating_count: 0 }).where("driver_id", "=", driver.id).execute();
  expect((await call(app, "POST", "/driver/location", driver.headers, { fixes: [{ ...SPOT, accuracy: 5, measuredAt: clock.now.toISOString() }] })).statusCode).toBe(200);
});

async function accepted() {
  const quote = (await call(app, "POST", "/quotes", rider, { pickup: NORRMALM, dropoff: SODERMALM, stops: [], categoryIds: ["economy"] })).json().quotes[0];
  const trip = (await call(app, "POST", "/trips", rider, { quoteId: quote.quoteId, categoryId: "economy", pickup: NORRMALM, dropoff: SODERMALM, stops: [], kind: "live", paymentMethod: "cash" })).json();
  await worker.runDue();
  const [offer] = (await call(app, "GET", "/driver/offers", driver.headers)).json().items;
  expect(offer?.tripId).toBe(trip.tripId);
  const res = await call(app, "POST", `/offers/${offer.offerId}/accept`, driver.headers, { expectedVersion: offer.version });
  expect(res.statusCode).toBe(200);
  return { tripId: trip.tripId as string, version: res.json().version as number };
}

const setChat = (chat: Record<string, unknown>) =>
  database.db.insertInto("config_live").values({ doc: "country_rules", zone_id: "Z001", version: 1, document: JSON.stringify({ chat }), published_at: clock.now, published_by: null }).execute();
const setLanguage = (who: "rider" | "driver", lang: Lang) =>
  who === "driver"
    ? database.db.updateTable("drivers").set({ language: lang }).where("driver_id", "=", driver.id).execute()
    : database.db.updateTable("riders").set({ language: lang }).where("phone", "=", TEST_PHONES[0]!).execute();
const send = (tripId: string, who: Record<string, string>, body: Record<string, unknown>) => call(app, "POST", `/trips/${tripId}/messages`, who, body);
const translate = (tripId: string, who: Record<string, string>, body: Record<string, unknown>) => call(app, "POST", `/trips/${tripId}/messages/translate`, who, body);

describe("v0.18.64 §85 Message.lang and the setting", () => {
  it("T1 typed text carries the sender's app language; a chip and the automatic messages the reader's; GET and the stream carry it", async () => {
    const { tripId, version } = await accepted();
    await setLanguage("driver", "fr");
    await setLanguage("rider", "sv");
    const typed = await send(tripId, rider, { text: "Hej, jag står vid porten" });
    expect(typed.statusCode).toBe(201);
    expect(typed.json()).toMatchObject({ lang: "sv" });
    expect(schemaProblem("Message", typed.json())).toBeNull();
    expect((await send(tripId, rider, { text: "x", quickReplyId: "thanks" })).json()).toMatchObject({ text: "Merci !", lang: "fr" });
    expect((await send(tripId, driver.headers, { text: "J'arrive" })).json()).toMatchObject({ lang: "fr" });
    const v = (await call(app, "POST", `/trips/${tripId}/head-to-pickup`, driver.headers, { expectedVersion: version })).json().version;
    expect((await call(app, "POST", `/trips/${tripId}/arrive`, driver.headers, { expectedVersion: v })).statusCode).toBe(200);
    const items = (await call(app, "GET", `/trips/${tripId}/messages`, rider)).json().items;
    expect(items.map((m: { lang?: string }) => m.lang)).toEqual(["sv", "fr", "fr", "sv"]);
    expect(items[3]).toMatchObject({ auto: "arrived", text: "Jag är framme vid upphämtningsplatsen." });
    const events = (await call(app, "GET", `/trips/${tripId}/events?after=0&limit=500`, driver.headers)).json().items;
    expect(events.filter((e: { kind: string }) => e.kind === "message").map((e: { message: { lang?: string } }) => e.message.lang)).toEqual(["sv", "fr", "fr", "sv"]);
  });

  it("T2 ChatOptions.autoTranslate: default true (configDefaults.chat), off from CountryRules.chat", async () => {
    const { tripId } = await accepted();
    const on = (await call(app, "GET", `/trips/${tripId}/messages/options`, rider)).json();
    expect(on).toMatchObject({ translation: true, autoTranslate: true });
    expect(schemaProblem("ChatOptions", on)).toBeNull();
    await setChat({ autoTranslate: false });
    expect((await call(app, "GET", `/trips/${tripId}/messages/options`, driver.headers)).json()).toMatchObject({ autoTranslate: false });
  });
});

describe("v0.18.64 §85 translate", () => {
  it("T3 auto request: translated into the reader's language once, then the kept text (no second provider call)", async () => {
    const { tripId } = await accepted();
    await setLanguage("driver", "fr");
    const msg = (await send(tripId, rider, { text: "Jag står vid porten" })).json();
    const first = await translate(tripId, driver.headers, { messageId: msg.messageId, to: "fr", auto: true });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ messageId: msg.messageId, to: "fr", text: "[fr] Jag står vid porten" });
    expect(schemaProblem("TranslatedMessage", first.json())).toBeNull();
    // A tap, a reopen, another device: the kept text.
    expect((await translate(tripId, driver.headers, { messageId: msg.messageId, to: "fr" })).json().text).toBe("[fr] Jag står vid porten");
    expect(asked).toEqual([{ text: "Jag står vid porten", to: "fr" }]);
    const row = await database.db.selectFrom("trip_message_translations").selectAll().where("message_id", "=", msg.messageId).execute();
    expect(row).toEqual([expect.objectContaining({ lang: "fr", text: "[fr] Jag står vid porten" })]);
  });

  it("T4 a message already in the reader's language answers its own text with no provider call", async () => {
    const { tripId } = await accepted();
    await setLanguage("driver", "sv");
    const msg = (await send(tripId, rider, { text: "Hej" })).json();
    expect(msg.lang).toBe("sv");
    const same = await translate(tripId, driver.headers, { messageId: msg.messageId, to: "sv", auto: true });
    expect(same.statusCode).toBe(200);
    expect(same.json()).toMatchObject({ text: "Hej", to: "sv" });
    expect(asked).toEqual([]);
  });

  it("T5 autoTranslate off: an auto request is 403 auto_translate_off; a tap still translates; translation off stops both", async () => {
    const { tripId } = await accepted();
    await setLanguage("driver", "en");
    const msg = (await send(tripId, rider, { text: "Tack" })).json();
    await setChat({ autoTranslate: false });
    const auto = await translate(tripId, driver.headers, { messageId: msg.messageId, to: "en", auto: true });
    expect(auto.statusCode).toBe(403);
    expect(auto.json()).toMatchObject({ code: "forbidden", reason: "auto_translate_off" });
    expect((await translate(tripId, driver.headers, { messageId: msg.messageId, to: "en", auto: false })).json()).toMatchObject({ text: "[en] Tack" });
    await database.db.deleteFrom("config_live").where("doc", "=", "country_rules").execute();
    await setChat({ translation: false, autoTranslate: true });
    expect((await translate(tripId, driver.headers, { messageId: msg.messageId, to: "en", auto: true })).json()).toMatchObject({ reason: "translation_off" });
  });

  it("T6 a bad auto value is 400 invalid_body; another target stays 400 translate_target_not_allowed", async () => {
    const { tripId } = await accepted();
    const msg = (await send(tripId, driver.headers, { text: "Hej" })).json();
    expect((await translate(tripId, rider, { messageId: msg.messageId, to: "sv", auto: "yes" })).json()).toMatchObject({ reason: "invalid_body" });
    expect((await translate(tripId, rider, { messageId: msg.messageId, to: "fr", auto: true })).json()).toMatchObject({ reason: "translate_target_not_allowed" });
  });

  it("T7 the daily purge deletes a message's kept translations with it", async () => {
    const { tripId } = await accepted();
    await setLanguage("driver", "en");
    const msg = (await send(tripId, rider, { text: "Gammalt" })).json();
    expect((await translate(tripId, driver.headers, { messageId: msg.messageId, to: "en", auto: true })).statusCode).toBe(200);
    await setChat({ keepDays: 2 });
    const later = new Date(clock.now.getTime() + 3 * 24 * 3600_000);
    expect(await database.db.transaction().execute((trx) => purgeOldMessages(trx, later))).toBeGreaterThanOrEqual(1);
    expect(await database.db.selectFrom("trip_message_translations").select("lang").where("message_id", "=", msg.messageId).execute()).toEqual([]);
  });
});
