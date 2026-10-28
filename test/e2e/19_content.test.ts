import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PLACES, Sim, type Admin, type Driver, type Json, type Rider } from "./harness.js";

/** Contract v0.10.0 §19 Content (owner Content answers 2026-10-28): publish per zone, history, rollback, app reads, legal re-accept. */

let sim: Sim;
let rider: Rider;
let driver: Driver;
let owner: Admin;

beforeAll(async () => {
  sim = await Sim.start();
  rider = await sim.rider(0);
  driver = await sim.driver(1, null);
  owner = await sim.owner();
});
afterAll(async () => {
  await sim.stop();
});

const text = { sv: "Hej", fr: "Bonjour", en: "Hello" };
const later = () => new Date(sim.clock.now.getTime() + 3_600_000).toISOString();
const publish = (admin: Admin, slot: string, body: Json) => admin.post(`/admin/content/${slot}/publish`, { zoneIds: ["Z001"], title: "T", text, ...body });

describe("publish", () => {
  it("writes one version per chosen zone only, audited", async () => {
    const res = await publish(owner, "help", { zoneIds: ["Z001", "Z003"], title: "Help", image: "https://cdn.example/h.png" });
    expect(res.status).toBe(200);
    expect(res.body["items"]).toHaveLength(2);
    expect(res.body["items"][0]).toMatchObject({ slot: "help", zoneId: "Z001", version: 1, publishedBy: owner.id, title: "Help", text, image: "https://cdn.example/h.png" });
    expect((await owner.get("/admin/content?zoneId=Z003")).body["items"]).toHaveLength(1);
    expect((await owner.get("/admin/content?zoneId=Z002")).body["items"]).toEqual([]);
    const audit = await sim.db.selectFrom("admin_audit").select("action").where("action", "=", "content.publish").execute();
    expect(audit.length).toBeGreaterThan(0);
  });

  it("refuses bad content", async () => {
    const cases: Array<[string, Json, string | undefined]> = [
      ["help", { text: { sv: "", fr: "a", en: "b" } }, undefined],
      ["help", { text: { sv: "a", fr: "b" } }, undefined],
      ["help", { image: "http://x.example/a.png" }, undefined],
      ["help", { expiresAt: new Date(sim.clock.now.getTime() - 1000).toISOString() }, "expires_in_past"],
      ["help", { reaccept: true }, "reaccept_not_legal"],
      ["help", { versions: { rider: { min: "1.0.0", recommended: "1.0.0" }, driver: { min: "1.0.0", recommended: "1.0.0" } } }, "versions_not_app_versions"],
      ["app-versions", {}, "versions_required"],
      ["app-versions", { versions: { rider: { min: "1.2.0", recommended: "1.1.9" }, driver: { min: "1.0.0", recommended: "1.0.0" } } }, "recommended_below_min"],
      ["app-versions", { versions: { rider: { min: "1.2", recommended: "1.3.0" }, driver: { min: "1.0.0", recommended: "1.0.0" } } }, undefined],
      ["nope", {}, undefined],
    ];
    for (const [slot, body, reason] of cases) {
      const res = await publish(owner, slot, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      if (reason) expect(res.body["reason"]).toBe(reason);
    }
  });

  it("an admin must cover every chosen zone", async () => {
    const limited = await sim.admin("super", ["Z002"]);
    const res = await publish(limited, "help", { zoneIds: ["Z002", "Z001"] });
    expect(res.status).toBe(403);
    expect((await owner.get("/admin/content?zoneId=Z002")).body["items"]).toEqual([]);
    expect((await limited.get("/admin/content?zoneId=Z001")).status).toBe(403);
  });
});

describe("history and rollback", () => {
  it("rollback publishes the earlier version again as the next version", async () => {
    await publish(owner, "driver-home", { title: "One" });
    await publish(owner, "driver-home", { title: "Two" });
    const rolled = await owner.post("/admin/content/driver-home/rollback", { zoneId: "Z001", version: 1 });
    expect(rolled.status).toBe(200);
    expect(rolled.body).toMatchObject({ version: 3, title: "One" });
    const history = (await owner.get("/admin/content/driver-home/history?zoneId=Z001")).body["items"] as Json[];
    expect(history.map((i) => [i["version"], i["title"]])).toEqual([[3, "One"], [2, "Two"], [1, "One"]]);
    expect((await owner.post("/admin/content/driver-home/rollback", { zoneId: "Z001", version: 9 })).status).toBe(404);
  });
});

describe("app reads", () => {
  it("each app gets its own places and the shared ones; expired items are left out", async () => {
    await publish(owner, "rider-banner-1", { title: "Banner", expiresAt: later() });
    await publish(owner, "app-versions", { versions: { rider: { min: "1.0.0", recommended: "1.2.0" }, driver: { min: "2.0.0", recommended: "2.0.0" } } });
    const r = (await rider.get("/rider/content?zoneId=Z001")).body["items"] as Json[];
    expect(r.map((i) => i["slot"]).sort()).toEqual(["app-versions", "help", "rider-banner-1"]);
    expect(r.find((i) => i["slot"] === "app-versions")!["versions"]).toMatchObject({ rider: { min: "1.0.0", recommended: "1.2.0" } });
    const d = (await driver.get("/driver/content")).body["items"] as Json[];
    expect(d.map((i) => i["slot"]).sort()).toEqual(["app-versions", "driver-home", "help"]);
    await sim.advance(3_700);
    const after = (await rider.get("/rider/content?zoneId=Z001")).body["items"] as Json[];
    expect(after.map((i) => i["slot"])).not.toContain("rider-banner-1");
    expect((await owner.get("/admin/content?zoneId=Z001")).body["items"].map((i: Json) => i["slot"])).toContain("rider-banner-1");
  });
});

describe("legal re-accept", () => {
  it("blocks booking and going online until accepted", async () => {
    const legal = await publish(owner, "legal", { title: "Terms", reaccept: true });
    const version = legal.body["items"][0]["version"] as number;
    const quotes = await rider.quote({ categoryIds: ["economy"] });
    const quote = quotes.body["quotes"][0];
    const book = await rider.post("/trips", { quoteId: quote.quoteId, categoryId: "economy", pickup: PLACES.sergels, dropoff: PLACES.medborgar, stops: [], kind: "live", paymentMethod: "cash" });
    expect(book.status).toBe(409);
    expect(book.body["reason"]).toBe("terms_not_accepted");
    const profile = (await driver.get("/driver/profile")).body;
    const online = await driver.post("/driver/availability", { expectedVersion: profile["version"], onlineStatus: "online", location: driver.fix(PLACES.nearSergels) });
    expect(online.status).toBe(409);
    expect(online.body["reason"]).toBe("terms_not_accepted");

    expect((await rider.post("/account/terms/accept", { contentVersion: version + 5 })).status).toBe(409);
    expect((await rider.post("/account/terms/accept", { contentVersion: version })).status).toBe(204);
    expect((await driver.post("/account/terms/accept", { contentVersion: version })).status).toBe(204);
    const acceptances = (await owner.get("/admin/content/legal/acceptances?zoneId=Z001")).body["items"] as Json[];
    expect(acceptances.map((a) => a["subjectId"]).sort()).toEqual([driver.id, rider.id].sort());
    expect(acceptances[0]).toMatchObject({ zoneId: "Z001", contentVersion: version });

    await rider.book();
    await driver.goOnline(PLACES.nearSergels);
  });
});
