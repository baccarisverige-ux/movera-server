import { Kysely, PostgresDialect } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../src/db/schema.js";
import { vehicleFullView, vehicleFullViews, type VehicleRow } from "../../src/drivers/service.js";
import { defaultSettings } from "../../src/drivers/onboardingSettings.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver } from "../support/seed.js";
import { adminFleetViews, fleetView } from "../../src/drivers/onboarding.js";

/**
 * SUP3 P7 (audits/fix-plan-2026-11-13/sup3-admin.md; G34 proof P7: GET /admin/vehicles?limit=50 ran 322 statements,
 * one car after the other, p95 15 s at 2k): the admin cars page reads each kind of fact once per page.
 */
const now = new Date();
let database: TestDatabase;
let traced: Kysely<Database>;
let queries = 0;

beforeAll(async () => {
  database = await freshDatabase();
  traced = new Kysely<Database>({ dialect: new PostgresDialect({ pool: database.pool }), log: (event) => void (event.level === "query" && queries++) });
  const db = database.db;
  // FR publishes its own rules (photos needed, comfort from 2024): the batched view must read the published document.
  const fr = defaultSettings("FR");
  fr.vehicles.photosNeeded = true;
  fr.vehicles.categories = fr.vehicles.categories.map((r) => (r.category === "comfort" ? { ...r, minYear: 2024 } : r));
  await db.insertInto("config_live").values({ doc: "onboarding", zone_id: "standard-FR", version: 2, document: JSON.stringify(fr), published_at: now, published_by: null } as never).execute();
  for (let i = 0; i < 24; i++) {
    const kind = i % 4;
    const id = await insertDriver(db, { driverId: `drv_p7_${String(i).padStart(2, "0")}` });
    const country = kind === 3 ? null : i % 2 ? "FR" : "SE";
    await db.updateTable("drivers").set({ country, online_status: kind === 0 ? "online" : "offline" }).where("driver_id", "=", id).execute();
    let fleetId: string | null = null;
    if (kind <= 1) {
      fleetId = `flt_p7_${i}`;
      await db.insertInto("fleets").values({ fleet_id: fleetId, name: `Fleet ${i}`, org_number: "556677-8899", country: country ?? "SE", city_id: "stockholm", zone_id: "stockholm", owner_driver_id: id, created_at: now, updated_at: now } as never).execute();
    }
    const vehicleId = `veh_p7_${String(i).padStart(2, "0")}`;
    // kind 0: a fleet car its driver has picked and is online with; 1: a fleet car nobody drives; 2: a driver's own car; 3: a car without a country.
    await db.insertInto("vehicles").values({ vehicle_id: vehicleId, fleet_id: fleetId, driver_id: kind === 1 ? null : id, make: "Volvo", model: "V60", year: 2018 + (i % 8), color: "Grey", plate: `P7 ${100 + i}`, seats: 3 + (i % 4), category_ids: ["economy", "comfort"], status: "approved", created_at: new Date(now.getTime() - i * 60_000), updated_at: now } as never).execute();
    if (kind === 0) await db.updateTable("drivers").set({ vehicle_id: vehicleId }).where("driver_id", "=", id).execute();
    if (kind !== 3) {
      await db.insertInto("documents").values({ document_id: `doc_p7_${i}`, driver_id: id, owner_kind: "vehicle", owner_id: vehicleId, type: "vehicle_registration", status: "approved", expires_at: new Date(now.getTime() + 30 * 86_400_000), reviewed_at: now, created_at: now, updated_at: now } as never).execute();
      if (kind === 0)
        await db.insertInto("document_renewals").values({ renewal_id: `ren_p7_${i}`, document_id: `doc_p7_${i}`, expires_at: new Date(now.getTime() + 400 * 86_400_000), file_name: "a.pdf", media_type: "application/pdf", file_size: 1, uploaded_at: now, reviewed_at: null, reviewed_by: null, review_note: null, key_id: "k", iv: Buffer.from("i"), tag: Buffer.from("t"), ciphertext: Buffer.from("c") } as never).execute();
    }
  }
});

afterAll(async () => {
  await database.drop();
});

const page = async (limit: number) => (await database.db.selectFrom("vehicles").selectAll().orderBy("created_at", "desc").orderBy("vehicle_id", "desc").limit(limit).execute()) as unknown as VehicleRow[];

describe("admin cars list, batched (SUP3 P7)", () => {
  it("gives every car exactly the view vehicleFullView gives it alone", async () => {
    const rows = await page(24);
    const views = await vehicleFullViews(traced as never, rows);
    expect(views).toHaveLength(24);
    for (let i = 0; i < rows.length; i++) expect(views[i]).toEqual(await vehicleFullView(traced as never, rows[i]!));
    expect(views.some((v) => v.inUse === true)).toBe(true);
    expect(views.some((v) => (v.ruleProblems ?? []).length > 0)).toBe(true);
    expect(views.some((v) => (v.requiredDocuments ?? []).length > 0 && (v.documents ?? []).length === 2)).toBe(true);
    expect(views.some((v) => v.fitCategories === undefined)).toBe(true);
  });

  it("costs the same number of queries for 4 cars and for 24 (one car at a time: about 6 per car)", async () => {
    const small = await page(4);
    const large = await page(24);
    queries = 0;
    await vehicleFullViews(traced as never, small);
    const fewCars = queries;
    queries = 0;
    await vehicleFullViews(traced as never, large);
    const manyCars = queries;
    queries = 0;
    for (const row of large) await vehicleFullView(traced as never, row);
    const oneByOne = queries;
    expect(manyCars).toBe(fewCars);
    // fleets, drivers, documents, renewals, onboarding settings.
    expect(manyCars).toBe(5);
    expect(oneByOne).toBeGreaterThan(100);
  });

  it("fleets page: adminFleetViews gives every fleet the view fleetView gives it alone, in 4 queries (v0.18.159: + the published onboarding settings of the page's countries)", async () => {
    const rows = (await database.db.selectFrom("fleets").selectAll().orderBy("created_at", "desc").orderBy("fleet_id", "desc").execute()) as never[];
    expect(rows.length).toBe(12);
    queries = 0;
    const views = await adminFleetViews(traced as never, rows);
    expect(queries).toBe(4);
    for (let i = 0; i < rows.length; i++) expect(views[i]).toEqual(await fleetView(traced as never, rows[i]!, "admin"));
    expect(views.some((v) => v.vehicleCount === 1)).toBe(true);
  });
});
