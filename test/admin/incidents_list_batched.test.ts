import { Kysely, PostgresDialect } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../src/db/schema.js";
import type { Principal } from "../../src/auth/guard.js";
// The ride module first: safety/incidents.ts and safety/rideCheck.ts import each other through trips/ride.ts.
import "../../src/trips/ride.js";
import { adminIncident, listIncidents } from "../../src/safety/incidents.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver } from "../support/seed.js";

/**
 * B1.26 (handover/build-plans-2026-11-12/B1.26.md): the admin SOS list reads the cars' live positions in one batch per
 * page, not one query per incident (a page of 50 was 51 statements, the panel's 100-row pages 101).
 */
const SUPER: Principal = { actor: "admin", subjectId: "adm_b126", sessionId: "s_b126", zones: ["*"], role: "super", perms: ["incidents.read"] };
const base = new Date("2026-11-12T10:00:00Z");

let database: TestDatabase;
let traced: Kysely<Database>;
let queries = 0;

beforeAll(async () => {
  database = await freshDatabase();
  traced = new Kysely<Database>({
    dialect: new PostgresDialect({ pool: database.pool }),
    log: (event) => {
      if (event.level === "query") queries++;
    },
  });
  const db = database.db;
  const rows = [];
  for (let i = 0; i < 50; i++) {
    const id = await insertDriver(db, { driverId: `drv_b126_${String(i).padStart(3, "0")}` });
    await db
      .insertInto("driver_locations")
      .values({ driver_id: id, lat: 59.33 + i * 0.001, lng: 18.06, accuracy: 5, heading: i % 2 ? 90 : null, speed_mps: i % 3 ? 4 : null, moving: i % 2 === 0, measured_at: base, received_at: base })
      .execute();
    // Every 10th incident has no driver (a rider's SOS before acceptance): it keeps the fix kept at opening.
    const at = new Date(base.getTime() - (i + 1) * 1000);
    rows.push({ incident_id: `inc_b126_o${String(i).padStart(3, "0")}`, kind: "sos", severity: "critical" as const, status: (i % 4 === 1 ? "investigating" : "open") as "open" | "investigating", raised_by: "rider" as const, zone_id: "Z001", driver_id: i % 10 === 9 ? null : id, driver_fix: i % 10 === 9 ? JSON.stringify({ lat: 1, lng: 2, accuracy: 3, moving: false, measuredAt: at.toISOString() }) : null, opened_at: at, updated_at: at });
  }
  for (let i = 0; i < 5; i++) {
    const at = new Date(base.getTime() - (100 + i) * 1000);
    rows.push({ incident_id: `inc_b126_r${i}`, kind: "sos", severity: "high" as const, status: "resolved" as never, raised_by: "driver" as const, zone_id: "Z001", driver_id: `drv_b126_00${i}`, driver_fix: null, opened_at: at, updated_at: at });
  }
  await db.insertInto("incidents").values(rows as never).execute();
});

afterAll(async () => {
  await database.drop();
});

async function counted<T>(run: () => Promise<T>): Promise<{ result: T; queries: number }> {
  queries = 0;
  const result = await run();
  return { result, queries };
}

describe("admin incident list (B1.26)", () => {
  it("B1.26: a page of 50 incidents costs the same statements as a page of 5 (one batched position read)", async () => {
    const small = await counted(() => listIncidents(traced as never, SUPER, { limit: 5 }));
    const large = await counted(() => listIncidents(traced as never, SUPER, { limit: 50 }));
    expect(small.result.items).toHaveLength(5);
    expect(large.result.items).toHaveLength(50);
    expect(large.queries).toBe(small.queries);
    // The page, then the positions of the page's drivers; L78-S: + the first page's total (begin, SET LOCAL
    // statement_timeout, count, commit), the same for any page size.
    expect(large.queries).toBe(6);
  });

  it("B1.26: a page with no driver reads no positions", async () => {
    const { result, queries: n } = await counted(() => listIncidents(traced as never, SUPER, { limit: 1, kind: "no_such_kind" }));
    expect(result.items).toEqual([]);
    // The page and its total (4 statements, L78-S); no position read.
    expect(n).toBe(5);
  });

  it("B1.26: every item is exactly what the single read gives", async () => {
    const { items } = await listIncidents(traced as never, SUPER, { limit: 60 });
    expect(items).toHaveLength(55);
    for (const item of items) expect(item).toEqual(await adminIncident(traced as never, SUPER, item["incidentId"] as string));
    const live = items.find((v) => v["incidentId"] === "inc_b126_o000")!;
    expect(live["driverPosition"]).toMatchObject({ lat: 59.33, lng: 18.06, moving: true });
    const kept = items.find((v) => v["incidentId"] === "inc_b126_o009")!;
    expect(kept["driverPosition"]).toMatchObject({ lat: 1, lng: 2 });
  });

  it("B1.26: status=open&status=investigating pages only open cases", async () => {
    const first = await listIncidents(traced as never, SUPER, { limit: 20, status: ["open", "investigating"] });
    expect(first.items).toHaveLength(20);
    expect(first.nextCursor).not.toBeNull();
    const second = await listIncidents(traced as never, SUPER, { limit: 20, status: ["open", "investigating"], cursor: first.nextCursor! });
    const third = await listIncidents(traced as never, SUPER, { limit: 20, status: ["open", "investigating"], cursor: second.nextCursor! });
    const all = [...first.items, ...second.items, ...third.items];
    expect(all).toHaveLength(50);
    expect(third.nextCursor).toBeNull();
    expect(new Set(all.map((v) => v["incidentId"])).size).toBe(50);
    expect(all.every((v) => v["status"] === "open" || v["status"] === "investigating")).toBe(true);
  });
});
