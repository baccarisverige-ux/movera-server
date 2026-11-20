import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { KEPT_KEYS } from "../../src/config/keptKeys.js";
import { KEPT_ON_RESTORE } from "../../src/config/service.js";
import { askCountry, localMonthDay, PAY_REQUEST_BATCH, PAY_REQUEST_SCAN, payReference } from "../../src/drivers/payRequest.js";
import { owedByDriver } from "../../src/drivers/owes.js";
import { seedDriver } from "../../src/drivers/service.js";
import { RECURRING_JOBS } from "../../src/jobs/heartbeat.js";
import { ensureMaintenanceTimers, maintenanceHandlers } from "../../src/jobs/maintenance.js";
import { TimerWorker } from "../../src/jobs/timers.js";
import { HOUSEKEEPING_LANE_KINDS } from "../../src/jobs/workerConfig.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver } from "../support/seed.js";
import { call, signIn, testWorld } from "../support/world.js";

/**
 * Contract v0.18.139 (owner 2026-11-20): `driverWalletBalance` — GET /driver/earnings carries the driver's balance with
 * Movera now (the server's own sum, the admin owing list's number) — and `driverPayRequest` — the TEMPORARY monthly
 * pay request: setting on the country standard (off by default), a monthly job that asks each owing driver once (bell
 * notice + push), GET /driver/pay-movera, confirmation only by the admin's "Driver paid Movera".
 * Fails on main: no moveraBalance, no route, no setting check, no job.
 */

let database: TestDatabase;
let app: FastifyInstance;
// Sunday 2026-11-01 10:30 in Stockholm (09:30Z): day 1 of the month, after 09:00 local.
const DAY1 = new Date("2026-11-01T09:30:00.000Z");
const clock = { now: new Date(DAY1) };
const SEK = (amountMinor: number) => ({ amountMinor, currency: "SEK" });
const LINK = "https://pay.sumup.com/b2c/MOVERA1";
const sample = (name: string) => JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/${name}.json`, "utf8"));
let ali: { id: string; headers: Record<string, string> };
let n = 0;

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  for (const doc of ["driver_app_config", "rider_app_config"]) {
    await database.db.insertInto("config_live").values({ doc: doc as never, zone_id: "Z001", version: 1, document: JSON.stringify(sample(doc)), published_at: clock.now, published_by: null }).execute();
  }
  const made = await database.db.transaction().execute((trx) =>
    seedDriver(trx, { phone: TEST_PHONES[1]!, firstName: "Ali", make: "Volvo", model: "V60", year: 2021, color: "Black", plate: "PAY001", categoryIds: ["economy"], zoneIds: ["Z001"] }, clock.now),
  );
  await database.db.updateTable("drivers").set({ country: "SE" }).where("driver_id", "=", made.driverId).execute();
  ali = { id: made.driverId, headers: {} };
});
afterAll(async () => {
  await app.close();
  await database.drop();
});
beforeEach(async () => {
  clock.now = new Date(DAY1);
  await database.db.deleteFrom("timers").execute();
  await database.db.deleteFrom("notifications").execute();
  await database.db.deleteFrom("driver_pay_requests").execute();
  await database.db.deleteFrom("earnings_entries").execute();
  await database.db.deleteFrom("payouts").execute();
  await database.db.deleteFrom("drivers").where("driver_id", "<>", ali.id).execute();
  await database.db.deleteFrom("config_live").where("doc", "=", "country_rules").execute();
  await database.db.deleteFrom("config_drafts").where("doc", "=", "country_rules").execute();
  ali.headers = (await signIn(app, TEST_PHONES[1]!, "driver")).headers;
});

type Entry = { kind?: string; amount: number; cash?: number; currency?: string; at?: Date; payoutId?: string | null };
const entry = (driverId: string, e: Entry) =>
  database.db.insertInto("earnings_entries").values({ entry_id: `ern_pm${++n}`, driver_id: driverId, trip_id: null, kind: (e.kind ?? "trip") as never, currency: e.currency ?? "SEK", amount_minor: e.amount, gross_minor: null, commission_minor: null, cash_minor: e.cash ?? 0, at: e.at ?? clock.now, payout_id: e.payoutId ?? null }).execute();
const driverIn = async (country: string, zoneIds = ["Z001"]) => {
  const id = await insertDriver(database.db);
  await database.db.updateTable("drivers").set({ zone_ids: zoneIds, country }).where("driver_id", "=", id).execute();
  return id;
};
/** The live country_rules of a country standard (what Tips & limits published). */
async function live(country: string, currency: string, doc: Record<string, unknown>) {
  await database.db.deleteFrom("config_live").where("doc", "=", "country_rules").where("zone_id", "=", `standard-${country}`).execute();
  await database.db.insertInto("config_live").values({ doc: "country_rules", zone_id: `standard-${country}`, version: 1, document: JSON.stringify({ country, currency, ...doc }), published_at: clock.now, published_by: null }).execute();
}
const ON = (over: Record<string, unknown> = {}) => ({ driverPayRequest: { enabled: true, dayOfMonth: 1, payLink: LINK, minAmount: SEK(1000), ...over } });
const worker = () => new TimerWorker(database.db, { handlers: maintenanceHandlers, logger: { warn: () => undefined, error: (d, m) => console.error(m, d) }, clock: () => clock.now, pollMs: 20 });
/** Runs the scan now (and its 5 s follow-ups while a backlog is left). */
async function scan(w = worker()) {
  await database.db.deleteFrom("timers").where("kind", "=", PAY_REQUEST_SCAN).execute();
  await database.db.insertInto("timers").values({ kind: PAY_REQUEST_SCAN, ref_id: "all", due_at: clock.now, payload: "{}" }).execute();
  for (let i = 0; i < 20; i++) {
    await w.runDue(10_000);
    const next = await database.db.selectFrom("timers").select("due_at").where("kind", "=", PAY_REQUEST_SCAN).executeTakeFirstOrThrow();
    if (next.due_at.getTime() - clock.now.getTime() > 60_000) return;
    clock.now = new Date(next.due_at);
  }
  throw new Error("the scan never finished");
}
const notices = () => database.db.selectFrom("notifications").select(["subject_id", "kind", "title", "body", "deep_link", "data", "audience"]).where("kind", "=", "driver_pay_movera").orderBy("subject_id").execute();
const requests = () => database.db.selectFrom("driver_pay_requests").selectAll().orderBy("driver_id").execute();
const earnings = async (query = "period=week") => (await call(app, "GET", `/driver/earnings?${query}`, ali.headers)).json();
const payMovera = async () => (await call(app, "GET", "/driver/pay-movera", ali.headers)).json();

describe("driverWalletBalance: GET /driver/earnings carries moveraBalance (the server's own sum)", () => {
  it("nothing earned: both amounts 0 in the report's currency", async () => {
    const report = await earnings();
    expect(report.moveraBalance).toEqual({ owedToMovera: SEK(0), moveraOwesYou: SEK(0) });
  });

  it("Ali: 349,00 kr cash in the car, own pay 325,16 kr → cash collected 349,00 and he owes Movera 23,84 kr; the admin sees the same number", async () => {
    await entry(ali.id, { amount: 10000, cash: 11000 });
    await entry(ali.id, { amount: 12516, cash: 13900 });
    await entry(ali.id, { amount: 10000, cash: 10000 });
    const report = await earnings();
    expect(report.currency).toBe("SEK");
    expect(report.periods).toHaveLength(1);
    expect(report.periods[0].cashCollected).toEqual(SEK(34900));
    expect(report.periods[0].net).toEqual(SEK(32516));
    expect(report.moveraBalance).toEqual({ owedToMovera: SEK(2384), moveraOwesYou: SEK(0) });
    const admin = await adminSession(app, database.db, "super", { now: clock.now });
    const owing = (await call(app, "GET", "/admin/drivers-owing", admin.headers)).json();
    expect(owing.items.filter((i: { driverId: string }) => i.driverId === ali.id).map((i: { owed: unknown }) => i.owed)).toEqual([SEK(2384)]);
    expect((await owedByDriver(database.db, [ali.id], "SEK")).get(ali.id)).toBe(2384);
  });

  it("card earnings Movera holds: Movera owes him, he owes nothing", async () => {
    await entry(ali.id, { amount: 10000, cash: 0 });
    await entry(ali.id, { kind: "tip", amount: 2000, cash: 2000 });
    expect((await earnings()).moveraBalance).toEqual({ owedToMovera: SEK(0), moveraOwesYou: SEK(10000) });
  });

  it("the rest of an open payout below 0 carries in; a paid payout and entries already in a payout do not count", async () => {
    await database.db.insertInto("payouts").values([
      { payout_id: "pay_open", driver_id: ali.id, currency: "SEK", amount_minor: -5000, status: "pending", period_start: new Date("2026-10-19T07:00:00Z"), period_end: new Date("2026-10-26T07:00:00Z"), source: "weekly", trip_count: 1, lines: "[]", created_at: clock.now } as never,
      { payout_id: "pay_done", driver_id: ali.id, currency: "SEK", amount_minor: -9000, status: "paid", period_start: new Date("2026-10-12T07:00:00Z"), period_end: new Date("2026-10-19T07:00:00Z"), source: "weekly", trip_count: 1, lines: "[]", created_at: clock.now } as never,
    ]).execute();
    await entry(ali.id, { amount: -5000, payoutId: "pay_open", at: new Date("2026-10-20T10:00:00Z") });
    await entry(ali.id, { amount: 2000, cash: 0 });
    expect((await earnings()).moveraBalance).toEqual({ owedToMovera: SEK(3000), moveraOwesYou: SEK(0) });
  });

  it("it is the balance NOW: the same for any period or range, and per currency (kr and EUR are never added)", async () => {
    await entry(ali.id, { amount: 1000, cash: 4000, at: new Date("2026-09-15T10:00:00Z") });
    await entry(ali.id, { amount: 700, cash: 900, currency: "EUR" });
    const owes = { owedToMovera: SEK(3000), moveraOwesYou: SEK(0) };
    expect((await earnings("period=week")).moveraBalance).toEqual(owes);
    expect((await earnings("period=day")).moveraBalance).toEqual(owes);
    expect((await earnings("period=day&from=2026-10-30T00:00:00.000Z&to=2026-10-31T00:00:00.000Z")).moveraBalance).toEqual(owes);
    // The week has no SEK entry (the old one is outside it), yet the balance is there.
    expect((await earnings("period=week")).periods).toEqual([]);
    expect((await earnings("period=week&currency=EUR")).moveraBalance).toEqual({ owedToMovera: { amountMinor: 200, currency: "EUR" }, moveraOwesYou: { amountMinor: 0, currency: "EUR" } });
  });

  it("another driver's money never shows", async () => {
    const other = await driverIn("SE");
    await entry(other, { amount: 1000, cash: 9000 });
    expect((await earnings()).moveraBalance).toEqual({ owedToMovera: SEK(0), moveraOwesYou: SEK(0) });
  });
});

describe("driverPayRequest: the setting (country standard, off by default)", () => {
  const rules = (driverPayRequest: unknown) => {
    const r = sample("rider_app_config"), d = sample("driver_app_config");
    return { version: 1, publishedAt: clock.now.toISOString(), country: "SE", currency: "SEK", tips: r.tips ?? [], raiseSteps: r.raiseSteps ?? [], driverBonus: d.driverBonus ?? {}, driverPayRequest };
  };
  const put = async (driverPayRequest: unknown) => {
    const admin = (await adminSession(app, database.db, "super", { now: clock.now })).headers;
    const draft = (await call(app, "GET", "/admin/config/country_rules?country=SE", admin)).json();
    return call(app, "PUT", "/admin/config/country_rules", admin, { expectedVersion: draft.version ?? 1, country: "SE", document: rules(driverPayRequest) });
  };

  it("switched on it needs an https link and a minimum amount in the country's currency", async () => {
    const cases: Array<[unknown, string]> = [
      [{ enabled: true, dayOfMonth: 1, payLink: "", minAmount: SEK(0) }, "pay_request_needs_link"],
      [{ enabled: true, dayOfMonth: 1, minAmount: SEK(0) }, "pay_request_needs_link"],
      [{ enabled: true, dayOfMonth: 1, payLink: LINK, minAmount: null }, "pay_request_needs_amount"],
      [{ enabled: true, dayOfMonth: 1, payLink: LINK }, "pay_request_needs_amount"],
      [{ enabled: true, dayOfMonth: 1, payLink: LINK, minAmount: { amountMinor: 100, currency: "EUR" } }, "pay_request_needs_amount"],
      [{ enabled: true, dayOfMonth: 1, payLink: LINK, minAmount: SEK(-1) }, "pay_request_needs_amount"],
      [{ enabled: true, dayOfMonth: 1, payLink: "http://pay.sumup.com/b2c/X", minAmount: SEK(0) }, "pay_request_invalid"],
      [{ enabled: false, dayOfMonth: 1, payLink: "javascript:alert(1)", minAmount: null }, "pay_request_invalid"],
      [{ enabled: false, dayOfMonth: 1, payLink: `https://pay.sumup.com/${"x".repeat(500)}`, minAmount: null }, "pay_request_invalid"],
      [{ enabled: false, dayOfMonth: 1, payLink: "https://pay.sumup.com/a b", minAmount: null }, "pay_request_invalid"],
      // Review should-fix 1: nothing invisible, no control character, no "user:password@" part.
      [{ enabled: false, dayOfMonth: 1, payLink: "https://pay.sumup.com/\u0000x", minAmount: null }, "pay_request_invalid"],
      [{ enabled: false, dayOfMonth: 1, payLink: "https://pay.sumup.com/\u0001x", minAmount: null }, "pay_request_invalid"],
      [{ enabled: false, dayOfMonth: 1, payLink: "https://pay.sumup.com/\u007fx", minAmount: null }, "pay_request_invalid"],
      [{ enabled: false, dayOfMonth: 1, payLink: "https://pay.sumup.com/\u200bx", minAmount: null }, "pay_request_invalid"],
      [{ enabled: false, dayOfMonth: 1, payLink: "https://pay.sumup.com/\u202ex", minAmount: null }, "pay_request_invalid"],
      [{ enabled: true, dayOfMonth: 1, payLink: "https://sumup.com@evil.example/pay", minAmount: SEK(0) }, "pay_request_invalid"],
      [{ enabled: false, dayOfMonth: 1, payLink: "https://user:pw@pay.sumup.com/x", minAmount: null }, "pay_request_invalid"],
      [{ enabled: false, dayOfMonth: 1, payLink: "HTTPS://pay.sumup.com/x", minAmount: null }, "pay_request_invalid"],
      [{ enabled: true, dayOfMonth: 29, payLink: LINK, minAmount: SEK(0) }, "pay_request_invalid"],
      [{ enabled: true, dayOfMonth: 0, payLink: LINK, minAmount: SEK(0) }, "pay_request_invalid"],
      [{ enabled: true, dayOfMonth: 1.5, payLink: LINK, minAmount: SEK(0) }, "pay_request_invalid"],
      [{ dayOfMonth: 1, payLink: LINK, minAmount: SEK(0) }, "pay_request_invalid"],
      ["on", "pay_request_invalid"],
    ];
    for (const [setting, reason] of cases) {
      const res = await put(setting);
      expect([res.statusCode, res.json().reason], JSON.stringify(setting)).toEqual([400, reason]);
    }
  });

  it("a valid setting saves (on, and off with nothing set); the contract default is off with no link", async () => {
    const on = await put({ enabled: true, dayOfMonth: 28, payLink: LINK, minAmount: SEK(0) });
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json().document.driverPayRequest).toEqual({ enabled: true, dayOfMonth: 28, payLink: LINK, minAmount: SEK(0) });
    const off = await put({ enabled: false, dayOfMonth: 1, payLink: "", minAmount: null });
    expect(off.statusCode, off.body).toBe(200);
    const defaults = JSON.parse(readFileSync(`${CONTRACTS_DIR}/contract.json`, "utf8")).configDefaults.driverPayRequest;
    expect(defaults).toEqual({ enabled: false, dayOfMonth: 1, payLink: "", minAmount: null });
  });

  it("Restore / Undo keeps it too (the live link and switch stay): it is in the kept-on-restore list", () => {
    expect(KEPT_ON_RESTORE.country_rules).toContain("driverPayRequest");
    expect(KEPT_KEYS.country_rules).toContain("driverPayRequest");
  });

  it("a kept key: a whole-document save that leaves it out keeps the stored link and switch", async () => {
    expect((await put({ enabled: true, dayOfMonth: 5, payLink: LINK, minAmount: SEK(500) })).statusCode).toBe(200);
    const left = await put(undefined);
    expect(left.statusCode, left.body).toBe(200);
    expect(left.json().document.driverPayRequest).toEqual({ enabled: true, dayOfMonth: 5, payLink: LINK, minAmount: SEK(500) });
    expect(left.json().keptKeys).toContain("driverPayRequest");
  });
});

describe("driverPayRequest: GET /driver/pay-movera", () => {
  it("off (the default): the amount and the reference, no link, no request", async () => {
    await entry(ali.id, { amount: 32516, cash: 34900 });
    expect(await payMovera()).toEqual({ enabled: false, owedToMovera: SEK(2384), reference: `${ali.id}-202611` });
  });

  it("on: the admin's link as it is and the minimum; the amount is the same owed as the wallet's", async () => {
    await live("SE", "SEK", ON());
    await entry(ali.id, { amount: 32516, cash: 34900 });
    const view = await payMovera();
    expect(view).toEqual({ enabled: true, owedToMovera: SEK(2384), reference: `${ali.id}-202611`, payLink: LINK, minAmount: SEK(1000) });
    expect(view.owedToMovera).toEqual((await earnings()).moveraBalance.owedToMovera);
  });

  it("a live document that says on but has no usable link or amount is read as off (nobody is sent a bad link)", async () => {
    for (const broken of [{ payLink: "http://x.example" }, { payLink: "" }, { payLink: "https://sumup.com@evil.example/pay" }, { payLink: "https://pay.sumup.com/\u200bx" }, { minAmount: null }, { minAmount: { amountMinor: 5, currency: "EUR" } }]) {
      await live("SE", "SEK", ON(broken));
      const view = await payMovera();
      expect([view.enabled, view.payLink], JSON.stringify(broken)).toEqual([false, undefined]);
    }
  });

  it("only a driver may read it, and only his own", async () => {
    expect((await call(app, "GET", "/driver/pay-movera", {})).statusCode).toBe(401);
    const rider = await signIn(app, TEST_PHONES[0]!, "rider");
    expect((await call(app, "GET", "/driver/pay-movera", rider.headers)).statusCode).toBe(403);
  });

  it("a driver with no country yet: 404 no_country", async () => {
    await database.db.updateTable("drivers").set({ country: null }).where("driver_id", "=", ali.id).execute();
    try {
      const res = await call(app, "GET", "/driver/pay-movera", ali.headers);
      expect([res.statusCode, res.json().reason]).toEqual([404, "no_country"]);
    } finally {
      await database.db.updateTable("drivers").set({ country: "SE" }).where("driver_id", "=", ali.id).execute();
    }
  });
});

describe("driverPayRequest: the monthly job", () => {
  it("off (the default): nobody is asked, whatever he owes", async () => {
    await entry(ali.id, { amount: 0, cash: 500000 });
    await scan();
    expect(await requests()).toEqual([]);
    expect(await notices()).toEqual([]);
  });

  it("switched OFF but the link and the minimum are still stored: nobody is asked (review should-fix 2)", async () => {
    await live("SE", "SEK", ON({ enabled: false }));
    await entry(ali.id, { amount: 0, cash: 500000 });
    await scan();
    expect(await requests()).toEqual([]);
    expect(await notices()).toEqual([]);
    expect(await payMovera()).toEqual({ enabled: false, owedToMovera: SEK(500000), reference: `${ali.id}-202611` });
  });

  it("two copies inside the same step at the same moment: the second one's insert meets the first one's row and writes no second notice (review should-fix 3)", async () => {
    await live("SE", "SEK", ON());
    await entry(ali.id, { amount: 0, cash: 5000 });
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    let asked!: () => void;
    const firstAsked = new Promise<void>((resolve) => (asked = resolve));
    // Copy 1 asks him and keeps its transaction open; copy 2 cannot see that row yet, so its own insert waits on it.
    const first = database.db.transaction().execute(async (trx) => {
      await askCountry(trx, "SE", clock.now);
      asked();
      await hold;
    });
    await firstAsked;
    const second = database.db.transaction().execute((trx) => askCountry(trx, "SE", clock.now));
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    await Promise.all([first, second]);
    expect(await requests()).toHaveLength(1);
    expect(await notices()).toHaveLength(1);
  });

  it("on its day from 09:00: a driver who owes MORE than the minimum gets one bell notice + push with the amount; at the minimum or below, not", async () => {
    await live("SE", "SEK", ON());
    const atMin = await driverIn("SE");
    const below = await driverIn("SE");
    const creditor = await driverIn("SE");
    await entry(ali.id, { amount: 32516, cash: 34900 });
    await entry(atMin, { amount: 0, cash: 1000 });
    await entry(below, { amount: 0, cash: 999 });
    await entry(creditor, { amount: 9000, cash: 0 });
    await scan();
    expect((await requests()).map((r) => [r.driver_id, r.month, r.currency, Number(r.asked_minor), r.asked_at.toISOString()])).toEqual([[ali.id, "2026-11", "SEK", 2384, DAY1.toISOString()]]);
    const sent = await notices();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ subject_id: ali.id, audience: "driver", kind: "driver_pay_movera", deep_link: "movera-driver://pay-movera", title: "Betala Movera", body: "Du är skyldig Movera 23,84 kr. Öppna för att betala.", data: { month: "2026-11", amountMinor: 2384, currency: "SEK" } });
    // He sees it in his list, and the screen shows the request.
    const list = (await call(app, "GET", "/notifications", ali.headers)).json();
    expect(list.items.map((i: { kind: string }) => i.kind)).toContain("driver_pay_movera");
    expect((await payMovera()).request).toEqual({ month: "2026-11", askedAt: DAY1.toISOString(), askedAmount: SEK(2384) });
  });

  it("asked once: the hourly runs of the same day, a retry and two server copies at the same moment never ask twice", async () => {
    await live("SE", "SEK", ON());
    await entry(ali.id, { amount: 0, cash: 5000 });
    await scan();
    for (let hour = 0; hour < 5; hour++) {
      clock.now = new Date(clock.now.getTime() + 3_600_000);
      await scan();
    }
    expect(await notices()).toHaveLength(1);
    // Two copies race for a second driver.
    const second = await driverIn("SE");
    await entry(second, { amount: 0, cash: 7000 });
    await database.db.deleteFrom("timers").execute();
    await database.db.insertInto("timers").values({ kind: PAY_REQUEST_SCAN, ref_id: "all", due_at: clock.now, payload: "{}" }).execute();
    await Promise.all([worker().runDue(10_000), worker().runDue(10_000)]);
    expect((await notices()).map((x) => x.subject_id).sort()).toEqual([ali.id, second].sort());
    expect(await requests()).toHaveLength(2);
    // More owed later the same month: still not asked again.
    await entry(ali.id, { amount: 0, cash: 90000 });
    await scan();
    expect(await notices()).toHaveLength(2);
  });

  it("the next month he is asked again, with that month's amount and reference", async () => {
    await live("SE", "SEK", ON());
    await entry(ali.id, { amount: 0, cash: 5000 });
    await scan();
    clock.now = new Date("2026-12-01T09:30:00.000Z");
    await scan();
    expect((await requests()).map((r) => r.month)).toEqual(["2026-11", "2026-12"]);
    expect(await notices()).toHaveLength(2);
    ali.headers = (await signIn(app, TEST_PHONES[1]!, "driver")).headers; // a month later: a fresh session
    expect((await payMovera()).reference).toBe(`${ali.id}-202612`);
  });

  it("not on another day, and not before 09:00 in the country's clock", async () => {
    await live("SE", "SEK", ON());
    await entry(ali.id, { amount: 0, cash: 5000 });
    for (const at of ["2026-11-02T09:30:00.000Z", "2026-10-31T22:30:00.000Z", "2026-11-01T07:59:00.000Z", "2026-10-31T23:30:00.000Z"]) {
      clock.now = new Date(at);
      await scan();
      expect(await notices(), at).toEqual([]);
    }
    // 08:00Z is 09:00 in Stockholm (winter time): asked.
    clock.now = new Date("2026-11-01T08:00:00.000Z");
    expect(localMonthDay(clock.now, "Europe/Stockholm")).toEqual({ month: "2026-11", day: 1, hour: 9 });
    await scan();
    expect(await notices()).toHaveLength(1);
  });

  it("the admin's day: day 15 asks on the 15th only", async () => {
    await live("SE", "SEK", ON({ dayOfMonth: 15 }));
    await entry(ali.id, { amount: 0, cash: 5000 });
    await scan();
    expect(await notices()).toEqual([]);
    clock.now = new Date("2026-11-15T12:00:00.000Z");
    await scan();
    expect(await notices()).toHaveLength(1);
  });

  it("per country: a driver of a country that is off is not asked; what he owes in another currency does not count", async () => {
    await live("SE", "SEK", ON());
    const french = await driverIn("FR");
    await entry(french, { amount: 0, cash: 90000 });
    await entry(ali.id, { amount: 0, cash: 90000, currency: "EUR" });
    await scan();
    expect(await notices()).toEqual([]);
  });

  it("the notice is in the driver's own language", async () => {
    await live("SE", "SEK", ON());
    const fr = await driverIn("SE");
    const en = await driverIn("SE");
    await database.db.updateTable("drivers").set({ language: "fr" }).where("driver_id", "=", fr).execute();
    await database.db.updateTable("drivers").set({ language: "en" }).where("driver_id", "=", en).execute();
    await entry(fr, { amount: 0, cash: 5000 });
    await entry(en, { amount: 0, cash: 123456 });
    await scan();
    const byId = new Map((await notices()).map((x) => [x.subject_id, [x.title, x.body]]));
    expect(byId.get(fr)).toEqual(["Payer Movera", "Vous devez 50,00 kr à Movera. Ouvrez pour payer."]);
    expect(byId.get(en)).toEqual(["Pay Movera", "You owe Movera 1 234,56 kr. Open to pay."]);
  });

  it("more drivers than one batch: every one is asked once, in bounded steps", async () => {
    await live("SE", "SEK", ON());
    const many = PAY_REQUEST_BATCH + 7;
    const ids = Array.from({ length: many }, (_, i) => `drv_batch${String(i).padStart(4, "0")}`);
    await database.db.insertInto("drivers").values(ids.map((driver_id, i) => ({ driver_id, phone: `+4673999${String(i).padStart(4, "0")}`, online_since: null, vehicle_id: null, scheduled_rides: null, zone_ids: ["Z001"], country: "SE" })) as never).execute();
    await database.db.insertInto("earnings_entries").values(ids.map((driver_id, i) => ({ entry_id: `ern_batch${i}`, driver_id, trip_id: null, kind: "trip" as const, currency: "SEK", amount_minor: 0, gross_minor: null, commission_minor: null, cash_minor: 5000, at: clock.now }))).execute();
    await scan();
    expect(await requests()).toHaveLength(many);
    expect(await notices()).toHaveLength(many);
  });

  it("it is a recurring job: booked at start, re-booked every hour, watched by /healthz/jobs, on the housekeeping lane", async () => {
    await ensureMaintenanceTimers(database.db, clock.now);
    const booked = await database.db.selectFrom("timers").select(["kind", "ref_id"]).where("kind", "=", PAY_REQUEST_SCAN).execute();
    expect(booked).toEqual([{ kind: PAY_REQUEST_SCAN, ref_id: "all" }]);
    await worker().runDue(10_000);
    const next = await database.db.selectFrom("timers").select("due_at").where("kind", "=", PAY_REQUEST_SCAN).executeTakeFirstOrThrow();
    expect(next.due_at.getTime() - clock.now.getTime()).toBe(3_600_000);
    expect(RECURRING_JOBS).toContainEqual({ kind: PAY_REQUEST_SCAN, everyMs: 3_600_000 });
    expect(HOUSEKEEPING_LANE_KINDS).toContain(PAY_REQUEST_SCAN);
    const health = await app.inject({ method: "GET", url: "/healthz/jobs" });
    expect(health.json().jobs.filter((j: { kind: string }) => j.kind === PAY_REQUEST_SCAN)).toEqual([]);
    await database.db.deleteFrom("timers").where("kind", "=", PAY_REQUEST_SCAN).execute();
    const missing = await app.inject({ method: "GET", url: "/healthz/jobs" });
    expect(missing.json().jobs).toContainEqual({ kind: PAY_REQUEST_SCAN, state: "missing" });
  });
});

describe("driverPayRequest: the payment is confirmed by the admin's \"Driver paid Movera\" only", () => {
  it("after he paid by the link nothing changes until the admin records it; then the wallet and the screen show less", async () => {
    await live("SE", "SEK", ON());
    await entry(ali.id, { amount: 0, cash: 50000 });
    await scan();
    expect((await payMovera()).owedToMovera).toEqual(SEK(50000));
    const admin = await adminSession(app, database.db, "super", { now: clock.now });
    const paid = await call(app, "POST", `/admin/drivers/${ali.id}/paid-movera`, admin.headers, { expectedOwed: SEK(50000), amount: SEK(50000), reason: `SumUp ${payReference(ali.id, "2026-11")}` });
    expect(paid.statusCode, paid.body).toBe(200);
    expect((await payMovera()).owedToMovera).toEqual(SEK(0));
    expect((await earnings()).moveraBalance).toEqual({ owedToMovera: SEK(0), moveraOwesYou: SEK(0) });
    // More than he owes is refused as before: nothing is ever taken twice by this path.
    const again = await call(app, "POST", `/admin/drivers/${ali.id}/paid-movera`, admin.headers, { expectedOwed: SEK(0), amount: SEK(100), reason: "twice" });
    expect(again.statusCode).toBe(400);
  });

  it("the job never writes money: no earnings entry, no payout", async () => {
    await live("SE", "SEK", ON());
    await entry(ali.id, { amount: 0, cash: 50000 });
    const before = await database.db.selectFrom("earnings_entries").selectAll().orderBy("entry_id").execute();
    await scan();
    expect(await database.db.selectFrom("earnings_entries").selectAll().orderBy("entry_id").execute()).toEqual(before);
    expect(await database.db.selectFrom("payouts").selectAll().execute()).toEqual([]);
  });
});
