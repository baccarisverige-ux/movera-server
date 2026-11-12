import type { FastifyInstance } from "fastify";
import { Kysely, PostgresDialect } from "kysely";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import type { Database } from "../../src/db/schema.js";
import { readEnv } from "../../src/env.js";
import { LIST_COUNT } from "../../src/admin/listTotal.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver, insertRider, insertTrip } from "../support/seed.js";
import { adminSession } from "../support/admin.js";
import { fixedRouter, testWorld } from "../support/world.js";

/**
 * L78-S (contract v0.18.78, contract.json#adminListFilters.total + incidentsByPerson): the 10 admin lists send `total`
 * (exact, same filters, without cursor/limit) on the first page when it is counted within its time budget, and leave
 * it out when the count times out without failing or slowing the page. GET /admin/vehicles judges a car's zone in SQL
 * (its fleet's zone, else its owner's first zone) for the page and the count, so "Load more" is never lost. GET
 * /admin/incidents takes driverId / riderId.
 */

let database: TestDatabase;
let app: FastifyInstance;
let slowApp: FastifyInstance;
let slowDb: Kysely<Database>;
const clock = { now: new Date("2026-11-12T10:00:00Z") };
let superAdmin: Record<string, string>;
let z001Admin: Record<string, string>;
const id = { rA: "", rB: "", rF: "", dA: "", dB: "", dC: "" };
const LISTS: Array<[string, string]> = [
  ["/admin/trips", "tripId"],
  ["/admin/riders", "riderId"],
  ["/admin/drivers", "driverId"],
  ["/admin/fleets", "fleetId"],
  ["/admin/vehicles", "vehicleId"],
  ["/admin/payments", "paymentId"],
  ["/admin/refunds", "refundId"],
  ["/admin/payouts", "payoutId"],
  ["/admin/tickets", "ticketId"],
  ["/admin/incidents", "incidentId"],
];

const at = (minutesAgo: number) => new Date(clock.now.getTime() - minutesAgo * 60_000);
const get = (url: string, headers: Record<string, string>, on: FastifyInstance = app) => on.inject({ method: "GET", url: `/api/v1${url}`, headers });
const join = (path: string, query: string) => `${path}${path.includes("?") ? "&" : "?"}${query}`;

/** Every row of a query, page by page; the first page's answer is returned too. */
async function allPages(path: string, key: string, headers: Record<string, string>, limit = 2) {
  const first = await get(join(path, `limit=${limit}`), headers);
  expect(first.statusCode, `${path}: ${first.body}`).toBe(200);
  const ids: string[] = (first.json().items as Record<string, string>[]).map((row) => row[key]!);
  let cursor: string | null = first.json().nextCursor;
  let pages = 1;
  while (cursor) {
    const next = await get(join(path, `limit=${limit}&cursor=${encodeURIComponent(cursor)}`), headers);
    expect(next.statusCode, `${path}: ${next.body}`).toBe(200);
    ids.push(...(next.json().items as Record<string, string>[]).map((row) => row[key]!));
    cursor = next.json().nextCursor;
    if (++pages > 50) throw new Error(`${path}: too many pages`);
  }
  return { first: first.json() as { items: unknown[]; nextCursor: string | null; total?: number }, ids };
}

/**
 * A database handle whose list counts take 3 s (pg_sleep added to the count statement only): the server's own bounded
 * count must give up, leave total out, and still serve the page.
 */
function slowCounts(pool: pg.Pool): Kysely<Database> {
  const wrapped = {
    connect: async () => {
      const client = await pool.connect();
      return new Proxy(client, {
        get(target, prop) {
          if (prop === "query") {
            return (text: unknown, params: unknown) =>
              typeof text === "string" && text.includes('count(*) as "total"')
                ? target.query(text.replace('count(*) as "total"', 'count(*) + (select 0 from pg_sleep(3)) as "total"'), params as never[])
                : target.query(text as never, params as never);
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
    end: async () => undefined,
  };
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool: wrapped as never }) });
}

beforeAll(async () => {
  database = await freshDatabase();
  const db = database.db;
  app = await testWorld(db, database.url, clock);
  slowDb = slowCounts(database.pool);
  slowApp = await buildApp({ env: readEnv({ MOVERA_ENV: "staging", DATABASE_URL: database.url, JWT_SECRET: "world-test-secret".padEnd(48, "w") }), logger: false, db: slowDb, clock: () => clock.now, router: fixedRouter });

  id.rA = await insertRider(db);
  id.rB = await insertRider(db);
  id.rF = await insertRider(db);
  id.dA = await insertDriver(db);
  id.dB = await insertDriver(db);
  id.dC = await insertDriver(db);
  await db.updateTable("drivers").set({ zone_ids: ["Z001"] }).where("driver_id", "=", id.dA).execute();
  await db.updateTable("drivers").set({ zone_ids: ["Z002"] }).where("driver_id", "=", id.dB).execute();
  // dC works in Z002 first: his own cars are judged by Z002.
  await db.updateTable("drivers").set({ zone_ids: ["Z002", "Z001"] }).where("driver_id", "=", id.dC).execute();

  // Trips (and payments: the trips with a payment status): 3 in Z001, 2 in Z002, 1 in FR-PC.
  const trips: Record<string, string[]> = { Z001: [], Z002: [], "FR-PC": [] };
  const tripPlan: Array<[string, string, boolean]> = [["Z001", id.rA, true], ["Z001", id.rA, true], ["Z001", id.rA, false], ["Z002", id.rB, true], ["Z002", id.rB, false], ["FR-PC", id.rF, true]];
  for (const [i, [zone, rider, paid]] of tripPlan.entries()) {
    const tripId = await insertTrip(db, rider, { status: "completed" });
    await db.updateTable("trips").set({ zone_id: zone, created_at: at(100 + i), updated_at: at(100 + i), payment_status: paid ? "captured" : null, ...(zone === "FR-PC" ? { currency: "EUR" } : {}) } as never).where("trip_id", "=", tripId).execute();
    trips[zone]!.push(tripId);
  }

  await db.insertInto("fleets").values([
    { fleet_id: "flt_l78_a", name: "Fleet A", org_number: "556000-0001", address: "Street 1", country: "SE", city_id: "stockholm", zone_id: "Z001", owner_driver_id: id.dA, status: "approved", version: 1, created_at: at(300), updated_at: at(300) },
    { fleet_id: "flt_l78_b", name: "Fleet B", org_number: "556000-0002", address: "Street 2", country: "SE", city_id: "stockholm", zone_id: "Z002", owner_driver_id: id.dB, status: "approved", version: 1, created_at: at(301), updated_at: at(301) },
  ] as never).execute();

  // Vehicles: the 12 newest are Z002 cars, the older ones Z001, so a Z001 admin's first page needs more than limit*3+1 rows.
  const cars: Array<{ fleet: string | null; driver: string | null }> = [
    ...Array.from({ length: 7 }, () => ({ fleet: "flt_l78_b", driver: null })),
    ...Array.from({ length: 5 }, () => ({ fleet: null, driver: id.dC })),
    ...Array.from({ length: 7 }, () => ({ fleet: "flt_l78_a", driver: null })),
    ...Array.from({ length: 3 }, () => ({ fleet: null, driver: id.dA })),
    { fleet: null, driver: null },
  ];
  await db.insertInto("vehicles").values(cars.map((car, i) => ({ vehicle_id: `veh_l78_${String(i).padStart(2, "0")}`, make: "Volvo", model: "XC60", year: 2022, color: "black", plate: `L78 ${String(100 + i)}`, fleet_id: car.fleet, driver_id: car.driver, created_at: at(10 + i), updated_at: at(10 + i) })) as never).execute();

  await db.insertInto("refunds").values([
    { refund_id: "rfd_l78_1", trip_id: trips["Z001"]![0]!, rider_id: id.rA, currency: "SEK", amount_minor: 100, reason: "test", status: "done", created_by: "adm", created_at: at(50) },
    { refund_id: "rfd_l78_2", trip_id: trips["Z001"]![1]!, rider_id: id.rA, currency: "SEK", amount_minor: 100, reason: "test", status: "done", created_by: "adm", created_at: at(51) },
    { refund_id: "rfd_l78_3", trip_id: trips["Z001"]![2]!, rider_id: id.rA, currency: "SEK", amount_minor: 100, reason: "test", status: "pending_approval", created_by: "adm", created_at: at(52) },
    { refund_id: "rfd_l78_4", trip_id: trips["Z002"]![0]!, rider_id: id.rB, currency: "SEK", amount_minor: 100, reason: "test", status: "done", created_by: "adm", created_at: at(53) },
  ] as never).execute();

  const payout = (n: number, driver: string, zone: string) => ({ payout_id: `pyt_l78_${n}`, driver_id: driver, zone_id: zone, currency: "SEK", amount_minor: 1000, lines: JSON.stringify([]), trip_count: 1, source: "weekly", status: "pending", period_start: at(10_000 + n * 20_000), period_end: at(5000 + n * 20_000), created_at: at(60 + n) });
  await db.insertInto("payouts").values([payout(1, id.dA, "Z001"), payout(2, id.dA, "Z001"), payout(3, id.dA, "Z001"), payout(4, id.dB, "Z002")] as never).execute();

  const ticket = (n: number, zone: string | null, country: string | null) => ({ ticket_id: `tkt_l78_${n}`, opened_by: "rider", rider_id: id.rA, zone_id: zone, country, category: "other", subject: `Ticket ${n}`, status: "open", priority: "normal", created_at: at(70 + n), updated_at: at(70 + n), last_message_at: at(70 + n) });
  // A zone-less ticket of Sweden is seen by a Z001 admin (owner 2026-11-03); a French one is not.
  await db.insertInto("support_tickets").values([ticket(1, "Z001", "SE"), ticket(2, "Z001", "SE"), ticket(3, null, "SE"), ticket(4, "Z002", "SE"), ticket(5, null, "FR")] as never).execute();

  const incident = (n: number, zone: string, driver: string | null, rider: string | null) => ({ incident_id: `inc_l78_${n}`, kind: "sos", severity: "high", status: "open", raised_by: "rider", zone_id: zone, driver_id: driver, rider_id: rider, opened_at: at(80 + n), updated_at: at(80 + n) });
  await db.insertInto("incidents").values([
    incident(1, "Z001", id.dA, id.rA),
    incident(2, "Z001", id.dA, null),
    incident(3, "Z001", id.dB, id.rA),
    incident(4, "Z001", null, id.rB),
    incident(5, "Z002", id.dA, id.rB),
    incident(6, "Z002", null, null),
    incident(7, "FR-PC", id.dA, id.rF),
  ] as never).execute();

  superAdmin = (await adminSession(app, db, "super", { now: clock.now })).headers;
  z001Admin = (await adminSession(app, db, "super", { zoneIds: ["Z001"], now: clock.now })).headers;
});

afterAll(async () => {
  await slowApp?.close();
  await app?.close();
  await slowDb?.destroy();
  await database.drop();
});

describe("L78-S: total on the first page of the 10 admin lists", () => {
  it.each(LISTS)("%s: total on the first page equals every row of the query (all zones)", async (path, key) => {
    const { first, ids } = await allPages(path, key, superAdmin);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    expect(first.total, path).toBe(ids.length);
  });

  it.each(LISTS)("%s: total follows a zone-limited admin", async (path, key) => {
    const all = await allPages(path, key, superAdmin);
    const { first, ids } = await allPages(path, key, z001Admin);
    expect(first.total, path).toBe(ids.length);
    // The zone limit really narrows each list (else the case proves nothing).
    expect(ids.length, path).toBeLessThan(all.ids.length);
  });

  it.each(LISTS)("%s: total follows zoneId", async (path, key) => {
    const { first, ids } = await allPages(`${path}?zoneId=Z002`, key, superAdmin);
    expect(first.total, path).toBe(ids.length);
    expect(ids.length, path).toBeGreaterThan(0);
  });

  it("the totals are the seeded numbers", async () => {
    const totals = async (headers: Record<string, string>, query = "") => {
      const out: Record<string, number | undefined> = {};
      for (const [path] of LISTS) out[path] = (await get(`${path}?limit=1${query}`, headers)).json().total;
      return out;
    };
    expect(await totals(superAdmin)).toEqual({ "/admin/trips": 6, "/admin/riders": 3, "/admin/drivers": 3, "/admin/fleets": 2, "/admin/vehicles": 23, "/admin/payments": 4, "/admin/refunds": 4, "/admin/payouts": 4, "/admin/tickets": 5, "/admin/incidents": 7 });
    // dC works in Z002 and Z001: he is a Z001 driver, but his own cars are judged by his first zone, Z002.
    expect(await totals(z001Admin)).toEqual({ "/admin/trips": 3, "/admin/riders": 1, "/admin/drivers": 2, "/admin/fleets": 1, "/admin/vehicles": 10, "/admin/payments": 2, "/admin/refunds": 3, "/admin/payouts": 3, "/admin/tickets": 3, "/admin/incidents": 4 });
    expect((await get("/admin/vehicles?limit=1&zoneId=Z002", superAdmin)).json().total).toBe(12);
    // A zone-limited admin naming a zone he does not cover gets nothing (vehicles never answered 403 for it).
    const outside = (await get("/admin/vehicles?limit=1&zoneId=Z002", z001Admin)).json();
    expect(outside).toMatchObject({ items: [], nextCursor: null, total: 0 });
  });

  it("an empty query has total 0", async () => {
    const res = await get("/admin/trips?status=cancelled", superAdmin);
    expect(res.json()).toEqual({ items: [], nextCursor: null, total: 0 });
  });

  it.each(LISTS)("%s: a count that runs past its time budget leaves total out; the page is still served", async (path, key) => {
    const fast = await get(`${path}?limit=2`, superAdmin);
    const started = Date.now();
    const slow = await get(`${path}?limit=2`, superAdmin, slowApp);
    const took = Date.now() - started;
    expect(slow.statusCode, slow.body).toBe(200);
    expect(slow.json()).not.toHaveProperty("total");
    expect(slow.json().items.map((row: Record<string, string>) => row[key])).toEqual(fast.json().items.map((row: Record<string, string>) => row[key]));
    expect(slow.json().nextCursor).toBe(fast.json().nextCursor);
    // The 3 s count was cut off at the budget (~300 ms), it did not hold the page.
    expect(took).toBeLessThan(2000);
  });

  it("control: the slowed count is a real, valid count; with a budget above 3 s it is sent", async () => {
    const before = LIST_COUNT.timeoutMs;
    LIST_COUNT.timeoutMs = 6000;
    try {
      const started = Date.now();
      const slow = await get("/admin/incidents?limit=2", superAdmin, slowApp);
      expect(Date.now() - started).toBeGreaterThanOrEqual(2900);
      expect(slow.json().total).toBe(7);
    } finally {
      LIST_COUNT.timeoutMs = before;
    }
  });
});

describe("L78-S: GET /admin/vehicles judges the car's zone in SQL", () => {
  it("a zone-limited admin pages through every car of his zones (Load more is not lost)", async () => {
    const first = await get("/admin/vehicles?limit=3", z001Admin);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().items).toHaveLength(3);
    expect(first.json().nextCursor).not.toBeNull();
    const { ids } = await allPages("/admin/vehicles", "vehicleId", z001Admin, 3);
    // Fleet A's 7 cars and dA's own 3; never fleet B's, dC's (first zone Z002) or the car with no zone.
    expect(ids.sort()).toEqual(["veh_l78_12", "veh_l78_13", "veh_l78_14", "veh_l78_15", "veh_l78_16", "veh_l78_17", "veh_l78_18", "veh_l78_19", "veh_l78_20", "veh_l78_21"]);
  });

  it("zoneId pages the same way for an all-zones admin", async () => {
    const { ids } = await allPages("/admin/vehicles?zoneId=Z001", "vehicleId", superAdmin, 4);
    expect(ids).toHaveLength(10);
    const z2 = await allPages("/admin/vehicles?zoneId=Z002", "vehicleId", superAdmin, 4);
    expect(z2.ids.sort()).toEqual(Array.from({ length: 12 }, (_, i) => `veh_l78_${String(i).padStart(2, "0")}`));
  });

  it("the car with no zone is seen only by an all-zones admin", async () => {
    const { ids } = await allPages("/admin/vehicles", "vehicleId", superAdmin, 10);
    expect(ids).toContain("veh_l78_22");
    expect(ids).toHaveLength(23);
  });
});

describe("L78-S: GET /admin/incidents?driverId=&riderId=", () => {
  const incidentIds = async (query: string, headers = superAdmin) => {
    const res = await get(`/admin/incidents?${query}`, headers);
    expect(res.statusCode, res.body).toBe(200);
    return { ids: (res.json().items as Record<string, string>[]).map((row) => row["incidentId"]).sort(), total: res.json().total as number | undefined };
  };

  it("driverId narrows to that driver's cases, with total", async () => {
    expect(await incidentIds(`driverId=${id.dA}`)).toEqual({ ids: ["inc_l78_1", "inc_l78_2", "inc_l78_5", "inc_l78_7"], total: 4 });
  });

  it("riderId narrows to that rider's cases", async () => {
    expect(await incidentIds(`riderId=${id.rA}`)).toEqual({ ids: ["inc_l78_1", "inc_l78_3"], total: 2 });
  });

  it("both together: the cases that match both", async () => {
    expect(await incidentIds(`driverId=${id.dA}&riderId=${id.rA}`)).toEqual({ ids: ["inc_l78_1"], total: 1 });
    expect(await incidentIds(`driverId=${id.dB}&riderId=${id.rB}`)).toEqual({ ids: [], total: 0 });
  });

  it("only inside the admin's zones and with the other filters", async () => {
    expect(await incidentIds(`driverId=${id.dA}`, z001Admin)).toEqual({ ids: ["inc_l78_1", "inc_l78_2"], total: 2 });
    expect(await incidentIds(`driverId=${id.dA}&zoneId=Z002`)).toEqual({ ids: ["inc_l78_5"], total: 1 });
    expect(await incidentIds(`driverId=${id.dA}&country=FR`)).toEqual({ ids: ["inc_l78_7"], total: 1 });
    expect(await incidentIds(`riderId=${id.rB}&status=resolved`)).toEqual({ ids: [], total: 0 });
  });

  it("an id with no case is an empty page, not 404; a malformed id is 400 (not unknown_filter)", async () => {
    expect(await incidentIds("driverId=drv_nobody")).toEqual({ ids: [], total: 0 });
    expect(await incidentIds("riderId=rdr_nobody")).toEqual({ ids: [], total: 0 });
    const bad = await get("/admin/incidents?driverId=not%20an%20id", superAdmin);
    expect(bad.statusCode).toBe(400);
    expect(bad.json().reason).not.toBe("unknown_filter");
  });

  it("pages by driver keep the keyset order", async () => {
    const { first, ids } = await allPages(`/admin/incidents?driverId=${id.dA}`, "incidentId", superAdmin, 1);
    expect(first.total).toBe(4);
    expect(ids).toEqual(["inc_l78_1", "inc_l78_2", "inc_l78_5", "inc_l78_7"]);
  });
});
