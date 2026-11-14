import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "../../src/auth/guard.js";
import { driverPaidMovera } from "../../src/admin/driversOwing.js";
import { fleetEarnings } from "../../src/drivers/onboarding.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver } from "../support/seed.js";

/**
 * J8 supervisor MF1 (Rules audits/impact/j8-rebase-money-fix-supervisor.md): GET /driver/fleet/earnings (the fleet
 * owner's view) shows each driver's EARNINGS (contract `fleets`: "Fleet views get only the driver earnings"; owner
 * decisions/session-2026-11-06.md:1277 "Driver gets = his earnings for the period"). A "Driver paid Movera" entry
 * (kind paid_to_movera, debtModel.driverOwes.paidMovera) is money FROM the driver, never earnings.
 */

let database: TestDatabase;
const SUPER: Principal = { actor: "admin", subjectId: "adm_j8fe", sessionId: "s_j8fe", zones: ["*"], role: "super", perms: [] } as unknown as Principal;
const FROM = new Date("2026-11-09T00:00:00Z");
const TRIP_AT = new Date("2026-11-10T10:00:00Z");
const PAID_AT = new Date("2026-11-11T09:00:00Z");
const NOW = new Date("2026-11-12T09:00:00Z");
type Money = { amountMinor: number; currency: string };
const m = (amountMinor: number, currency: string): Money => ({ amountMinor, currency });

let n = 0;
/** A fleet in `country` owned by a new driver, with one more member; both linked. */
async function fleet(country: "SE" | "TN") {
  const owner = await insertDriver(database.db);
  const member = await insertDriver(database.db);
  const fleetId = `flt_j8fe_${++n}`;
  await database.db.insertInto("fleets").values({ fleet_id: fleetId, name: "J8 Taxi", org_number: "556677-8899", country, city_id: country === "SE" ? "stockholm_lan" : "tunis", zone_id: country === "SE" ? "Z001" : "TN-TC", owner_driver_id: owner, status: "approved" }).execute();
  await database.db.updateTable("drivers").set({ fleet_id: fleetId, fleet_linked_at: FROM, country }).where("driver_id", "in", [owner, member]).execute();
  return { owner, member };
}
/** A cash trip entry: he collected `cash` and earns `earnings`, so he owes Movera the difference. */
const cashTrip = (driverId: string, currency: string, earnings: number, cash: number) =>
  database.db.insertInto("earnings_entries").values({ entry_id: `ern_j8fe_${++n}`, driver_id: driverId, trip_id: null, kind: "trip", currency, amount_minor: earnings, gross_minor: null, commission_minor: null, cash_minor: cash, at: TRIP_AT }).execute();
const paidMovera = (driverId: string, owed: Money, amount: Money) =>
  database.db.transaction().execute((trx) => driverPaidMovera(trx, SUPER, driverId, { expectedOwed: owed, amount, reason: "Bank transfer" }, PAID_AT));
const view = (ownerId: string) => fleetEarnings(database.db, ownerId, { from: FROM.toISOString(), to: NOW.toISOString() }, NOW);

beforeAll(async () => {
  database = await freshDatabase();
});
afterAll(async () => {
  await database.drop();
});

describe("J8 MF1: the fleet owner's earnings leave out Driver paid Movera", () => {
  it("SEK: a 200 kr cash trip, he earns 160 kr and pays the 40 kr he owes: the fleet shows 160 kr, not 200 kr", async () => {
    const { owner, member } = await fleet("SE");
    await cashTrip(member, "SEK", 16_000, 20_000);
    expect((await view(owner)).total).toEqual(m(16_000, "SEK"));
    await paidMovera(member, m(4_000, "SEK"), m(4_000, "SEK"));
    const after = await view(owner);
    // Fail-before (the supervisor probe): 20 000 = his 160 kr earnings + the 40 kr he PAID Movera.
    expect(after.items.find((i) => i.driverId === member)).toMatchObject({ trips: 1, earnings: m(16_000, "SEK") });
    expect(after.items.find((i) => i.driverId === owner)).toMatchObject({ trips: 0, earnings: m(0, "SEK") });
    expect(after.total).toEqual(m(16_000, "SEK"));
  });

  it("TND (3 decimals): a 22.000 DT cash trip, he earns 16.000 DT and pays the 6.000 DT he owes: the fleet stays 16.000 DT", async () => {
    const { owner } = await fleet("TN");
    // The owner drives too: his own entries are in the fleet view.
    await cashTrip(owner, "TND", 16_000, 22_000);
    expect((await view(owner)).total).toEqual(m(16_000, "TND"));
    await paidMovera(owner, m(6_000, "TND"), m(6_000, "TND"));
    const after = await view(owner);
    // Fail-before: 22.000 DT.
    expect(after.items.find((i) => i.driverId === owner)).toMatchObject({ trips: 1, earnings: m(16_000, "TND") });
    expect(after.total).toEqual(m(16_000, "TND"));
  });
});
