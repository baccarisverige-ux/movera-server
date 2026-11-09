import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import type { TripRow } from "../../src/db/tripLog.js";
import { creditWallet, getWallet } from "../../src/riders/wallet.js";
import { spendWallet, walletCovers } from "../../src/trips/ride/money.js";
import { adminRiderView, riderWallets } from "../../src/admin/lists.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { call, signIn, testWorld } from "../support/world.js";

/** Fix job 6 (ledger L11/R11, owner Q4 2026-11-04): the rider's wallet keeps one balance per currency, never mixed. */

let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-11-04T10:00:00Z") };
let rider: Record<string, string>;
let riderId: string;

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
});
afterAll(async () => {
  await app.close();
  await database.drop();
});
beforeEach(async () => {
  rider = (await signIn(app, TEST_PHONES[0]!, "rider")).headers;
  riderId = (await database.db.selectFrom("riders").select("rider_id").where("phone", "=", TEST_PHONES[0]!).executeTakeFirstOrThrow()).rider_id;
  await database.db.deleteFrom("rider_wallets").execute();
  await database.db.updateTable("riders").set({ last_seen_zone_id: null }).execute();
});

const credit = (amountMinor: number, currency: string) => database.db.transaction().execute((trx) => creditWallet(trx, riderId, { amountMinor, currency }, null, clock.now));
const trip = (currency: string, applied: number) => ({ trip_id: null, rider_id: riderId, currency, wallet_applied_minor: String(applied) }) as unknown as TripRow;

describe("wallet per currency", () => {
  it("a EUR refund and a SEK refund are two balances, not one sum", async () => {
    await credit(6500, "EUR");
    await credit(3000, "SEK");
    const wallet = (await call(app, "GET", "/wallet", rider)).json();
    expect(wallet.balances).toEqual([{ amountMinor: 6500, currency: "EUR" }, { amountMinor: 3000, currency: "SEK" }]);
    expect((await call(app, "GET", "/wallet?currency=EUR", rider)).json().balance).toEqual({ amountMinor: 6500, currency: "EUR" });
    expect((await call(app, "GET", "/wallet?currency=SEK", rider)).json().balance).toEqual({ amountMinor: 3000, currency: "SEK" });
    expect((await call(app, "GET", "/wallet?currency=eur", rider)).statusCode).toBe(400);
  });

  it("without ?currency the balance is in the currency of the rider's zone (France → EUR)", async () => {
    await credit(6500, "EUR");
    const paris = await database.db.selectFrom("zones").select("zone_id").where("country", "=", "FR").executeTakeFirstOrThrow();
    await database.db.updateTable("riders").set({ last_seen_zone_id: paris.zone_id }).where("rider_id", "=", riderId).execute();
    expect((await getWallet(database.db, riderId, "SEK")).balance).toEqual({ amountMinor: 6500, currency: "EUR" });
  });

  it("only the balance in the trip's currency pays it", async () => {
    await credit(5000, "EUR");
    expect(await walletCovers(database.db, riderId, "SEK", 8000)).toBe(0);
    expect(await walletCovers(database.db, riderId, "EUR", 8000)).toBe(5000);
    expect(await database.db.transaction().execute((trx) => spendWallet(trx, trip("SEK", 5000), 8000, clock.now))).toBe(0);
    expect(await database.db.transaction().execute((trx) => spendWallet(trx, trip("EUR", 5000), 8000, clock.now))).toBe(5000);
    const wallet = await getWallet(database.db, riderId, "SEK", "EUR");
    expect(wallet.balance.amountMinor).toBe(0);
    const charge = await database.db.selectFrom("wallet_entries").select(["kind", "currency", "amount_minor"]).where("rider_id", "=", riderId).where("kind", "=", "charge").execute();
    expect(charge).toEqual([{ kind: "charge", currency: "EUR", amount_minor: "-5000" }]);
  });

  it("the admin sees every balance per currency (wallets) and wallet in the rider's zone currency", async () => {
    await credit(6500, "EUR");
    await credit(1200, "SEK");
    const row = await database.db.selectFrom("riders").selectAll().where("rider_id", "=", riderId).executeTakeFirstOrThrow();
    const view = adminRiderView(row, "SEK", [], (await riderWallets(database.db, [riderId])).get(riderId), { perms: ["riders.viewSensitive"] });
    expect(view.wallets).toEqual([{ amountMinor: 6500, currency: "EUR" }, { amountMinor: 1200, currency: "SEK" }]);
    expect(view.wallet).toEqual({ amountMinor: 6500, currency: "EUR" });
  });

  it("old rows are untouched: riders.wallet_minor is no longer written", async () => {
    await database.db.updateTable("riders").set({ wallet_minor: 777 }).where("rider_id", "=", riderId).execute();
    await credit(100, "EUR");
    expect((await database.db.selectFrom("riders").select("wallet_minor").where("rider_id", "=", riderId).executeTakeFirstOrThrow()).wallet_minor).toBe("777");
  });
});
