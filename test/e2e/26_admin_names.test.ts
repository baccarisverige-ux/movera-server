import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bookAndAccept, drive, fakeOsrm, PLACES, Sim, type Admin, type Driver, type Json, type Rider } from "./harness.js";

/**
 * A1 live fix (contract v0.18.18 §43, contract.json#adminNames; owner 2026-11-03 "Real name from Team"): every admin
 * has a first name set in Team; an e-mail is never shown as a name in the admin; the panel shows "Admin" until set.
 * Fails before: no firstName, no /admin/agents, and names were the admins' name field (e-mails on live).
 */

let sim: Sim;
let osrm: Awaited<ReturnType<typeof fakeOsrm>>;
let rider: Rider;
let driver: Driver;
let owner: Admin;
let agent: Admin;
let tripId: string;

beforeAll(async () => {
  osrm = await fakeOsrm({ distance: 8000, duration: 1080 });
  sim = await Sim.start({ osrmUrl: osrm.url, now: new Date("2026-10-26T09:00:00Z") });
  rider = await sim.rider(0);
  driver = await sim.driver(1, PLACES.nearSergels);
  owner = await sim.owner();
  agent = await sim.admin("support", ["Z001"]);
  // The live case: the account name is an e-mail.
  await sim.db.updateTable("admins").set({ name: "agent.x@movera.test" }).where("admin_id", "=", agent.id).execute();
  ({ tripId } = await bookAndAccept(sim, rider, driver));
  await drive(driver, tripId, "in_trip");
  await driver.command(tripId, "complete");
});
afterAll(async () => {
  await sim.stop();
  await osrm.close();
});

describe("admin first names (owner \"Real name from Team\")", () => {
  it("own first name in AdminMe; never an e-mail; null clears it", async () => {
    expect((await agent.get("/admin/auth/me")).body["firstName"]).toBeUndefined();
    expect((await agent.send("PATCH", "/admin/auth/me", { firstName: "nora@movera.test" })).status).toBe(400);
    const set = await agent.send("PATCH", "/admin/auth/me", { firstName: " Nora " });
    expect(set.body["firstName"]).toBe("Nora");
    expect((await agent.send("PATCH", "/admin/auth/me", { language: "sv" })).body).toMatchObject({ firstName: "Nora", language: "sv" });
    const audit = await sim.db.selectFrom("admin_audit").select("action").where("target_id", "=", agent.id).where("action", "=", "admin.first_name").execute();
    expect(audit).toHaveLength(1);
  });

  it("support and alert names are the first name, never the e-mail; 'Admin' (absent) until set", async () => {
    const ticket = await rider.post("/support/tickets", { tripId, category: "help", subject: "Hi", text: "Hi" });
    const id = ticket.body["ticketId"];
    await agent.post(`/admin/tickets/${id}/claim`, {});
    const view = (await owner.get(`/admin/tickets/${id}`)).body;
    expect(view["assignedTo"]).toEqual({ adminId: agent.id, name: "Nora" });
    const answered = await agent.post(`/admin/tickets/${id}/reply`, { text: "Hej" });
    expect(answered.body["messages"].at(-1)).toMatchObject({ adminName: "Nora" });
    expect((await rider.get(`/support/tickets/${id}`)).body["messages"].at(-1)).toMatchObject({ supportName: "Nora" });
    const settings = (await owner.get("/admin/support/settings?country=SE")).body;
    expect(JSON.stringify(settings["agents"])).not.toContain("@");
    expect(settings["agents"]).toContainEqual({ adminId: agent.id, name: "Nora" });
    const book = (await owner.get("/admin/alerts/book?country=SE")).body;
    expect(JSON.stringify(book["people"])).not.toContain("@");
    expect(book["people"]).toContainEqual({ adminId: owner.id });
  });

  it("Team: the list never has e-mails; a Super admin names anyone; others need team.edit", async () => {
    const list = await owner.get("/admin/agents");
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain("@");
    expect(list.body["items"]).toContainEqual(expect.objectContaining({ adminId: agent.id, firstName: "Nora", role: "support" }));
    expect((await agent.get("/admin/agents")).status).toBe(403);
    expect((await agent.send("PATCH", `/admin/agents/${owner.id}`, { firstName: "Boss" })).status).toBe(403);
    const named = await owner.send("PATCH", `/admin/agents/${agent.id}`, { firstName: "Nora L" });
    expect(named.body).toMatchObject({ adminId: agent.id, firstName: "Nora L" });
    expect((await owner.send("PATCH", `/admin/agents/${agent.id}`, { firstName: "x@y.se" })).status).toBe(400);
    // Checker MED1 / LOW6: role super sees every admin (another zone too), sorted by first name; null clears a name.
    const far = await sim.admin("support", ["FR-PC"]);
    await owner.send("PATCH", `/admin/agents/${far.id}`, { firstName: "Anna" });
    const sorted = ((await owner.get("/admin/agents")).body["items"] as Json[]).filter((i) => i["firstName"]).map((i) => i["firstName"]);
    expect(sorted).toEqual([...sorted].sort((a, b) => String(a).localeCompare(String(b), "sv")));
    expect(sorted).toContain("Anna");
    expect((await owner.send("PATCH", `/admin/agents/${agent.id}`, { firstName: null })).body["firstName"]).toBeUndefined();
    const items = (await owner.get("/admin/agents")).body["items"] as Json[];
    expect(items.find((i) => i["adminId"] === agent.id)).not.toHaveProperty("firstName");
  });
});
