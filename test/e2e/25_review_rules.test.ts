import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bookAndAccept, drive, fakeOsrm, PLACES, Sim, type Admin, type Driver, type Json, type Rider } from "./harness.js";

/**
 * Review rules applied by the server (contract v0.18.15 §40, contract.json#reviewRules; owner 2026-11-02 G14 Q6
 * "Make them real"). Fails before: no /admin/reviews routes, bad words were not hidden and nothing happened at the lines.
 */

let sim: Sim;
let osrm: Awaited<ReturnType<typeof fakeOsrm>>;
let rider: Rider;
let driver: Driver;
let owner: Admin;

async function ratedTrip(stars: number, comment?: string): Promise<string> {
  const { tripId } = await bookAndAccept(sim, rider, driver);
  await drive(driver, tripId, "in_trip");
  expect((await driver.command(tripId, "complete")).status).toBe(200);
  const res = await rider.post(`/trips/${tripId}/rating`, { stars, ...(comment ? { comment } : {}) });
  expect(res.status).toBe(201);
  return tripId;
}

beforeAll(async () => {
  osrm = await fakeOsrm({ distance: 8000, duration: 1080 });
  sim = await Sim.start({ osrmUrl: osrm.url, now: new Date("2026-10-26T09:00:00Z") });
  rider = await sim.rider(0);
  driver = await sim.driver(1, PLACES.nearSergels);
  owner = await sim.owner();
});
afterAll(async () => {
  await sim.stop();
  await osrm.close();
});

describe("review rules per country", () => {
  it("defaults, save with checks, scope", async () => {
    const se = await owner.get("/admin/reviews/rules?country=SE");
    expect(se.body).toMatchObject({ country: "SE", warn: { on: true, below: 4.5 }, review: { on: true, below: 4.2 }, block: { on: false, below: 3.6 }, minReviews: 3, badWords: { on: true, words: ["idiot", "stupid", "scam"] } });
    expect((await owner.put("/admin/reviews/rules", { ...se.body, review: { on: true, below: 4.8 } })).status).toBe(400);
    const france = await sim.admin("config", ["FR-PC"]);
    expect((await france.put("/admin/reviews/rules", se.body)).body["reason"]).toBe("zone_out_of_scope");
    const saved = await owner.put("/admin/reviews/rules", { ...se.body, block: { on: true, below: 3 }, badWords: { on: true, words: ["idiot", "Arsel"] } });
    expect(saved.body).toMatchObject({ block: { on: true, below: 3 }, badWords: { words: ["idiot", "arsel"] }, updatedBy: owner.id });
  });

  it("a bad word hides the rating at once; it does not count", async () => {
    const tripId = await ratedTrip(1, "What an ARSEL driver");
    const ratings = (await owner.get("/admin/ratings")).body["items"] as Json[];
    expect(ratings.find((r) => r["tripId"] === tripId)).toMatchObject({ hidden: true });
    const profile = (await owner.get(`/admin/drivers/${driver.id}`)).body;
    expect(profile["ratingCount"] ?? 0).toBe(0);
  });

  it("warning after minReviews below the line, review list, then block suspends the driver; once per crossing", async () => {
    await ratedTrip(5);
    await ratedTrip(4);
    await ratedTrip(4); // 4.33 after 3: below warn 4.5 -> warning
    const notices = await sim.db.selectFrom("notifications").select(["kind", "title"]).where("subject_id", "=", driver.id).where("kind", "=", "review_warning").execute();
    expect(notices).toHaveLength(1);
    await ratedTrip(4); // 4.25: still warn, no second notice
    expect(await sim.db.selectFrom("notifications").select("kind").where("subject_id", "=", driver.id).where("kind", "=", "review_warning").execute()).toHaveLength(1);
    await ratedTrip(3); // 4.0: below review 4.2 -> review list
    const queue = (await owner.get("/admin/reviews/queue")).body["items"] as Json[];
    expect(queue).toEqual([expect.objectContaining({ who: "driver", personId: driver.id, level: "review", average: 4, count: 5 })]);
    expect((await sim.db.selectFrom("drivers").select("account_status").where("driver_id", "=", driver.id).executeTakeFirstOrThrow()).account_status).toBe("active");
    await ratedTrip(1);
    await ratedTrip(1); // 3.14 < ... still >= 3? sum 22/7 = 3.14 -> review
    await ratedTrip(1); // 23/8 = 2.88 < 3 -> block
    expect((await sim.db.selectFrom("drivers").select("account_status").where("driver_id", "=", driver.id).executeTakeFirstOrThrow()).account_status).toBe("suspended");
    const blocked = (await owner.get("/admin/reviews/queue")).body["items"] as Json[];
    expect(blocked[0]).toMatchObject({ level: "block", personId: driver.id });
    const support = await sim.admin("support");
    expect((await support.post(`/admin/reviews/queue/driver/${driver.id}/done`, { note: "x" })).status).toBe(403);
    const done = await owner.post(`/admin/reviews/queue/driver/${driver.id}/done`, { note: "Called the driver" });
    expect(done.body["items"]).toEqual([]);
    const audit = await sim.db.selectFrom("admin_audit").select("action").where("target_id", "=", driver.id).where("action", "like", "reviews.%").execute();
    expect(audit.map((a) => a.action).sort()).toEqual(["reviews.block", "reviews.done", "reviews.review", "reviews.warn"]);
  });
});
