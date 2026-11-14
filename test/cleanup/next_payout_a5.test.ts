import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { driverPayouts, holdDriverPayouts } from "../../src/admin/payouts.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver } from "../support/seed.js";

/**
 * Job A5 / BQ-M13 (contract v0.18.94 payouts.schedule.nextPayout; owner G10-2 "Admin sets day and time (Recommended)" …
 * "driver app shows next payout", Rules decisions/driver-g10.md:6): GET /driver/payouts tells the driver when his next
 * payout is made — nextPayoutAt (UTC), nextPayoutLocal (wall clock in his payout time zone) and nextPayoutTimeZone — the end
 * of his period that holds now, from the country standard's CountryRules.payoutSchedule (the admin setting, Settings ›
 * Payouts), in his first zone's time zone, else his country's. Absent while his payouts are paused. SE (SEK), FR, TN; the
 * numbers are the contract's nextPayout.examples (the server keeps its 0.18.89 copy until the copy job, Rule 43(4), as A7 did).
 */

let database: TestDatabase;
beforeAll(async () => {
  database = await freshDatabase();
});
afterAll(async () => database.drop());
beforeEach(async () => {
  await database.db.deleteFrom("config_live").where("doc", "=", "country_rules").execute();
});

const NOW = new Date("2026-11-14T17:00:00Z"); // a Saturday
const driverIn = async (zoneIds: string[], country: string | null) => {
  const id = await insertDriver(database.db);
  await database.db.updateTable("drivers").set({ zone_ids: zoneIds, country }).where("driver_id", "=", id).execute();
  return id;
};
const schedule = (country: string, payoutSchedule: Record<string, string>) =>
  database.db.insertInto("config_live").values({ doc: "country_rules", zone_id: `standard-${country}`, version: 1, document: JSON.stringify({ country, payoutSchedule }), published_at: NOW, published_by: null }).execute();
const next = async (driverId: string, now: Date = NOW) => {
  const page = (await driverPayouts(database.db, driverId, { limit: 10 }, now)) as Record<string, unknown>;
  return [page["nextPayoutAt"], page["nextPayoutLocal"], page["nextPayoutTimeZone"]];
};

describe("A5: GET /driver/payouts sends the driver's next payout (contract v0.18.94)", () => {
  it("SE default (weekly, Monday 08:00, Stockholm): Saturday → Mon 2026-11-16 08:00 local = 07:00Z; also with no payout yet", async () => {
    const id = await driverIn(["Z001"], "SE");
    expect(await next(id)).toEqual(["2026-11-16T07:00:00.000Z", "2026-11-16T08:00", "Europe/Stockholm"]);
    // Summer time: Monday 08:00 CEST = 06:00Z.
    expect(await next(id, new Date("2026-06-03T12:00:00Z"))).toEqual(["2026-06-08T06:00:00.000Z", "2026-06-08T08:00", "Europe/Stockholm"]);
    // Exactly at the payout moment the next one is a week later (the job pays the period that just ended).
    expect(await next(id, new Date("2026-11-16T07:00:00Z"))).toEqual(["2026-11-23T07:00:00.000Z", "2026-11-23T08:00", "Europe/Stockholm"]);
  });

  it("FR admin setting every 2 weeks, Friday 18:30 (Paris): → Fri 2026-11-27 18:30 local (contract example FR)", async () => {
    await schedule("FR", { frequency: "every_2_weeks", day: "friday", time: "18:30" });
    const id = await driverIn(["FR-PC"], "FR");
    expect(await next(id)).toEqual(["2026-11-27T17:30:00.000Z", "2026-11-27T18:30", "Europe/Paris"]);
  });

  it("TN driver without a zone: his country's time zone (Africa/Tunis), never Stockholm; an admin change shows at the next read", async () => {
    const id = await driverIn([], "TN");
    expect(await next(id)).toEqual(["2026-11-16T07:00:00.000Z", "2026-11-16T08:00", "Africa/Tunis"]);
    await schedule("TN", { frequency: "weekly", day: "wednesday", time: "10:15" });
    expect(await next(id)).toEqual(["2026-11-18T09:15:00.000Z", "2026-11-18T10:15", "Africa/Tunis"]);
  });

  it("paused payouts (payoutHold): no next payout is sent (absent, never null); released → sent again", async () => {
    const id = await driverIn(["Z001"], "SE");
    const who = { actor: "admin", subjectId: "adm_a5", sessionId: "ses_a5", role: "super", zones: ["*"] } as never;
    await database.db.transaction().execute((trx) => holdDriverPayouts(trx, who, id, { held: true, reason: "check" }, NOW));
    const page = (await driverPayouts(database.db, id, { limit: 10 }, NOW)) as Record<string, unknown>;
    expect("nextPayoutAt" in page || "nextPayoutLocal" in page || "nextPayoutTimeZone" in page).toBe(false);
    expect(page["items"]).toEqual([]);
    await database.db.transaction().execute((trx) => holdDriverPayouts(trx, who, id, { held: false, reason: "ok" }, NOW));
    expect((await next(id))[0]).toBe("2026-11-16T07:00:00.000Z");
  });
});
