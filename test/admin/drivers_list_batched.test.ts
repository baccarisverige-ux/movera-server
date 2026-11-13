import { Kysely, PostgresDialect } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LIST_COUNT } from "../../src/admin/listTotal.js";
import type { Database } from "../../src/db/schema.js";
import type { Principal } from "../../src/auth/guard.js";
import { listDrivers } from "../../src/admin/lists.js";
import { maskDriverView } from "../../src/admin/masking.js";
import { driverView, loadDriver } from "../../src/drivers/service.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver, insertRider, insertTrip } from "../support/seed.js";

/** S06 F9 (E7): the admin drivers list reads each kind of fact once per page, not ~10 queries per driver. */
const SUPER: Principal = { actor: "admin", subjectId: "adm_e7", sessionId: "s_e7", zones: ["*"], role: "super", perms: ["drivers.viewSensitive"] };
const now = new Date();
const hour = 3_600_000;

let database: TestDatabase;
let traced: Kysely<Database>;
let queries = 0;

async function seedDriver(i: number) {
  const id = await insertDriver(database.db, { driverId: `drv_e7_${String(i).padStart(3, "0")}` });
  const db = database.db;
  const kind = i % 4;
  await db
    .updateTable("drivers")
    .set({
      country: kind === 3 ? null : "SE",
      account_type: kind === 0 ? "fleet" : kind === 1 ? "driver" : null,
      account_status: kind === 0 ? "pending" : kind === 2 ? "on_hold" : "active",
      created_at: new Date(now.getTime() - (i + 1) * 24 * hour),
    })
    .where("driver_id", "=", id)
    .execute();
  if (kind === 0) {
    await db.insertInto("fleets").values({ fleet_id: `flt_${id}`, name: `Fleet ${i}`, org_number: "556677-8899", country: "SE", city_id: "stockholm", zone_id: "stockholm", owner_driver_id: id, created_at: now, updated_at: now }).execute();
    await db.updateTable("drivers").set({ fleet_id: `flt_${id}` }).where("driver_id", "=", id).execute();
    await db.insertInto("sign_up_reminders").values([{ driver_id: id, sent_at: new Date(now.getTime() - 2 * hour) }, { driver_id: id, sent_at: new Date(now.getTime() - hour) }]).execute();
  }
  if (kind === 1) {
    const owner = `drv_e7_${String(i - 1).padStart(3, "0")}`;
    await db.updateTable("drivers").set({ fleet_id: `flt_${owner}`, fleet_linked_at: now }).where("driver_id", "=", id).execute();
    await db.insertInto("fleet_invitations").values({ invitation_id: `inv_a_${id}`, fleet_id: `flt_${owner}`, direction: "owner_invite", driver_id: id, expires_at: new Date(now.getTime() + hour), created_at: now, updated_at: now }).execute();
    await db.insertInto("fleet_invitations").values({ invitation_id: `inv_b_${id}`, fleet_id: `flt_${owner}`, direction: "owner_invite", driver_id: id, expires_at: new Date(now.getTime() - hour), created_at: now, updated_at: now }).execute();
    await db.insertInto("fleet_invitations").values({ invitation_id: `inv_c_${id}`, fleet_id: `flt_${owner}`, direction: "driver_request", driver_id: id, expires_at: new Date(now.getTime() + hour), created_at: now, updated_at: now }).execute();
    await db.insertInto("driver_locations").values({ driver_id: id, lat: 59.33, lng: 18.06, accuracy: 5, heading: 90, speed_mps: 3, measured_at: now, received_at: now }).execute();
    await insertTrip(db, await insertRider(db), { driverId: id, status: "accepted" });
  }
  if (kind !== 3) {
    const doc = `doc_${id}`;
    await db.insertInto("documents").values({ document_id: doc, driver_id: id, owner_kind: "driver", owner_id: id, type: "driving_licence", status: "approved", expires_at: new Date(now.getTime() + 30 * 24 * hour), reviewed_at: now, created_at: now, updated_at: now }).execute();
    await db.insertInto("documents").values({ document_id: `doc2_${id}`, driver_id: id, owner_kind: "driver", owner_id: id, type: "taxi_licence", status: "in_review", created_at: new Date(now.getTime() + 1), updated_at: now }).execute();
    if (kind === 0)
      await db
        .insertInto("document_renewals")
        .values({ renewal_id: `ren_${id}`, document_id: doc, expires_at: new Date(now.getTime() + 400 * 24 * hour), file_name: "a.pdf", media_type: "application/pdf", file_size: 1, uploaded_at: now, reviewed_at: null, reviewed_by: null, review_note: null, key_id: "k", iv: Buffer.from("i"), tag: Buffer.from("t"), ciphertext: Buffer.from("c") })
        .execute();
  }
}

// L78-S: these cases count the statements a list sends, the first page's total included; wait for the count so it is
// always there (the production wait of 25 ms is tested in test/admin/list_total.test.ts).
const WAIT_BEFORE = LIST_COUNT.waitAfterPageMs;
beforeAll(async () => {
  LIST_COUNT.waitAfterPageMs = 5000;
  database = await freshDatabase();
  traced = new Kysely<Database>({
    dialect: new PostgresDialect({ pool: database.pool }),
    log: (event) => {
      if (event.level === "query") queries++;
    },
  });
  for (let i = 0; i < 24; i++) await seedDriver(i);
});

afterAll(async () => {
  LIST_COUNT.waitAfterPageMs = WAIT_BEFORE;
  await database.drop();
});

async function counted<T>(run: () => Promise<T>): Promise<{ result: T; queries: number }> {
  queries = 0;
  const result = await run();
  return { result, queries };
}

describe("admin drivers list (S06 F9)", () => {
  it("gives every driver exactly the view driverView gives him alone", async () => {
    const { items } = await listDrivers(traced as never, SUPER, { limit: 24 });
    expect(items).toHaveLength(24);
    for (const item of items) {
      const alone = maskDriverView(await driverView(traced as never, await loadDriver(traced as never, item["driverId"] as string), "admin", now), SUPER);
      expect(item).toEqual(alone);
    }
    const owner = items.find((v) => v["driverId"] === "drv_e7_000")!;
    expect(owner["signUp"]).toMatchObject({ remindersSent: 2 });
    expect((owner["documents"] as unknown[]).length).toBe(3);
    const member = items.find((v) => v["driverId"] === "drv_e7_001")!;
    expect(member).toMatchObject({ pendingFleetInvitations: 1, payoutTo: "fleet", fleet: { role: "member" } });
    expect(member["activeTripId"]).toBeDefined();
    expect(owner["pendingFleetInvitations"]).toBe(1);
  });

  it("costs the same number of queries for a page of 4 drivers and a page of 24", async () => {
    const small = await counted(() => listDrivers(traced as never, SUPER, { limit: 4 }));
    const large = await counted(() => listDrivers(traced as never, SUPER, { limit: 24 }));
    expect(small.result.items).toHaveLength(4);
    expect(large.result.items).toHaveLength(24);
    // The page, then locations, active trips, fleets, documents, renewals, two invitation counts, settings, reminders;
    // L78-S: + the first page's total (begin, SET LOCAL statement_timeout and max_parallel_workers_per_gather, count, commit), the same for any page size.
    expect(large.queries).toBe(small.queries);
    expect(large.queries).toBe(15);
  });
});
