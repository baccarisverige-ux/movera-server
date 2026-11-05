import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contract } from "../../src/contract/contract.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";

/** The database's allowed values must be the contract's, so a contract bump that adds one fails here first. */
type Lists = {
  tripStatus: { values: string[]; terminal: string[]; driverAssigned: string[] };
  paymentStatus: string[];
  ratingStatus: string[];
  driverAccountStatus: string[];
  driverOnlineStatus: string[];
  paymentMethods: string[];
  currencies: Record<string, unknown>;
  realtime: { kinds: string[] };
};
const c = contract as unknown as Lists;

let database: TestDatabase;
beforeAll(async () => {
  database = await freshDatabase();
});
afterAll(async () => {
  await database.drop();
});

/** The quoted values inside a CHECK (… IN (…)) / ANY (ARRAY[…]) on `column`. */
async function allowed(table: string, column: string): Promise<string[]> {
  const result = await database.pool.query<{ def: string }>(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'c'`,
    [table],
  );
  const def = result.rows.map((row) => row.def).find((text) => new RegExp(`\\(\\(?${column}\\)?(::[a-z ]+)?\\s*=\\s*ANY`).test(text));
  if (def === undefined) throw new Error(`No value list check on ${table}.${column}`);
  return [...def.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
}

async function indexPredicate(name: string): Promise<string[]> {
  const result = await database.pool.query<{ def: string }>("SELECT pg_get_indexdef($1::regclass) AS def", [name]);
  const def = result.rows[0]!.def;
  // The status list only (v0.18.17: the driver index also leaves out a booked ride held for later).
  const list = /status\)?(::[a-z ]+)?\s*=\s*ANY\s*\(+ARRAY\[([^\]]+)\]/.exec(def.slice(def.indexOf("status")))?.[2] ?? def.slice(def.indexOf("status"));
  return [...list.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
}

describe("database values match contract v" + String((contract as { version: string }).version), () => {
  it("trip statuses", async () => expect(await allowed("trips", "status")).toEqual(c.tripStatus.values));
  it("payment statuses", async () => expect(await allowed("trips", "payment_status")).toEqual(c.paymentStatus));
  it("rating statuses", async () => expect(await allowed("trips", "rating_status")).toEqual(c.ratingStatus));
  it("payment methods", async () => expect(await allowed("trips", "payment_method")).toEqual(c.paymentMethods));
  it("currencies", async () => expect(await allowed("trips", "currency")).toEqual(Object.keys(c.currencies)));
  it("driver account statuses", async () => expect(await allowed("drivers", "account_status")).toEqual(c.driverAccountStatus));
  it("driver online statuses", async () => expect(await allowed("drivers", "online_status")).toEqual(c.driverOnlineStatus));
  it("realtime event kinds", async () => expect(await allowed("trip_events", "kind")).toEqual(c.realtime.kinds));
  it("'not over' for one-live-trip-per-rider is every status but the terminal ones", async () =>
    expect(await indexPredicate("trips_one_live_per_rider")).toEqual(c.tripStatus.terminal));
  it("'active' for one-trip-per-driver is the driver-assigned statuses", async () =>
    expect(await indexPredicate("trips_one_active_per_driver")).toEqual(c.tripStatus.driverAssigned));
  it("v0.18.17: a booked ride a driver holds for later is not his one active trip", async () => {
    const result = await database.pool.query<{ def: string }>("SELECT pg_get_indexdef('trips_one_active_per_driver'::regclass) AS def");
    expect(result.rows[0]!.def).toMatch(/NOT \(\(kind = 'scheduled'::text\) AND \(status = 'accepted'::text\) AND \(COALESCE\(\(reservation ->> 'held'::text\), 'false'::text\) = 'true'::text\)\)/);
  });
  it("v0.18.33 (migration 0082): a live trip queued behind the driver's current trip is not his one active trip", async () => {
    const result = await database.pool.query<{ def: string }>("SELECT pg_get_indexdef('trips_one_active_per_driver'::regclass) AS def");
    expect(result.rows[0]!.def).toMatch(/next_after_trip_id IS NULL/);
  });
});
