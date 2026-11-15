import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminRiderView, riderWallets } from "../../src/admin/lists.js";
import { creditWallet } from "../../src/riders/wallet.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver, insertRider, insertTrip } from "../support/seed.js";
import { call, testWorld } from "../support/world.js";

/**
 * BQ-A30c (audits/impact/admin-a30b-supervisor.md SF2; owner G12 Q5 "in the rider's currency"; contract.json
 * walletCurrency "never converted"): the admin rider view (GET /admin/riders) shows `wallet` in the same currency the
 * wallet credit (POST /admin/riders/{id}/wallet-credit) takes: the zone of his latest trip first, then his last seen
 * zone. Fail-before: the view followed only last_seen_zone_id, so a rider whose latest trip is in Tunis but who was last
 * seen in Sweden was shown "0,00 kr" while every credit in kr got 400 "This rider pays in TND.".
 * Sweden (SEK, Z001) and Tunisia (TND, TN-TC).
 */

let database: TestDatabase;
let app: FastifyInstance;
let finance: Record<string, string>;
const clock = { now: new Date("2026-11-14T10:00:00Z") };

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  finance = (await adminSession(app, database.db, "super", { now: clock.now })).headers;
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

/** An ended trip of the rider in `zone`, created at `at`. */
async function tripIn(riderId: string, zone: string, currency: string, at: Date) {
  const tripId = await insertTrip(database.db, riderId, { status: "completed", driverId: await insertDriver(database.db) });
  await database.db.updateTable("trips").set({ zone_id: zone, currency, created_at: at, ended_at: at }).where("trip_id", "=", tripId).execute();
}
const seenIn = (riderId: string, zone: string | null) => database.db.updateTable("riders").set({ last_seen_zone_id: zone }).where("rider_id", "=", riderId).execute();
const version = async (riderId: string) => (await database.db.selectFrom("riders").select("version").where("rider_id", "=", riderId).executeTakeFirstOrThrow()).version;
/** What the admin rider page reads: the rider's row of GET /admin/riders?q={riderId}. */
async function adminView(riderId: string) {
  const res = await call(app, "GET", `/admin/riders?q=${riderId}`, finance);
  expect(res.statusCode, res.body).toBe(200);
  const item = res.json().items.find((r: { riderId: string }) => r.riderId === riderId);
  expect(item).toBeDefined();
  return item as { wallet: { amountMinor: number; currency: string }; wallets: Array<{ amountMinor: number; currency: string }> };
}
const credit = async (riderId: string, amountMinor: number, currency: string) =>
  call(app, "POST", `/admin/riders/${riderId}/wallet-credit`, finance, { expectedVersion: await version(riderId), amount: { amountMinor, currency }, reason: "Long wait" });

describe("BQ-A30c: the admin rider view shows the wallet in the credit's currency (latest trip, then last seen zone)", () => {
  it("TN: latest trip in Tunis, last seen in Sweden → TND; a credit in the shown currency goes through", async () => {
    const riderId = await insertRider(database.db);
    await tripIn(riderId, "Z001", "SEK", new Date("2026-11-01T10:00:00Z"));
    await tripIn(riderId, "TN-TC", "TND", new Date("2026-11-10T10:00:00Z"));
    await seenIn(riderId, "Z001");
    expect((await adminView(riderId)).wallet).toEqual({ amountMinor: 0, currency: "TND" });
    const shown = (await adminView(riderId)).wallet.currency;
    const done = await credit(riderId, 5_000, shown);
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().wallet).toEqual({ amountMinor: 5_000, currency: "TND" });
    expect((await adminView(riderId)).wallet).toEqual({ amountMinor: 5_000, currency: "TND" });
  });

  it("SE: latest trip in Sweden, last seen in Tunis → SEK; a credit in the shown currency goes through", async () => {
    const riderId = await insertRider(database.db);
    await tripIn(riderId, "TN-TC", "TND", new Date("2026-11-01T10:00:00Z"));
    await tripIn(riderId, "Z001", "SEK", new Date("2026-11-10T10:00:00Z"));
    await seenIn(riderId, "TN-TC");
    expect((await adminView(riderId)).wallet).toEqual({ amountMinor: 0, currency: "SEK" });
    const done = await credit(riderId, 5_000, (await adminView(riderId)).wallet.currency);
    expect(done.statusCode, done.body).toBe(200);
    expect((await adminView(riderId)).wallet).toEqual({ amountMinor: 5_000, currency: "SEK" });
  });

  it("TN: no trips, last seen in Tunis → TND (credit in TND accepted)", async () => {
    const riderId = await insertRider(database.db);
    await seenIn(riderId, "TN-TC");
    expect((await adminView(riderId)).wallet).toEqual({ amountMinor: 0, currency: "TND" });
    expect((await credit(riderId, 5_000, "TND")).statusCode).toBe(200);
  });

  it("SE: no trips, last seen in Sweden → SEK (credit in SEK accepted)", async () => {
    const riderId = await insertRider(database.db);
    await seenIn(riderId, "Z001");
    expect((await adminView(riderId)).wallet).toEqual({ amountMinor: 0, currency: "SEK" });
    expect((await credit(riderId, 5_000, "SEK")).statusCode).toBe(200);
  });

  it("no trips and no zone → today's fallback: the first balance he holds, else the server currency (SEK)", async () => {
    const riderId = await insertRider(database.db);
    await seenIn(riderId, null);
    expect((await adminView(riderId)).wallet).toEqual({ amountMinor: 0, currency: "SEK" });
    await database.db.transaction().execute((trx) => creditWallet(trx, riderId, { amountMinor: 7_500, currency: "TND" }, null, clock.now));
    expect((await adminView(riderId)).wallet).toEqual({ amountMinor: 7_500, currency: "TND" });
    // The credit still refuses (unchanged): no country is known yet.
    expect((await credit(riderId, 1_000, "TND")).json()).toMatchObject({ reason: "rider_country_unknown" });
  });

  it("a page of riders: each rider gets his own currency (one batched read, same order)", async () => {
    const a = await insertRider(database.db);
    const b = await insertRider(database.db);
    const c = await insertRider(database.db);
    await tripIn(a, "TN-TC", "TND", new Date("2026-11-10T10:00:00Z"));
    await seenIn(a, "Z001");
    await seenIn(b, "Z001");
    await seenIn(c, null);
    const wallets = await riderWallets(database.db, [a, b, c]);
    const view = async (id: string) => adminRiderView(await database.db.selectFrom("riders").selectAll().where("rider_id", "=", id).executeTakeFirstOrThrow(), "SEK", [], wallets.get(id), { perms: [] }).wallet.currency;
    expect([await view(a), await view(b), await view(c)]).toEqual(["TND", "SEK", "SEK"]);
  });
});
