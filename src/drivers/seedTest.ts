import { sql } from "kysely";
import type { Trx } from "../db/db.js";
import { newId } from "../ids.js";
import { type DocumentKey, sealFile } from "../documents/files.js";
import { documentKind, requiredDocuments } from "./onboardingRules.js";

/** v0.18.164 (owner 2026-11-25 upload safety): a tiny placeholder PNG (1x1) so every seeded file document has a file. */
const PLACEHOLDER_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

/**
 * The test week's ready accounts (owner, 2026-10-25): activated drivers in one approved test fleet and active
 * riders, on the test phone numbers (fixed sign-in code outside production), so testers sign in and drive at once
 * with no SMS and no approval wait. Placeholder numbers until the owner sends the testers' real ones; running it
 * again updates the same accounts (keyed by phone). Not for production.
 */
export const TEST_FLEET_CODE = "MV-TESTA";

export type TestAccounts = {
  fleet: { name: string; orgNumber: string; address: string; country: string; cityId: string; zoneId: string; code: string };
  drivers: { phone: string; firstName: string; lastName: string; email: string; owner?: boolean; car: { make: string; model: string; year: number; color: string; plate: string; categoryIds: string[] } }[];
  riders: { phone: string; firstName: string; email: string }[];
};

/**
 * Every category the sample pricing document prices (the contract's seed ids plus child_seat): a test driver takes
 * whatever a tester books, so no category goes unanswered in the test week (owner, 2026-10-26: "only Movera
 * categories can the driver receive"). The admin panel can narrow a driver's categories afterwards.
 */
export const TEST_DRIVER_CATEGORIES = ["economy", "comfort", "premium", "priority", "xl", "electric", "pet", "child_seat"];

export const DEFAULT_TEST_ACCOUNTS: TestAccounts = {
  fleet: { name: "Movera Test AB", orgNumber: "559999-0001", address: "Testgatan 1, 151 72 Södertälje", country: "SE", cityId: "stockholm_lan", zoneId: "Z001", code: TEST_FLEET_CODE },
  drivers: [
    { phone: "+46701740605", firstName: "Test", lastName: "Åkare", email: "akare@movera.test", owner: true, car: { make: "Volvo", model: "V60", year: 2021, color: "Black", plate: "TST 001", categoryIds: TEST_DRIVER_CATEGORIES } },
    { phone: "+46701740606", firstName: "Test", lastName: "Förare 2", email: "forare2@movera.test", car: { make: "Toyota", model: "Corolla", year: 2022, color: "White", plate: "TST 002", categoryIds: TEST_DRIVER_CATEGORIES } },
    { phone: "+46701740607", firstName: "Test", lastName: "Förare 3", email: "forare3@movera.test", car: { make: "Tesla", model: "Model 3", year: 2023, color: "Grey", plate: "TST 003", categoryIds: TEST_DRIVER_CATEGORIES } },
  ],
  riders: [
    { phone: "+46701740608", firstName: "Test Resenär 1", email: "resenar1@movera.test" },
    { phone: "+46701740609", firstName: "Test Resenär 2", email: "resenar2@movera.test" },
    { phone: "+46701740610", firstName: "Test Resenär 3", email: "resenar3@movera.test" },
  ],
};

/** Creates or updates the test accounts; answers what was made. */
export async function seedTestAccounts(trx: Trx, accounts: TestAccounts = DEFAULT_TEST_ACCOUNTS, now: Date = new Date(), documentKey?: DocumentKey) {
  const owner = accounts.drivers.find((d) => d.owner);
  if (owner === undefined) throw new Error("The test fleet needs one driver marked owner");
  const driverIds = new Map<string, string>();
  // The testers drive in every open zone (a trip is offered only to drivers of its pickup zone), the fleet's
  // own zone first.
  const openZones = (await trx.selectFrom("zones").select("zone_id").where("open", "=", true).orderBy("zone_id").execute()).map((z) => z.zone_id);
  const zoneIds = [accounts.fleet.zoneId, ...openZones.filter((z) => z !== accounts.fleet.zoneId)];
  // Drivers first (the fleet references its owner).
  for (const d of accounts.drivers) {
    const existing = await trx.selectFrom("drivers").select(["driver_id", "version"]).where("phone", "=", d.phone).executeTakeFirst();
    const driverId = existing?.driver_id ?? newId("drv", now.getTime());
    if (!existing) await trx.insertInto("drivers").values({ driver_id: driverId, phone: d.phone, online_since: null, vehicle_id: null, scheduled_rides: null }).execute();
    await trx
      .updateTable("drivers")
      .set({
        first_name: d.firstName,
        last_name: d.lastName,
        email: d.email,
        // G30: the fake @movera.test addresses stay Not verified (contract.json#emailVerified.writePaths.seed).
        email_verified_at: null,
        date_of_birth: "1990-01-01",
        country: accounts.fleet.country,
        city_id: accounts.fleet.cityId,
        language: "sv",
        account_type: d.owner ? "fleet" : "driver",
        terms_accepted_at: now,
        account_status: "active",
        // G30 (emailVerified.neverActive): every path to active records the first time.
        first_activated_at: sql`coalesce(first_activated_at, ${now})`,
        zone_ids: zoneIds,
        category_ids: d.car.categoryIds,
        version: (existing?.version ?? 1) + 1,
        updated_at: now,
      })
      .where("driver_id", "=", driverId)
      .execute();
    driverIds.set(d.phone, driverId);
  }
  const ownerId = driverIds.get(owner.phone)!;

  // The fleet: approved, with the fixed test code.
  const fleetRow = await trx.selectFrom("fleets").select(["fleet_id", "version"]).where("owner_driver_id", "=", ownerId).executeTakeFirst();
  const fleetId = fleetRow?.fleet_id ?? newId("flt", now.getTime());
  const fleetValues = { name: accounts.fleet.name, org_number: accounts.fleet.orgNumber, address: accounts.fleet.address, country: accounts.fleet.country, city_id: accounts.fleet.cityId, zone_id: accounts.fleet.zoneId, status: "approved" as const, code: accounts.fleet.code, reviewed_at: now, reviewed_by: "seed", updated_at: now };
  if (fleetRow) await trx.updateTable("fleets").set({ ...fleetValues, version: fleetRow.version + 1 }).where("fleet_id", "=", fleetId).execute();
  else await trx.insertInto("fleets").values({ fleet_id: fleetId, owner_driver_id: ownerId, created_at: now, ...fleetValues }).execute();

  // Every driver in the fleet, each with an approved fleet car picked, and every required document approved.
  // v0.18.5 (G2-D5.4): 7 seats and electric, so the cars fit every category they have (XL, Electric); migration 0038.
  const vehicleIds = new Map<string, string>();
  for (const d of accounts.drivers) {
    const driverId = driverIds.get(d.phone)!;
    const plate = d.car.plate.toUpperCase();
    // The plate index ignores case and spaces (vehicles_plate), so the lookup does too.
    const car = await trx.selectFrom("vehicles").select("vehicle_id").where(sql<boolean>`upper(replace(plate, ' ', '')) = ${plate.replace(/\s+/g, "")}`).executeTakeFirst();
    const vehicleId = car?.vehicle_id ?? newId("veh", now.getTime());
    const carValues = { driver_id: driverId, fleet_id: fleetId, make: d.car.make, model: d.car.model, year: d.car.year, color: d.car.color, plate, seats: 7, fuel: "electric" as const, category_ids: d.car.categoryIds, status: "approved" as const, updated_at: now };
    if (car) await trx.updateTable("vehicles").set(carValues).where("vehicle_id", "=", vehicleId).execute();
    else await trx.insertInto("vehicles").values({ vehicle_id: vehicleId, created_at: now, ...carValues }).execute();
    vehicleIds.set(d.phone, vehicleId);
    await trx.updateTable("drivers").set({ fleet_id: fleetId, fleet_linked_at: now, vehicle_id: vehicleId }).where("driver_id", "=", driverId).execute();
    const types = [
      ...requiredDocuments(accounts.fleet.country, "driver").map((type) => ({ ownerKind: "driver" as const, ownerId: driverId, type })),
      ...(d.owner ? requiredDocuments(accounts.fleet.country, "fleet").map((type) => ({ ownerKind: "driver" as const, ownerId: driverId, type })) : []),
      ...requiredDocuments(accounts.fleet.country, "vehicle").map((type) => ({ ownerKind: "vehicle" as const, ownerId: vehicleId, type })),
    ];
    for (const doc of types) {
      // v0.18.164: a file document gets the placeholder file (when the server's document key is given).
      const withFile = documentKey !== undefined && documentKind(doc.type) === "file";
      const file = withFile ? { file_name: "placeholder.png", media_type: "image/png", file_size: PLACEHOLDER_PNG.length, uploaded_at: now } : {};
      const saved = await trx
        .insertInto("documents")
        .values({ document_id: newId("doc", now.getTime()), driver_id: driverId, owner_kind: doc.ownerKind, owner_id: doc.ownerId, type: doc.type, status: "approved", reviewed_at: now, reviewed_by: "seed", created_at: now, updated_at: now, ...file })
        .onConflict((c) => c.columns(["owner_kind", "owner_id", "type"]).doUpdateSet({ status: "approved", reviewed_at: now, reviewed_by: "seed", updated_at: now, ...file }))
        .returning("document_id")
        .executeTakeFirstOrThrow();
      if (withFile) {
        const sealed = sealFile(documentKey, PLACEHOLDER_PNG);
        await trx.insertInto("document_files").values({ document_id: saved.document_id, ...sealed }).onConflict((c) => c.column("document_id").doUpdateSet(sealed)).execute();
      }
    }
  }

  // Riders: active, named.
  const riderIds = new Map<string, string>();
  for (const r of accounts.riders) {
    const existing = await trx.selectFrom("riders").select("rider_id").where("phone", "=", r.phone).executeTakeFirst();
    const riderId = existing?.rider_id ?? newId("rdr", now.getTime());
    if (!existing) await trx.insertInto("riders").values({ rider_id: riderId, phone: r.phone, email: r.email, language: "sv" }).execute();
    await trx.updateTable("riders").set({ first_name: r.firstName, email: r.email, email_verified_at: null, status: "active", updated_at: now }).where("rider_id", "=", riderId).execute();
    riderIds.set(r.phone, riderId);
  }
  return { fleetId, code: accounts.fleet.code, drivers: [...driverIds.entries()].map(([phone, driverId]) => ({ phone, driverId, vehicleId: vehicleIds.get(phone)! })), riders: [...riderIds.entries()].map(([phone, riderId]) => ({ phone, riderId })) };
}
