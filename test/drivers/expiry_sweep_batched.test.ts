import { Kysely, PostgresDialect } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../src/db/schema.js";
import { sweepDocumentExpiry } from "../../src/drivers/reminders.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver } from "../support/seed.js";

/** S05 A4 (E8): the hourly expiry sweep reads only documents a warning can reach, with batched lookups. */
const DAY = 86_400_000;
const now = new Date("2026-11-11T10:00:00.000Z");
let database: TestDatabase;
let traced: Kysely<Database>;
let sqls: string[] = [];

async function seed(prefix: string, count: number) {
  const db = database.db;
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = await insertDriver(db, { driverId: `drv_${prefix}_${i}` });
    const country = ["SE", "FR", null][i % 3]!;
    await db.updateTable("drivers").set({ country, language: ["sv", "fr", "en"][i % 3]!, account_type: "fleet" }).where("driver_id", "=", id).execute();
    const fleet = `flt_${prefix}_${i}`;
    await db.insertInto("fleets").values({ fleet_id: fleet, name: "F", org_number: "1", country: i % 2 ? "FR" : "SE", city_id: "c", zone_id: "z", owner_driver_id: id, created_at: now, updated_at: now }).execute();
    const car = `veh_${prefix}_${i}`;
    await db.insertInto("vehicles").values({ vehicle_id: car, fleet_id: i % 4 === 3 ? null : fleet, driver_id: id, make: "Volvo", model: "V60", year: 2021, color: "Grey", plate: `P${prefix}${i}`, seats: 4, category_ids: ["economy"], status: "approved", created_at: now, updated_at: now } as never).execute();
    const at = (ms: number) => new Date(now.getTime() + ms);
    const docs: Array<[string, "driver" | "vehicle", string, Date]> = [
      ["driving_license", "driver", id, at(-3_600_000)],
      ["taxi_driver_license", "driver", id, at(12 * 3_600_000)],
      ["company_registration", "driver", id, at(5 * DAY)],
      ["insurance", "vehicle", car, at(20 * DAY + 5)],
      ["registration", "vehicle", car, at(29 * DAY)],
      ["inspection", "vehicle", car, at(60 * DAY)],
      ["profile_photo", "driver", id, at(400 * DAY)],
    ];
    for (const [type, kind, owner, expires] of docs)
      await db.insertInto("documents").values({ document_id: `doc_${prefix}_${i}_${type}`, driver_id: id, owner_kind: kind, owner_id: owner, type, status: "approved", expires_at: expires, reviewed_at: now, created_at: now, updated_at: now }).execute();
    out.push(id);
  }
  return out;
}

const result = async (prefix: string) => ({
  notices: (await database.db.selectFrom("notifications").selectAll().where("subject_id", "like", `drv_${prefix}_%`).orderBy("subject_id").orderBy("kind").orderBy("title").execute()).map((n) => ({ ...n, notification_id: undefined, created_at: undefined })),
  sent: await database.db.selectFrom("document_notices").select(["document_id", "warn_day"]).where("document_id", "like", `doc_${prefix}_%`).orderBy("document_id").orderBy("warn_day").execute(),
  statuses: await database.db.selectFrom("documents").select(["document_id", "status"]).where("document_id", "like", `doc_${prefix}_%`).orderBy("document_id").execute(),
});

beforeAll(async () => {
  database = await freshDatabase();
  traced = new Kysely<Database>({
    dialect: new PostgresDialect({ pool: database.pool }),
    log: (event) => {
      if (event.level === "query") sqls.push(event.query.sql);
    },
  });
});
afterAll(async () => {
  await database.drop();
});

describe("document expiry sweep (S05 A4)", () => {
  it("reads documents beyond the largest warning not at all, and looks up drivers, cars, fleets and settings once", async () => {
    await seed("a", 6);
    sqls = [];
    await sweepDocumentExpiry(traced as never, now);
    const first = await result("a");
    // Expired (−1h), 12 h, 5 d, 20 d, 29 d reached; 60 d and 400 d are beyond every warning (30 days by default).
    expect(first.statuses.filter((s) => s.status === "expired").map((s) => s.document_id)).toEqual(expect.arrayContaining(["doc_a_0_driving_license"]));
    expect(first.notices.length).toBe(6 * 5);
    expect(first.sent.some((s) => s.document_id.endsWith("_inspection") || s.document_id.endsWith("_profile_photo"))).toBe(false);
    const lookups = (list: string[]) => list.filter((q) => /^select .* from "(drivers|vehicles|fleets|config_live)"/.test(q) && !q.includes('"online_status"')).length;
    const small = lookups(sqls);
    // A second sweep the same hour sends nothing new; then three times the documents cost the same lookups.
    await seed("b", 18);
    sqls = [];
    await sweepDocumentExpiry(traced as never, now);
    expect(lookups(sqls)).toBe(small);
    expect(small).toBeLessThanOrEqual(4);
    expect((await result("a")).notices.length).toBe(first.notices.length);
    expect((await result("b")).notices.length).toBe(18 * 5);
  });
});
