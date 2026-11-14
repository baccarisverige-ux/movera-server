import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { dispatchHandlers } from "../../src/dispatch/runtime.js";
import { candidatesFor } from "../../src/dispatch/runtime/candidates.js";
import { seedDriver } from "../../src/drivers/service.js";
import { TimerWorker } from "../../src/jobs/timers.js";
import { rideHandlers } from "../../src/trips/ride.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { adminSession } from "../support/admin.js";
import { approveDriverDocuments, approveVehicleDocuments, insertTrip } from "../support/seed.js";
import { call, NORRMALM, SODERMALM, signIn, testWorld } from "../support/world.js";

/**
 * S5 J8 — the server part of the J7 debt model (contract v0.18.84 `debtModel`, owner decisions/session-2026-11-06.md
 * 1231-1247: the weekly cash-owed limit 150 DT TN, admin-changeable, OFF by default; over it NO cash trips and never
 * blocked from going online; owed = net + carried; any max rider debt, the floor follows it; accepted booked cash
 * rides are kept). Supervisor rounds of J7: a negative wallet charged once (M2), no double pay at the changeover (M3),
 * fee headroom at the floor (R2-1/R2-2).
 */

let database: TestDatabase;
let app: FastifyInstance;
let worker: TimerWorker;
const clock = { now: new Date("2026-11-16T10:00:00Z") };
const sample = (name: string) => JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/${name}.json`, "utf8"));
const SEK = (amountMinor: number) => ({ amountMinor, currency: "SEK" });
const NEW_APP = { "x-contract-version": "0.18.85" };

const SPOTS = { A: { lat: 59.3335, lng: 18.0655 }, B: { lat: 59.3360, lng: 18.07 } };
const drivers: Record<"A" | "B", { id: string; headers: Record<string, string> }> = {} as never;
let rider: Record<string, string>;
let riderId: string;

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  await database.db.insertInto("config_live").values([
    { doc: "dispatch", zone_id: "Z001", version: 1, document: JSON.stringify(sample("dispatch_document")), published_at: clock.now, published_by: null },
    { doc: "rider_app_config", zone_id: "Z001", version: 1, document: JSON.stringify(sample("rider_app_config")), published_at: clock.now, published_by: null },
  ]).execute();
  worker = new TimerWorker(database.db, { handlers: { ...dispatchHandlers, ...rideHandlers }, logger: { warn: () => undefined, error: (d, m) => console.error(m, d) }, clock: () => clock.now });
  const phones = { A: TEST_PHONES[1]!, B: TEST_PHONES[2]! };
  for (const key of ["A", "B"] as const) {
    const made = await database.db.transaction().execute((trx) =>
      seedDriver(trx, { phone: phones[key], firstName: `Driver ${key}`, make: "Volvo", model: "V60", year: 2021, color: "Black", plate: `DBT00${key}`, categoryIds: ["economy"], zoneIds: ["Z001"] }, clock.now),
    );
    drivers[key] = { id: made.driverId, headers: {} };
  }
  await database.db.updateTable("drivers").set({ country: "SE" }).execute();
  // Going online checks the papers: every required driver and car document approved.
  for (const key of ["A", "B"] as const) {
    const row = await database.db.selectFrom("drivers").select("vehicle_id").where("driver_id", "=", drivers[key].id).executeTakeFirstOrThrow();
    await approveDriverDocuments(database.db, drivers[key].id);
    if (row.vehicle_id) await approveVehicleDocuments(database.db, row.vehicle_id, drivers[key].id, "SE");
  }
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

const fix = (at: { lat: number; lng: number }) => ({ fixes: [{ ...at, accuracy: 5, measuredAt: clock.now.toISOString() }] });
async function moveTo(key: "A" | "B", at: { lat: number; lng: number }) {
  expect((await call(app, "POST", "/driver/location", drivers[key].headers, fix(at))).statusCode).toBe(200);
}

/** CountryRules of standard-SE as live (the admin's Tips & limits). */
async function countryRules(doc: Record<string, unknown>) {
  await database.db.deleteFrom("config_live").where("doc", "=", "country_rules").where("zone_id", "=", "standard-SE").execute();
  await database.db.insertInto("config_live").values({ doc: "country_rules", zone_id: "standard-SE", version: 1, document: JSON.stringify({ country: "SE", currency: "SEK", ...doc }), published_at: clock.now, published_by: null }).execute();
}
const LIMIT_ON = { driverOwesLimit: { enabled: true, max: SEK(100_000) } };

/** A driver owes Movera `owed` (minor SEK): one unpaid cash trip whose cash is above his earnings by that much. */
async function owes(key: "A" | "B", owed: number) {
  await database.db.insertInto("earnings_entries").values({ entry_id: `ern_${key}_${clock.now.getTime()}_${owed}`, driver_id: drivers[key].id, trip_id: null, kind: "adjustment", currency: "SEK", amount_minor: -owed, at: clock.now }).execute();
}

beforeEach(async () => {
  clock.now = new Date(clock.now.getTime() + 3600_000);
  await database.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("status", "not in", ["completed", "cancelled_by_admin", "cancelled_by_rider", "cancelled_by_driver", "no_show", "expired"]).execute();
  await database.db.deleteFrom("timers").execute();
  await database.db.deleteFrom("offers").execute();
  // Every entry first (a payout run of a test links entries to its payout), then the payouts.
  await database.db.deleteFrom("earnings_entries").execute();
  await database.db.deleteFrom("payouts").execute();
  await database.db.updateTable("rider_fees").set({ status: "waived", settled_in_wallet: true }).where("status", "=", "owed").execute();
  await database.db.deleteFrom("rider_wallets").execute();
  await database.db.deleteFrom("config_live").where("doc", "=", "country_rules").execute();
  const signedIn = await signIn(app, TEST_PHONES[0]!, "rider");
  rider = signedIn.headers;
  riderId = (await call(app, "GET", "/rider/profile", rider)).json().riderId;
  await database.db.updateTable("riders").set({ outstanding_minor: 0, outstanding_currency: null, outstanding_source_trip_id: null }).execute();
  for (const key of ["A", "B"] as const) {
    drivers[key].headers = (await signIn(app, { A: TEST_PHONES[1], B: TEST_PHONES[2] }[key]!, "driver")).headers;
    await database.db.updateTable("drivers").set({ online_status: "online", last_free_at: clock.now, rating_sum: 0, rating_count: 0, offline_after_trip: false }).where("driver_id", "=", drivers[key].id).execute();
    await moveTo(key, SPOTS[key]);
  }
});

async function book(extra: Record<string, unknown> = {}) {
  const quote = (await call(app, "POST", "/quotes", { ...rider, ...NEW_APP }, { pickup: NORRMALM, dropoff: SODERMALM, stops: [], categoryIds: ["economy"] })).json().quotes[0];
  const res = await call(app, "POST", "/trips", rider, { quoteId: quote.quoteId, categoryId: "economy", pickup: NORRMALM, dropoff: SODERMALM, stops: [], kind: "live", paymentMethod: "cash", ...extra });
  await worker.runDue();
  return { res, tripId: res.json().tripId as string, quote };
}
const offersOf = async (key: "A" | "B") => (await call(app, "GET", "/driver/offers", drivers[key].headers)).json().items as Array<{ offerId: string; tripId: string; version: number }>;

async function accepted() {
  for (const key of ["A", "B"] as const) {
    clock.now = new Date(clock.now.getTime() + 1000);
    await moveTo(key, SPOTS[key]);
  }
  await database.db.deleteFrom("offers").where("status", "!=", "open").execute();
  const { tripId, quote } = await book();
  const [offer] = await offersOf("A");
  expect(offer?.tripId).toBe(tripId);
  const res = await call(app, "POST", `/offers/${offer!.offerId}/accept`, drivers.A.headers, { expectedVersion: offer!.version });
  expect(res.statusCode).toBe(200);
  return { tripId, quote, version: res.json().version as number };
}
const step = (tripId: string, path: string, version: number, body: Record<string, unknown> = {}) => call(app, "POST", `/trips/${tripId}/${path}`, drivers.A.headers, { expectedVersion: version, ...body });
async function driveAndComplete(tripId: string, version: number, body: Record<string, unknown> = {}) {
  let v = version;
  for (const path of ["head-to-pickup", "arrive", "board", "start"]) expect((await step(tripId, path, v++)).statusCode).toBe(200);
  clock.now = new Date(clock.now.getTime() + 1000);
  await moveTo("A", SODERMALM);
  return step(tripId, "complete", v, body);
}

/** An unpaid no-show fee of `amount` kr (minor) on a past trip of the rider, through the server's own fee path. */
async function feeOwed(amount: number, options: { oldServerCopy?: boolean } = {}) {
  const tripId = await insertTrip(database.db, riderId, { status: "no_show" });
  if (options.oldServerCopy) {
    // A fee written by a server copy without J8: rider_fees owed, nothing in the wallet.
    await database.db.insertInto("rider_fees").values({ trip_id: tripId, rider_id: riderId, kind: "no_show", currency: "SEK", amount_minor: amount, status: "owed", created_at: clock.now }).execute();
    return tripId;
  }
  const { chargeRiderFee } = await import("../../src/trips/ride/money.js");
  const trip = await database.db.selectFrom("trips").selectAll().where("trip_id", "=", tripId).executeTakeFirstOrThrow();
  await database.db.transaction().execute((trx) => chargeRiderFee(trx, trip, "no_show", SEK(amount), clock.now));
  return tripId;
}
const balance = async () => Number((await database.db.selectFrom("rider_wallets").select("balance_minor").where("rider_id", "=", riderId).where("currency", "=", "SEK").executeTakeFirst())?.balance_minor ?? 0);

/* ================================================================ driver owes-limit */

describe("J8 driver owes-limit (debtModel.driverOwes, owner 14:54 / 14:59 / 15:01)", () => {
  it("limit OFF changes nothing: a driver who owes a lot still gets cash offers", async () => {
    await owes("A", 500_000);
    const { tripId } = await book();
    expect((await offersOf("A")).map((o) => o.tripId)).toContain(tripId);
  });

  it("limit ON, owed at or over it: no cash offers to him; the next driver gets the trip; a card trip would still reach him", async () => {
    await countryRules(LIMIT_ON);
    await owes("A", 100_000);
    const { tripId } = await book();
    expect(await offersOf("A")).toEqual([]);
    expect((await offersOf("B")).map((o) => o.tripId)).toContain(tripId);
    // The same trip paid by card: A is a candidate again (only pay-in-car trips stop).
    const row = await database.db.selectFrom("trips").selectAll().where("trip_id", "=", tripId).executeTakeFirstOrThrow();
    const live = await database.db.selectFrom("config_live").select("document").where("doc", "=", "dispatch").where("zone_id", "=", "Z001").executeTakeFirstOrThrow();
    const pool = await database.db.transaction().execute((trx) => candidatesFor(trx, { ...row, payment_method: "card" }, live.document as never, clock.now));
    expect(pool.candidates.map((c) => c.driverId)).toContain(drivers.A.id);
    const cashPool = await database.db.transaction().execute((trx) => candidatesFor(trx, row, live.document as never, clock.now));
    expect(cashPool.candidates.map((c) => c.driverId)).not.toContain(drivers.A.id);
  });

  it("limit ON, owed just under it: cash offers as before", async () => {
    await countryRules(LIMIT_ON);
    await owes("A", 99_999);
    const { tripId } = await book();
    expect((await offersOf("A")).map((o) => o.tripId)).toContain(tripId);
  });

  it("going online is still allowed; the Home line is orange (due_soon) and never counts as blocking", async () => {
    await countryRules(LIMIT_ON);
    await owes("A", 150_000);
    await database.db.updateTable("drivers").set({ online_status: "offline" }).where("driver_id", "=", drivers.A.id).execute();
    const me = (await call(app, "GET", "/driver/profile", drivers.A.headers)).json();
    const online = await call(app, "POST", "/driver/availability", drivers.A.headers, { expectedVersion: me.version, onlineStatus: "online", location: { ...SPOTS.A, accuracy: 5, measuredAt: clock.now.toISOString() } });
    expect(online.statusCode, online.body).toBe(200);
    const lines = (await call(app, "GET", "/driver/reminders", { ...drivers.A.headers, ...NEW_APP })).json();
    expect(lines.items).toEqual(expect.arrayContaining([{ kind: "owes_movera_over_limit", level: "due_soon", owed: SEK(150_000), limit: SEK(100_000) }]));
    expect(lines.items.filter((i: { level: string }) => i.level === "blocks_online")).toEqual([]);
    // An older app (no X-Contract-Version 0.18.84) never gets the new line.
    const old = (await call(app, "GET", "/driver/reminders", drivers.A.headers)).json();
    expect(old.items.map((i: { kind: string }) => i.kind)).not.toContain("owes_movera_over_limit");
  });

  it("accepted rides are kept: a booked cash ride he already accepted and the current trip stay his; only his OPEN cash offers go", async () => {
    // An open cash offer, sent while the limit was off.
    const { tripId } = await book();
    const [offer] = await offersOf("A");
    expect(offer?.tripId).toBe(tripId);
    // A booked pay-in-car ride he accepted earlier (held for later).
    const booked = await insertTrip(database.db, riderId, { status: "accepted", kind: "scheduled", driverId: drivers.A.id });
    await database.db.updateTable("trips").set({ zone_id: "Z001", payment_method: "cash", scheduled_at: new Date(clock.now.getTime() + 3 * 3600_000), accepted_at: clock.now }).where("trip_id", "=", booked).execute();
    // He reaches the limit: the withdraw job closes the OPEN cash offer only.
    await countryRules(LIMIT_ON);
    await owes("A", 120_000);
    const { checkCashOffersSoon } = await import("../../src/drivers/owes.js");
    await database.db.transaction().execute((trx) => checkCashOffersSoon(trx, drivers.A.id, clock.now));
    await worker.runDue();
    expect((await database.db.selectFrom("offers").select("status").where("offer_id", "=", offer!.offerId).executeTakeFirstOrThrow()).status).toBe("withdrawn");
    const kept = await database.db.selectFrom("trips").select(["driver_id", "status"]).where("trip_id", "=", booked).executeTakeFirstOrThrow();
    expect(kept).toEqual({ driver_id: drivers.A.id, status: "accepted" });
    // An accept of a cash offer that still reaches the server is refused with the reason and owed / limit.
    const refused = await call(app, "POST", `/offers/${offer!.offerId}/accept`, drivers.A.headers, { expectedVersion: offer!.version });
    expect(refused.statusCode).toBe(409);
  });

  it("an admin assign of a cash trip to him is 409 driver_owes_movera with owed / limit", async () => {
    await countryRules(LIMIT_ON);
    await owes("A", 100_000);
    await database.db.updateTable("drivers").set({ online_status: "offline" }).where("driver_id", "=", drivers.B.id).execute();
    const { tripId } = await book();
    const admin = await adminSession(app, database.db, "super", { now: clock.now });
    const trip = (await call(app, "GET", `/admin/trips/${tripId}`, admin.headers)).json();
    const res = await call(app, "POST", `/admin/trips/${tripId}/assign`, admin.headers, { expectedVersion: trip.version, driverId: drivers.A.id });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ reason: "driver_owes_movera", details: ["owed:100000 SEK", "limit:100000 SEK"] });
  });

  it("owed = net + carried: unpaid entries (cash above earnings) plus an open payout below 0; Driver paid Movera lowers it", async () => {
    // Unpaid: a cash trip, 300 kr cash for 100 kr earnings (−200 kr), a 20 kr tip paid in cash (no change), a 50 kr bonus.
    await database.db.insertInto("earnings_entries").values([
      { entry_id: "ern_owed_1", driver_id: drivers.A.id, trip_id: null, kind: "adjustment", currency: "SEK", amount_minor: 10_000, at: clock.now },
      { entry_id: "ern_owed_2", driver_id: drivers.A.id, trip_id: null, kind: "bonus", currency: "SEK", amount_minor: 5_000, at: clock.now },
    ]).execute();
    const tripRow = await insertTrip(database.db, riderId, { status: "completed", driverId: drivers.A.id });
    await database.db.insertInto("earnings_entries").values([
      { entry_id: "ern_owed_3", driver_id: drivers.A.id, trip_id: tripRow, kind: "trip", currency: "SEK", amount_minor: 10_000, cash_minor: 30_000, at: clock.now },
      { entry_id: "ern_owed_4", driver_id: drivers.A.id, trip_id: tripRow, kind: "tip", currency: "SEK", amount_minor: 2_000, cash_minor: 2_000, at: clock.now },
    ]).execute();
    // Carried: last week's payout came out at −150 kr and is not settled yet.
    await database.db.insertInto("payouts").values({ payout_id: "pyt_carried", driver_id: drivers.A.id, zone_id: "Z001", currency: "SEK", amount_minor: -15_000, lines: JSON.stringify([]), trip_count: 0, source: "weekly", period_start: new Date(clock.now.getTime() - 14 * 86_400_000), period_end: new Date(clock.now.getTime() - 7 * 86_400_000), note: null, created_by: null, created_at: clock.now }).execute();
    // net = 100 + 50 + 100 − 300 + 20 − 20 = −50 kr; carried −150 kr → owed 200 kr.
    const { owedByDriver } = await import("../../src/drivers/owes.js");
    expect((await owedByDriver(database.db, [drivers.A.id, drivers.B.id], "SEK")).get(drivers.A.id)).toBe(20_000);
    const admin = await adminSession(app, database.db, "super", { now: clock.now });
    const list = (await call(app, "GET", "/admin/drivers-owing", admin.headers)).json();
    expect(list.items).toEqual([expect.objectContaining({ driverId: drivers.A.id, owed: SEK(20_000), limit: null, overLimit: false })]);
    expect(list.total).toBe(1);
    // Driver paid Movera: a stale expectedOwed is 409 owed_changed; more than owed is 400 paid_above_owed.
    const url = `/admin/drivers/${drivers.A.id}/paid-movera`;
    expect((await call(app, "POST", url, admin.headers, { expectedOwed: SEK(19_000), amount: SEK(5_000), reason: "Swish" })).json()).toMatchObject({ reason: "owed_changed" });
    expect((await call(app, "POST", url, admin.headers, { expectedOwed: SEK(20_000), amount: SEK(20_001), reason: "Swish" })).json()).toMatchObject({ reason: "paid_above_owed" });
    const paid = await call(app, "POST", url, admin.headers, { expectedOwed: SEK(20_000), amount: SEK(5_000), reason: "Swish" });
    expect(paid.statusCode).toBe(200);
    expect(paid.json()).toMatchObject({ driverId: drivers.A.id, owed: SEK(15_000) });
  });
});

/* ================================================================ the rider's debt in the wallet */

describe("J8 rider debt (debtModel.riderWallet / readAtPayment / changeover)", () => {
  it("a fee makes the wallet negative; the quote shows walletDebt and never prices it; paid once with the next trip", async () => {
    const feeTrip = await feeOwed(6_500);
    expect(await balance()).toBe(-6_500);
    expect((await call(app, "GET", "/rider/profile", rider)).json().outstanding).toEqual(SEK(6_500));
    const { tripId, quote, version } = await accepted();
    expect(quote.fareLines.map((l: { code: string }) => l.code)).not.toContain("outstanding_fee");
    expect(quote.walletDebt).toEqual(SEK(6_500));
    // M2: a negative balance never lowers the cash to collect (walletApplied 0).
    const trip = await database.db.selectFrom("trips").select(["fare_minor", "wallet_applied_minor"]).where("trip_id", "=", tripId).executeTakeFirstOrThrow();
    expect(Number(trip.wallet_applied_minor)).toBe(0);
    const done = await driveAndComplete(tripId, version);
    expect(done.statusCode).toBe(200);
    const fare = Number(trip.fare_minor);
    expect(done.json().fare).toEqual(SEK(fare + 6_500));
    expect(done.json().fareLines).toEqual(expect.arrayContaining([{ code: "outstanding_fee", amount: SEK(6_500), sourceTripId: feeTrip }]));
    expect(await balance()).toBe(0);
    const kinds = await database.db.selectFrom("wallet_entries").select(["kind", "amount_minor"]).where("rider_id", "=", riderId).where("kind", "in", ["fee", "debt_paid"]).orderBy("entry_id").execute();
    expect(kinds.slice(-2)).toEqual([{ kind: "fee", amount_minor: "-6500" }, { kind: "debt_paid", amount_minor: "6500" }]);
    expect((await call(app, "GET", "/rider/profile", rider)).json().outstanding).toBeNull();
    // A second trip reads 0: the debt was paid once.
    const second = await accepted();
    const again = await driveAndComplete(second.tripId, second.version);
    expect(again.json().fareLines.map((l: { code: string }) => l.code)).not.toContain("outstanding_fee");
  });

  it("negative wallet charged once even when two trips are paid one after the other with walletFirst false", async () => {
    await feeOwed(24_000);
    const one = await accepted();
    // Never copied into a price: the quote carries no outstanding_fee line (the old model copied it into every quote).
    expect(one.quote.fareLines.map((l: { code: string }) => l.code)).not.toContain("outstanding_fee");
    const doneOne = await driveAndComplete(one.tripId, one.version);
    expect(doneOne.json().fareLines).toEqual(expect.arrayContaining([expect.objectContaining({ code: "outstanding_fee", amount: SEK(24_000) })]));
    const two = await book({ walletFirst: false });
    expect(two.res.statusCode).toBe(201);
    const debtLines = await database.db.selectFrom("trips").select(sql<number>`count(*)`.as("n")).where("rider_id", "=", riderId).where(sql<boolean>`fare_lines @> '[{"code":"outstanding_fee"}]'::jsonb`).where("status", "=", "completed").where("trip_id", "in", [one.tripId, two.tripId]).executeTakeFirstOrThrow();
    expect(Number(debtLines.n)).toBe(1);
    expect(await balance()).toBe(0);
    const paidEntries = await database.db.selectFrom("wallet_entries").select(["kind", "amount_minor", "trip_id"]).where("rider_id", "=", riderId).where("kind", "=", "debt_paid").where("trip_id", "in", [one.tripId, two.tripId]).execute();
    expect(paidEntries).toEqual([{ kind: "debt_paid", amount_minor: "24000", trip_id: one.tripId }]);
  });

  it("while the rider owes, walletFirst false is ignored; a cash booking at the max is 409 rider_debt_above_max", async () => {
    await countryRules({ maxRiderDebt: SEK(10_000) });
    await feeOwed(6_500);
    const ok = await book({ walletFirst: false });
    expect(ok.res.statusCode).toBe(201);
    expect(ok.res.json().walletFirst).toBe(true);
    await call(app, "POST", `/trips/${ok.tripId}/cancel`, rider, { expectedVersion: ok.res.json().version, reasonCode: "plans_changed" });
    await feeOwed(3_500);
    const refused = await book();
    expect(refused.res.statusCode).toBe(409);
    expect(refused.res.json()).toMatchObject({ reason: "rider_debt_above_max", details: ["debt:10000 SEK", "max:10000 SEK"] });
  });

  it("no double pay at the changeover: a trip made before J8 with a copied 240 kr line pays the debt once, not on top", async () => {
    const { tripId, version } = await accepted();
    // Made before J8: the quote copied the 240 kr owed fee into the price; the fee was written by an old server copy.
    const oldFeeTrip = await feeOwed(24_000, { oldServerCopy: true });
    const row = await database.db.selectFrom("trips").select(["fare_minor", "fare_lines", "booked_fare_minor"]).where("trip_id", "=", tripId).executeTakeFirstOrThrow();
    const base = Number(row.fare_minor);
    await database.db.updateTable("trips").set({
      fare_minor: base + 24_000,
      booked_fare_minor: Number(row.booked_fare_minor) + 24_000,
      fare_lines: JSON.stringify([...(row.fare_lines as object[]), { code: "outstanding_fee", amount: SEK(24_000) }]),
    }).where("trip_id", "=", tripId).execute();
    const done = await driveAndComplete(tripId, version);
    expect(done.statusCode).toBe(200);
    expect(done.json().fare).toEqual(SEK(base + 24_000));
    expect(done.json().fareLines.filter((l: { code: string }) => l.code === "outstanding_fee")).toHaveLength(1);
    expect(await balance()).toBe(0);
    // The old copy's fee was swept into the wallet once and paid once by this trip.
    const moved = await database.db.selectFrom("wallet_entries").select(["kind", "amount_minor"]).where("rider_id", "=", riderId).where((eb) => eb.or([eb("kind", "=", "fee").and("trip_id", "=", oldFeeTrip), eb("kind", "=", "debt_paid").and("trip_id", "=", tripId)])).orderBy("entry_id").execute();
    expect(moved).toEqual([{ kind: "fee", amount_minor: "-24000" }, { kind: "debt_paid", amount_minor: "24000" }]);
    expect((await database.db.selectFrom("rider_fees").select("status").where("trip_id", "=", oldFeeTrip).executeTakeFirstOrThrow()).status).toBe("paid");
  });

  it("changeover: a wallet debt bigger than the copied line is collected whole once (copied 240 kr, debt 305 kr)", async () => {
    const { tripId, version } = await accepted();
    await feeOwed(24_000);
    await feeOwed(6_500);
    const row = await database.db.selectFrom("trips").select(["fare_minor", "fare_lines"]).where("trip_id", "=", tripId).executeTakeFirstOrThrow();
    const base = Number(row.fare_minor);
    await database.db.updateTable("trips").set({ fare_minor: base + 24_000, fare_lines: JSON.stringify([...(row.fare_lines as object[]), { code: "outstanding_fee", amount: SEK(24_000) }]) }).where("trip_id", "=", tripId).execute();
    const done = await driveAndComplete(tripId, version);
    expect(done.json().fare).toEqual(SEK(base + 30_500));
    expect(await balance()).toBe(0);
  });

  it("changeover: migration 0103 moves owed fees into the wallet once; a second run (or the payment sweep) adds nothing", async () => {
    await feeOwed(4_000, { oldServerCopy: true });
    const file = readFileSync(new URL("../../migrations/0103_fees_into_wallet.sql", import.meta.url), "utf8");
    const { splitSql } = await import("../../src/db/splitSql.js");
    for (const statement of splitSql(file)) await sql.raw(statement).execute(database.db);
    expect(await balance()).toBe(-4_000);
    for (const statement of splitSql(file)) await sql.raw(statement).execute(database.db);
    const { sweepOwedFees } = await import("../../src/riders/debt.js");
    await database.db.transaction().execute((trx) => sweepOwedFees(trx, riderId));
    expect(await balance()).toBe(-4_000);
  });
});

/* ================================================================ the floor follows Max rider debt */

describe("J8 DB floor (debtModel.dbFloor, owner 15:00 'Any amount')", () => {
  const floor = async () => Number((await database.db.selectFrom("wallet_floors").select("floor_minor").where("currency", "=", "SEK").executeTakeFirstOrThrow()).floor_minor);

  it("fee headroom at the floor: max 20 kr, rider at −19 kr, a 65 kr no-show is still saved (floor never above −900 kr)", async () => {
    await countryRules({ maxRiderDebt: SEK(2_000) });
    const { followFloor, largestFee } = await import("../../src/riders/debtFloor.js");
    const largest = await database.db.transaction().execute((trx) => largestFee(trx, "SE", "SEK"));
    await database.db.transaction().execute((trx) => followFloor(trx, "SE", clock.now));
    // −3 × 20 kr is −60 kr, but the floor never rises: −900 kr, or lower when 20 kr + 4 × the largest fee needs it.
    expect(await floor()).toBe(Math.min(-90_000, -(2_000 + 4 * largest)));
    await feeOwed(1_900);
    await feeOwed(6_500);
    expect(await balance()).toBe(-8_400);
  });

  it("the admin raises Max rider debt to 2,000 kr: the floor follows down to −6,000 kr in the same save; lowering never raises it", async () => {
    const { followFloor } = await import("../../src/riders/debtFloor.js");
    await countryRules({ maxRiderDebt: SEK(200_000) });
    await database.db.transaction().execute((trx) => followFloor(trx, "SE", clock.now));
    expect(await floor()).toBe(-600_000);
    await countryRules({ maxRiderDebt: SEK(2_000) });
    await database.db.transaction().execute((trx) => followFloor(trx, "SE", clock.now));
    expect(await floor()).toBe(-600_000);
  });

  it("a balance below the floor is refused by the database (the old ≥ 0 rule is gone, a spend still never goes below 0)", async () => {
    await database.db.updateTable("wallet_floors").set({ floor_minor: -10_000 }).where("currency", "=", "SEK").execute();
    await feeOwed(9_000);
    await expect(feeOwed(2_000)).rejects.toThrow(/floor/);
    const { moveWallet } = await import("../../src/riders/wallet.js");
    await expect(database.db.transaction().execute((trx) => moveWallet(trx, riderId, "SEK", -1, clock.now))).rejects.toThrow(/wallet spend refused/);
    await database.db.updateTable("wallet_floors").set({ floor_minor: -90_000 }).where("currency", "=", "SEK").execute();
  });

  it("switching the owes-limit on without an amount is 400 owes_limit_needs_amount", async () => {
    const { checkDocument } = await import("../../src/config/service.js");
    const zone = { zoneId: "standard-SE", name: "Standard SE", country: "SE", currency: "SEK", timeZone: "Europe/Stockholm", kind: "standard", open: true, center: { lat: 0, lng: 0 } } as never;
    expect(() => checkDocument("country_rules", zone, { country: "SE", currency: "SEK", driverOwesLimit: { enabled: true, max: null } })).toThrow(expect.objectContaining({ options: expect.objectContaining({ reason: "owes_limit_needs_amount" }) }));
  });
});

/* ================================================================ supervisor round 1 must-fixes (2026-11-14) */

describe("J8 round 2: Driver paid Movera settles the carried rest first (must-fix 2, owner Q-M3 / Q-S5-7)", () => {
  async function carried(amount: number, id: string) {
    await database.db.insertInto("payouts").values({ payout_id: id, driver_id: drivers.A.id, zone_id: "Z001", currency: "SEK", amount_minor: -amount, lines: JSON.stringify([]), trip_count: 0, source: "weekly", period_start: new Date(clock.now.getTime() - 14 * 86_400_000), period_end: new Date(clock.now.getTime() - 7 * 86_400_000), note: null, created_by: null, created_at: clock.now }).execute();
  }
  async function nextPayoutLines() {
    const { makePayouts } = await import("../../src/admin/payouts.js");
    // This week's run: one ordinary trip-less bonus so a payout is made at all.
    await database.db.insertInto("earnings_entries").values({ entry_id: `ern_week_${clock.now.getTime()}`, driver_id: drivers.A.id, trip_id: null, kind: "bonus", currency: "SEK", amount_minor: 1_000, at: clock.now }).execute();
    const made = await database.db.transaction().execute((trx) => makePayouts(trx, { driverId: drivers.A.id, from: new Date(clock.now.getTime() - 86_400_000), to: new Date(clock.now.getTime() + 1000), source: "manual", by: null }, clock.now));
    return made.flatMap((p) => (p.lines as Array<{ code: string; amountMinor: number }>));
  }
  const url = () => `/admin/drivers/${drivers.A.id}/paid-movera`;

  it("P1 −100 kr pending, the driver pays 100 kr: P1 is paid, owed 0, and the next payout holds no +100 kr", async () => {
    await carried(10_000, "pyt_leak_full");
    const admin = await adminSession(app, database.db, "super", { now: clock.now });
    const paid = await call(app, "POST", url(), admin.headers, { expectedOwed: SEK(10_000), amount: SEK(10_000), reason: "Bank transfer" });
    expect(paid.statusCode, paid.body).toBe(200);
    expect(paid.json()).toMatchObject({ owed: SEK(0) });
    expect((await database.db.selectFrom("payouts").select(["status", "paid_by"]).where("payout_id", "=", "pyt_leak_full").executeTakeFirstOrThrow())).toEqual({ status: "paid", paid_by: admin.adminId });
    expect((await nextPayoutLines()).map((l) => l.code)).not.toContain("paid_to_movera");
  });

  it("a part payment of 60 kr on a −100 kr payout: owed 40 kr, P1 stays open, and the next payout still holds no +60 kr", async () => {
    await carried(10_000, "pyt_leak_part");
    const admin = await adminSession(app, database.db, "super", { now: clock.now });
    const paid = await call(app, "POST", url(), admin.headers, { expectedOwed: SEK(10_000), amount: SEK(6_000), reason: "Swish" });
    expect(paid.json()).toMatchObject({ owed: SEK(4_000) });
    expect((await database.db.selectFrom("payouts").select("status").where("payout_id", "=", "pyt_leak_part").executeTakeFirstOrThrow()).status).toBe("pending");
    expect((await nextPayoutLines()).map((l) => l.code)).not.toContain("paid_to_movera");
    const { owedByDriver } = await import("../../src/drivers/owes.js");
    expect((await owedByDriver(database.db, [drivers.A.id], "SEK")).get(drivers.A.id)).toBe(4_000);
  });
});

describe("J8 round 2: an old server copy settles a fee during the deploy (must-fix 3)", () => {
  it("a fee the old copy marked paid while its −fee sits in the wallet is lifted once, so it is never charged again", async () => {
    const feeTrip = await feeOwed(6_500);
    expect(await balance()).toBe(-6_500);
    // The old copy (no J8 code) collected the copied line and marked the row paid; the wallet was never told.
    await database.db.updateTable("rider_fees").set({ status: "paid", settled_at: clock.now }).where("trip_id", "=", feeTrip).execute();
    const { tripId, version } = await accepted();
    const done = await driveAndComplete(tripId, version);
    expect(done.json().fareLines.map((l: { code: string }) => l.code)).not.toContain("outstanding_fee");
    expect(await balance()).toBe(0);
    const lifted = await database.db.selectFrom("wallet_entries").select(["kind", "amount_minor"]).where("trip_id", "=", feeTrip).orderBy("entry_id").execute();
    expect(lifted).toEqual([{ kind: "fee", amount_minor: "-6500" }, { kind: "adjustment", amount_minor: "6500" }]);
    const { sweepOwedFees } = await import("../../src/riders/debt.js");
    await database.db.transaction().execute((trx) => sweepOwedFees(trx, riderId, "SEK"));
    expect(await balance()).toBe(0);
  });
});

describe("J8 round 2: the floor counts the driver document's no-show fees, through the admin publish (must-fix 4)", () => {
  it("publishing a driver document with a 2,000 kr airport no-show fee moves the SEK floor to −(300 + 4 × 2,000) kr", async () => {
    await database.db.updateTable("wallet_floors").set({ floor_minor: -90_000 }).where("currency", "=", "SEK").execute();
    // The zone's driver document as live today (the sample), then the admin's draft and publish through the routes.
    await database.db.deleteFrom("config_live").where("doc", "=", "driver_app_config").where("zone_id", "=", "Z001").execute();
    await database.db.insertInto("config_live").values({ doc: "driver_app_config", zone_id: "Z001", version: 1, document: JSON.stringify(sample("driver_app_config")), published_at: clock.now, published_by: null }).execute();
    const admin = await adminSession(app, database.db, "super", { now: clock.now });
    const draft = (await call(app, "GET", "/admin/config/driver_app_config?zoneId=Z001", admin.headers)).json();
    expect(draft.version, JSON.stringify(draft)).toBe(1);
    const doc = sample("driver_app_config");
    doc.waiting.rideTypes.airport.noShowFee = SEK(200_000);
    const put = await call(app, "PUT", "/admin/config/driver_app_config", admin.headers, { expectedVersion: draft.version, zoneId: "Z001", document: doc });
    expect(put.statusCode, put.body).toBe(200);
    const pub = await call(app, "POST", "/admin/config/driver_app_config/publish", admin.headers, { expectedVersion: put.json().version, zoneId: "Z001" });
    expect(pub.statusCode, pub.body).toBe(200);
    const floor = Number((await database.db.selectFrom("wallet_floors").select("floor_minor").where("currency", "=", "SEK").executeTakeFirstOrThrow()).floor_minor);
    expect(floor).toBe(-(30_000 + 4 * 200_000));
  });
});

describe("J8 round 2: fee rows follow the wallet, oldest first; the admin list reads the wallet (must-fix 5)", () => {
  it("50 kr credit and a 30 kr fee: the fee row is paid at once and the admin list shows no debt", async () => {
    const { creditWallet } = await import("../../src/riders/wallet.js");
    await database.db.transaction().execute((trx) => creditWallet(trx, riderId, SEK(5_000), null, clock.now, "adjustment"));
    const feeTrip = await feeOwed(3_000);
    expect(await balance()).toBe(2_000);
    expect((await database.db.selectFrom("rider_fees").select("status").where("trip_id", "=", feeTrip).executeTakeFirstOrThrow()).status).toBe("paid");
    const admin = await adminSession(app, database.db, "super", { now: clock.now });
    const listed = (await call(app, "GET", `/admin/riders?q=${riderId}`, admin.headers)).json().items[0];
    expect(listed.outstandingByCurrency ?? []).toEqual([]);
  });

  it("money into the wallet settles the OLDEST fee row first; the debt line names the next one", async () => {
    const older = await feeOwed(3_000);
    clock.now = new Date(clock.now.getTime() + 1000);
    const newer = await feeOwed(4_000);
    const { creditWallet } = await import("../../src/riders/wallet.js");
    await database.db.transaction().execute((trx) => creditWallet(trx, riderId, SEK(3_000), null, clock.now, "adjustment"));
    const rows = await database.db.selectFrom("rider_fees").select(["trip_id", "status"]).where("trip_id", "in", [older, newer]).orderBy("created_at").execute();
    expect(rows).toEqual([{ trip_id: older, status: "paid" }, { trip_id: newer, status: "owed" }]);
    const admin = await adminSession(app, database.db, "super", { now: clock.now });
    expect((await call(app, "GET", `/admin/riders?q=${riderId}`, admin.headers)).json().items[0].outstandingByCurrency).toEqual([SEK(4_000)]);
    const { tripId, version } = await accepted();
    const done = await driveAndComplete(tripId, version);
    expect(done.json().fareLines).toEqual(expect.arrayContaining([{ code: "outstanding_fee", amount: SEK(4_000), sourceTripId: newer }]));
  });
});

describe("J8 round 2: Tunisia in TND, 3 decimals (must-fix 6)", () => {
  const TND = (amountMinor: number) => ({ amountMinor, currency: "TND" });

  it("limit 150.000 DT on and owed 150.000 DT: no cash offers, the Home line in TND; max rider debt 84.000 DT; floor −252.000 DT", async () => {
    await database.db.insertInto("config_live").values({ doc: "country_rules", zone_id: "standard-TN", version: 1, document: JSON.stringify({ country: "TN", currency: "TND", driverOwesLimit: { enabled: true, max: TND(150_000) } }), published_at: clock.now, published_by: null }).execute();
    await database.db.updateTable("drivers").set({ country: "TN" }).where("driver_id", "=", drivers.A.id).execute();
    try {
      await database.db.insertInto("earnings_entries").values({ entry_id: "ern_tn_owed", driver_id: drivers.A.id, trip_id: null, kind: "adjustment", currency: "TND", amount_minor: -150_000, at: clock.now }).execute();
      const { overOwesLimit, owesLimitOf } = await import("../../src/drivers/owes.js");
      expect(await owesLimitOf(database.db, "TN")).toEqual({ enabled: true, max: TND(150_000) });
      expect([...(await overOwesLimit(database.db, { zone_id: "TN-TC", payment_method: "cash" }, [drivers.A.id, drivers.B.id]))]).toEqual([[drivers.A.id, 150_000]]);
      expect((await overOwesLimit(database.db, { zone_id: "TN-TC", payment_method: "card" }, [drivers.A.id])).size).toBe(0);
      const lines = (await call(app, "GET", "/driver/reminders", { ...drivers.A.headers, ...NEW_APP })).json();
      expect(lines.items).toEqual(expect.arrayContaining([{ kind: "owes_movera_over_limit", level: "due_soon", owed: TND(150_000), limit: TND(150_000) }]));
    } finally {
      await database.db.updateTable("drivers").set({ country: "SE" }).where("driver_id", "=", drivers.A.id).execute();
    }
    const { maxRiderDebtOf } = await import("../../src/riders/debt.js");
    expect(await maxRiderDebtOf(database.db, "TN", "TND")).toEqual(TND(84_000));
    expect(Number((await database.db.selectFrom("wallet_floors").select("floor_minor").where("currency", "=", "TND").executeTakeFirstOrThrow()).floor_minor)).toBe(-252_000);
    // A TND debt of exactly 84.000 DT is saved (above the floor) and refuses a pay-in-car booking in Tunisia.
    const tnFee = await insertTrip(database.db, riderId, { status: "no_show" });
    await database.db.updateTable("trips").set({ zone_id: "TN-TC", currency: "TND" }).where("trip_id", "=", tnFee).execute();
    const { chargeRiderFee } = await import("../../src/trips/ride/money.js");
    const row = await database.db.selectFrom("trips").selectAll().where("trip_id", "=", tnFee).executeTakeFirstOrThrow();
    await database.db.transaction().execute((trx) => chargeRiderFee(trx, row, "no_show", TND(84_000), clock.now));
    const pricing = sample("pricing_document");
    const tnd = JSON.parse(JSON.stringify(pricing).replaceAll('"SEK"', '"TND"'));
    await database.db.insertInto("config_live").values({ doc: "pricing", zone_id: "TN-TC", version: 1, document: JSON.stringify({ ...tnd, zoneId: "TN-TC" }), published_at: clock.now, published_by: null }).execute();
    await database.db.updateTable("zones").set({ open: true }).where("zone_id", "=", "TN-TC").execute();
    const TUNIS = { address: "Avenue Habib Bourguiba", lat: 36.8, lng: 10.18 };
    const TUNIS_DROP = { address: "La Marsa", lat: 36.88, lng: 10.32 };
    const quote = (await call(app, "POST", "/quotes", { ...rider, ...NEW_APP }, { pickup: TUNIS, dropoff: TUNIS_DROP, stops: [], categoryIds: ["economy"] })).json();
    expect(quote.zoneId, JSON.stringify(quote)).toBe("TN-TC");
    expect(quote.quotes[0].walletDebt).toEqual(TND(84_000));
    const refused = await call(app, "POST", "/trips", rider, { quoteId: quote.quotes[0].quoteId, categoryId: "economy", pickup: TUNIS, dropoff: TUNIS_DROP, stops: [], kind: "live", paymentMethod: "cash" });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ reason: "rider_debt_above_max", details: ["debt:84000 TND", "max:84000 TND"] });
  });
});

/* ================================================================ refund "take from driver" leaves the debt out (J8 money fix 3) */

describe("J8: a refund taken from the driver leaves the rider's old debt out on every paid end, not only complete", () => {
  /** Rider on board of an accepted trip; returns the version to end it with. */
  async function onBoard(tripId: string, version: number) {
    let v = version;
    for (const path of ["head-to-pickup", "arrive", "board", "start"]) expect((await step(tripId, path, v++)).statusCode).toBe(200);
    return v;
  }
  /** The admin refunds the ride part (fare − debt) taken from the driver; returns the driver's adjustment and the row. */
  async function refundRidePart(tripId: string) {
    const row = await database.db.selectFrom("trips").selectAll().where("trip_id", "=", tripId).executeTakeFirstOrThrow();
    const debt = ((row.fare_lines as Array<{ code: string; amount: { amountMinor: number } }>) ?? []).filter((l) => l.code === "outstanding_fee").reduce((s, l) => s + l.amount.amountMinor, 0);
    const admin = await adminSession(app, database.db, "super", { now: clock.now });
    const ride = Number(row.fare_minor) - debt;
    const res = await call(app, "POST", `/admin/trips/${tripId}/refund`, admin.headers, { expectedVersion: row.version, amount: { amountMinor: ride, currency: row.currency }, reason: "Ride refunded", fromDriver: true });
    expect(res.statusCode, res.body).toBe(201);
    const adjustment = await database.db.selectFrom("earnings_entries").select("amount_minor").where("trip_id", "=", tripId).where("kind", "=", "adjustment").where("amount_minor", "<", "0").executeTakeFirst();
    return { row, debt, ride, taken: -Number(adjustment?.amount_minor ?? 0) };
  }

  it("SEK rider early end: the trip collected a 65 kr debt; refunding the whole ride part takes his whole earnings, never a share of the debt", async () => {
    await feeOwed(6_500);
    const { tripId, version } = await accepted();
    const v = await onBoard(tripId, version);
    const ended = await call(app, "POST", `/trips/${tripId}/end-early`, rider, { expectedVersion: v, reasonCode: "plans_changed" });
    expect(ended.statusCode, ended.body).toBe(200);
    const { row, debt, ride, taken } = await refundRidePart(tripId);
    expect(row.status).toBe("cancelled_by_rider");
    expect(debt).toBe(6_500);
    // Fail-before: round(ride × earnings ÷ (ride + 65 kr)), the debt counted as ride money.
    expect(taken, `ride ${ride} earnings ${row.driver_earnings_minor}`).toBe(Number(row.driver_earnings_minor));
  });

  it("SEK driver cancel with the rider on board: the same, the 65 kr debt is not ride money", async () => {
    await feeOwed(6_500);
    const { tripId, version } = await accepted();
    const v = await onBoard(tripId, version);
    const ended = await step(tripId, "cancel", v, { reasonCode: "rider_behavior" });
    expect(ended.statusCode, ended.body).toBe(200);
    const { row, debt, taken } = await refundRidePart(tripId);
    expect(row.status).toBe("cancelled_by_driver");
    expect(debt).toBe(6_500);
    expect(taken).toBe(Number(row.driver_earnings_minor));
  });

  it("TND (3 decimals) rider early end: 30.000 DT = 20.000 DT ride + 10.000 DT debt, he earned 16.000 DT; a 10.000 DT refund takes 8.000 DT", async () => {
    const tripId = await insertTrip(database.db, riderId, { status: "cancelled_by_rider", driverId: drivers.A.id });
    const TND = (amountMinor: number) => ({ amountMinor, currency: "TND" });
    await database.db.updateTable("trips").set({
      zone_id: "TN-TC", currency: "TND", fare_minor: 30_000, booked_fare_minor: 20_000, driver_earnings_minor: 16_000, commission_minor: 4_000, pickup_pay_minor: 0, driver_bonus_minor: 0, driver_adjustments_minor: 0,
      fare_lines: JSON.stringify([{ code: "base", amount: TND(20_000) }, { code: "outstanding_fee", amount: TND(10_000) }]),
      ended_by_command: "end_early", ended_at: clock.now, payment_method: "cash", payment_status: "captured", cash_collected_minor: 30_000, wallet_applied_minor: 0,
    }).where("trip_id", "=", tripId).execute();
    const row = await database.db.selectFrom("trips").selectAll().where("trip_id", "=", tripId).executeTakeFirstOrThrow();
    const admin = await adminSession(app, database.db, "super", { now: clock.now });
    const res = await call(app, "POST", `/admin/trips/${tripId}/refund`, admin.headers, { expectedVersion: row.version, amount: TND(10_000), reason: "Ride refunded", fromDriver: true });
    expect(res.statusCode, res.body).toBe(201);
    const adjustment = await database.db.selectFrom("earnings_entries").select(["amount_minor", "currency"]).where("trip_id", "=", tripId).where("kind", "=", "adjustment").executeTakeFirstOrThrow();
    // 10.000 × 16.000 ÷ 20.000 = 8.000 DT. Fail-before: 10.000 × 16.000 ÷ 30.000 = 5.333 DT.
    expect(adjustment).toEqual({ amount_minor: "-8000", currency: "TND" });
  });
});

/* ================================================================ receipt debtIncluded on every paid end (supervisor SF1) */

describe("J8 SF1: the receipt shows debtIncluded on every paid end with the rider on board, not only complete", () => {
  async function onBoard(tripId: string, version: number) {
    let v = version;
    for (const path of ["head-to-pickup", "arrive", "board", "start"]) expect((await step(tripId, path, v++)).statusCode).toBe(200);
    return v;
  }
  async function receipts(tripId: string) {
    const admin = await adminSession(app, database.db, "super", { now: clock.now });
    const out = { rider: await call(app, "GET", `/trips/${tripId}/receipt`, rider), driver: await call(app, "GET", `/driver/trips/${tripId}/receipt`, drivers.A.headers), admin: await call(app, "GET", `/admin/trips/${tripId}/receipt`, admin.headers) };
    for (const r of Object.values(out)) expect(r.statusCode, r.body).toBe(200);
    return { rider: out.rider.json(), driver: out.driver.json(), admin: out.admin.json() };
  }

  it("SEK rider early end: the trip collected a 65 kr debt; the receipt names it as its own line, the total is unchanged", async () => {
    await feeOwed(6_500);
    const { tripId, version } = await accepted();
    const v = await onBoard(tripId, version);
    expect((await call(app, "POST", `/trips/${tripId}/end-early`, rider, { expectedVersion: v, reasonCode: "plans_changed" })).statusCode).toBe(200);
    const row = await database.db.selectFrom("trips").select(["status", "fare_minor"]).where("trip_id", "=", tripId).executeTakeFirstOrThrow();
    expect(row.status).toBe("cancelled_by_rider");
    const r = await receipts(tripId);
    // Fail-before: no debtIncluded (only on status completed).
    for (const one of [r.rider, r.driver, r.admin]) {
      expect(one.debtIncluded).toEqual(SEK(6_500));
      expect(one.total).toEqual(SEK(Number(row.fare_minor)));
      expect(one.fareLines.find((l: { code: string }) => l.code === "outstanding_fee")?.amount).toEqual(SEK(6_500));
    }
  });

  it("SEK driver cancel with the rider on board: the same 65 kr debtIncluded line", async () => {
    await feeOwed(6_500);
    const { tripId, version } = await accepted();
    const v = await onBoard(tripId, version);
    expect((await step(tripId, "cancel", v, { reasonCode: "rider_behavior" })).statusCode).toBe(200);
    const row = await database.db.selectFrom("trips").select(["status", "fare_minor"]).where("trip_id", "=", tripId).executeTakeFirstOrThrow();
    expect(row.status).toBe("cancelled_by_driver");
    const r = await receipts(tripId);
    expect(r.rider.debtIncluded).toEqual(SEK(6_500));
    expect(r.admin.debtIncluded).toEqual(SEK(6_500));
    expect(r.rider.total).toEqual(SEK(Number(row.fare_minor)));
  });

  it("TND (3 decimals) rider early end: 30.000 DT = 20.000 DT ride + 10.000 DT debt; the receipt shows debtIncluded 10.000 DT, total 30.000 DT", async () => {
    const tripId = await insertTrip(database.db, riderId, { status: "cancelled_by_rider", driverId: drivers.A.id });
    const TND = (amountMinor: number) => ({ amountMinor, currency: "TND" });
    await database.db.updateTable("trips").set({
      zone_id: "TN-TC", currency: "TND", fare_minor: 30_000, booked_fare_minor: 20_000, driver_earnings_minor: 16_000, commission_minor: 4_000, pickup_pay_minor: 0, driver_bonus_minor: 0, driver_adjustments_minor: 0,
      fare_lines: JSON.stringify([{ code: "base", amount: TND(20_000) }, { code: "outstanding_fee", amount: TND(10_000) }]),
      ended_by_command: "end_early", ended_at: clock.now, payment_method: "cash", payment_status: "captured", cash_collected_minor: 30_000, wallet_applied_minor: 0,
    }).where("trip_id", "=", tripId).execute();
    const r = await receipts(tripId);
    for (const one of [r.rider, r.driver, r.admin]) {
      expect(one.debtIncluded).toEqual(TND(10_000));
      expect(one.total).toEqual(TND(30_000));
      expect(one.cashPaid).toEqual(TND(30_000));
    }
  });

  it("an end that reads no debt keeps no debtIncluded: an admin cancel with a cancel fee", async () => {
    const tripId = await insertTrip(database.db, riderId, { status: "cancelled_by_admin", driverId: drivers.A.id });
    await database.db.updateTable("trips").set({
      fare_minor: 6_500, fare_lines: JSON.stringify([{ code: "cancel_fee", amount: SEK(6_500) }]), ended_by_command: "cancel", ended_at: clock.now, payment_method: "cash", payment_status: "captured", cash_collected_minor: 6_500, wallet_applied_minor: 0,
    }).where("trip_id", "=", tripId).execute();
    const r = await receipts(tripId);
    expect(r.rider).not.toHaveProperty("debtIncluded");
  });
});
