import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { TEST_CODE } from "../../src/auth/service.js";
import { ACCOUNT_ERASE, eraseDueAccounts } from "../../src/accounts/deletion.js";
import { HOUSEKEEPING_KINDS } from "../../src/jobs/housekeeping.js";
import { RECURRING_JOBS } from "../../src/jobs/heartbeat.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { adminSession } from "../support/admin.js";
import { insertTrip } from "../support/seed.js";
import { call, signIn, testWorld } from "../support/world.js";

/**
 * contract v0.18.140 (account deletion E1; owner button 2026-11-20 "Accept, keep debt (Rec.)"): the request closes the
 * account at once, a debt never blocks it and is kept as a record (name, number, amount), everything else is erased
 * 30 days after the request by account_erase (count only while CountryRules.accountDeletion.eraseEnabled is off).
 */

let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-11-20T10:00:00Z") };
const DAY = 86_400_000;
const SARA = TEST_PHONES[3]!;
const OPEN = TEST_PHONES[4]!;
const ALI = TEST_PHONES[5]!;

async function riderId(phone: string) {
  return (await database.db.selectFrom("riders").select("rider_id").where("phone", "=", phone).executeTakeFirstOrThrow()).rider_id;
}
async function eraseOn(on: boolean) {
  await database.db.deleteFrom("config_live").where("doc", "=", "country_rules").where("zone_id", "=", "standard-SE").execute();
  await database.db.insertInto("config_live").values({ doc: "country_rules", zone_id: "standard-SE", version: 3, document: JSON.stringify({ country: "SE", accountDeletion: { eraseEnabled: on, eraseAfterDays: 30 } }), published_at: clock.now, published_by: null }).execute();
}

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

describe("account deletion (v0.18.140)", () => {
  let sara: string;
  let saraHeaders: Record<string, string>;

  it("Sara owes 65 kr: the request is accepted, the account closes at once and the debt is kept", async () => {
    saraHeaders = (await signIn(app, SARA, "rider")).headers;
    sara = await riderId(SARA);
    await database.db.updateTable("riders").set({ first_name: "Sara", outstanding_minor: 6500, outstanding_currency: "SEK" }).where("rider_id", "=", sara).execute();
    await sql`INSERT INTO rider_places (place_id, rider_id, kind, label, address, lat, lng, created_at, updated_at) VALUES ('plc_sara1', ${sara}, 'home', 'Home', 'Storgatan 12', 59.31, 18.07, now(), now())`.execute(database.db);
    const res = await call(app, "POST", "/account/deletion", saraHeaders);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: "requested", requestedAt: clock.now.toISOString(), eraseDueAt: new Date(clock.now.getTime() + 30 * DAY).toISOString() });
    const debt = await database.db.selectFrom("kept_debts").selectAll().where("account_id", "=", sara).execute();
    expect(debt.map((d) => [d.account_kind, d.first_name, d.phone, Number(d.amount_minor), d.currency, d.settled_at])).toEqual([["rider", "Sara", SARA, 6500, "SEK", null]]);
    // Closed at once: the session ended, sign-in again is refused.
    expect((await call(app, "GET", "/rider/profile", saraHeaders)).statusCode).toBe(401);
    const challenge = await app.inject({ method: "POST", url: "/api/v1/auth/otp/request", payload: { phone: SARA, app: "rider" } });
    const verify = await app.inject({ method: "POST", url: "/api/v1/auth/otp/verify", payload: { phone: SARA, sessionId: challenge.json().sessionId, code: TEST_CODE } });
    expect(verify.statusCode).toBe(403);
    expect(verify.json().reason).toBe("account_closed");
  });

  it("a request during an open trip is refused with deletion_open_trip", async () => {
    const h = (await signIn(app, OPEN, "rider")).headers;
    const id = await riderId(OPEN);
    const trip = await insertTrip(database.db, id, { status: "searching" });
    const res = await call(app, "POST", "/account/deletion", h);
    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe("deletion_open_trip");
    await database.db.updateTable("trips").set({ status: "cancelled_by_rider" }).where("trip_id", "=", trip).execute();
  });

  it("a driver asks: 202, set offline, sessions end", async () => {
    const h = (await signIn(app, ALI, "driver")).headers;
    const ali = (await database.db.selectFrom("drivers").select("driver_id").where("phone", "=", ALI).executeTakeFirstOrThrow()).driver_id;
    await database.db.updateTable("drivers").set({ online_status: "online", first_name: "Ali", last_name: "Larsson" }).where("driver_id", "=", ali).execute();
    const res = await call(app, "POST", "/driver/account/deletion", h);
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe("requested");
    const row = await database.db.selectFrom("drivers").select(["online_status", "deletion_requested_at"]).where("driver_id", "=", ali).executeTakeFirstOrThrow();
    expect(row.online_status).toBe("offline");
    expect(row.deletion_requested_at?.toISOString()).toBe(clock.now.toISOString());
    expect((await call(app, "GET", "/driver/profile", h)).statusCode).toBe(401);
  });

  it("the erase job: counts only while off, erases once when on, keeps trips and the debt, runs twice the same", async () => {
    const trip = await insertTrip(database.db, sara, { status: "completed" });
    clock.now = new Date(clock.now.getTime() + 31 * DAY);
    expect(await eraseDueAccounts(database.db, clock.now)).toEqual({ due: 2, erased: 0 });
    expect((await database.db.selectFrom("riders").select("erased_at").where("rider_id", "=", sara).executeTakeFirstOrThrow()).erased_at).toBeNull();
    await eraseOn(true);
    expect(await eraseDueAccounts(database.db, clock.now)).toEqual({ due: 2, erased: 2 });
    const r = await database.db.selectFrom("riders").selectAll().where("rider_id", "=", sara).executeTakeFirstOrThrow();
    expect(r.erased_at?.toISOString()).toBe(clock.now.toISOString());
    expect(r.phone).not.toBe(SARA);
    expect((await sql<{ n: number }>`SELECT count(*)::int AS n FROM rider_places WHERE rider_id = ${sara}`.execute(database.db)).rows[0]!.n).toBe(0);
    expect([r.first_name, r.email, r.language]).toEqual(["", null, null]);
    expect((await database.db.selectFrom("trips").select("fare_minor").where("trip_id", "=", trip).executeTakeFirstOrThrow()).fare_minor).toBeTruthy();
    expect((await database.db.selectFrom("kept_debts").select("phone").where("account_id", "=", sara).execute()).length).toBe(1);
    const d = await database.db.selectFrom("drivers").select(["first_name", "last_name", "erased_at", "phone"]).where("phone", "like", "erased-%").executeTakeFirstOrThrow();
    // Privacy Q2 open: the driver's name stays for his money records.
    expect([d.first_name, d.last_name]).toEqual(["Ali", "Larsson"]);
    expect(await eraseDueAccounts(database.db, clock.now)).toEqual({ due: 0, erased: 0 });
    expect(await database.db.transaction().execute((trx) => eraseDueAccounts(trx, clock.now))).toEqual({ due: 0, erased: 0 });
    // The number is free again: a new account.
    const again = await signIn(app, SARA, "rider");
    expect((await call(app, "GET", "/rider/profile", again.headers)).statusCode).toBe(200);
    expect(await riderId(SARA)).not.toBe(sara);
  });

  it("the admin lists the requests with their status, never the phone", async () => {
    const admin = await adminSession(app, database.db, "super", { now: clock.now });
    const res = await call(app, "GET", "/admin/deletion-requests", admin.headers);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.map((x: { accountKind: string; status: string }) => [x.accountKind, x.status]).sort()).toEqual([["driver", "erased"], ["rider", "erased"]]);
    expect(JSON.stringify(body)).not.toContain(SARA.slice(1));
    expect(body.items.find((x: { accountKind: string }) => x.accountKind === "rider").debt).toEqual({ amount: { amountMinor: 6500, currency: "SEK" }, settled: false });
  });

  it("account_erase is an hourly housekeeping kind with a heartbeat", () => {
    expect(HOUSEKEEPING_KINDS).toContain(ACCOUNT_ERASE);
    expect(RECURRING_JOBS.map((j) => j.kind)).toContain(ACCOUNT_ERASE);
  });
});
