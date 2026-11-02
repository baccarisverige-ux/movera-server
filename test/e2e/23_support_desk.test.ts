import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bookAndAccept, drive, fakeOsrm, PLACES, Sim, type Admin, type Driver, type Json, type Rider } from "./harness.js";

/**
 * Build-all A1 "Support desk" (contract v0.18.15 §37, contract.json#supportDesk; owner 2026-11-02
 * decisions/other-support-promos.md QO-1 chat-style replies, QO-2 "<first name> · Movera Support", QO-4 the same 7
 * topics in both apps, QO-5 claim / assign now; rule 16 admin settings with defaults). Fails before: none of these
 * routes or fields existed (404 / missing keys).
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
  agent = await sim.admin("support");
  ({ tripId } = await bookAndAccept(sim, rider, driver));
  await drive(driver, tripId, "in_trip");
  expect((await driver.command(tripId, "complete")).status).toBe(200);
});
afterAll(async () => {
  await sim.stop();
  await osrm.close();
});

const open = async (body: Json = {}) => {
  const res = await rider.post("/support/tickets", { tripId, category: "ride_dispute", subject: "Charged too much", text: "Long way.", ...body });
  expect(res.status).toBe(201);
  return res.body["ticketId"] as string;
};

describe("person replies chat-style (QO-1) and sees only the agent's first name (QO-2)", () => {
  it("the rider writes again after the answer; the ticket is open again; closed tickets refuse", async () => {
    const id = await open();
    const answer = await agent.post(`/admin/tickets/${id}/reply`, { text: "We look at it." });
    expect(answer.body["status"]).toBe("pending");
    expect(answer.body["messages"].at(-1)["adminName"]).toBe("support admin");
    const seen = await rider.get(`/support/tickets/${id}`);
    expect(seen.body["messages"].at(-1)).toMatchObject({ from: "support", adminName: "support", supportName: "support" });
    const again = await rider.post(`/support/tickets/${id}/messages`, { text: "Thanks, here is the receipt." });
    expect(again.status).toBe(201);
    expect(again.body).toMatchObject({ status: "open", messages: [{ from: "rider" }, { from: "support" }, { from: "rider", text: "Thanks, here is the receipt." }] });
    // another person's ticket is not found
    const other = await sim.rider(2);
    expect((await other.post(`/support/tickets/${id}/messages`, { text: "x" })).status).toBe(404);
    await agent.post(`/admin/tickets/${id}/reply`, { text: "Done.", status: "closed" });
    const closed = await rider.post(`/support/tickets/${id}/messages`, { text: "One more" });
    expect(closed.status).toBe(409);
    expect(closed.body["reason"]).toBe("ticket_closed");
  });

  it("an admin whose name is an e-mail shows no name to the person", async () => {
    const id = await open();
    await sim.db.updateTable("admins").set({ name: "agent.x@movera.test" }).where("admin_id", "=", owner.id).execute();
    await owner.post(`/admin/tickets/${id}/reply`, { text: "Hello" });
    const seen = (await rider.get(`/support/tickets/${id}`)).body["messages"].at(-1);
    expect(seen["adminName"]).toBeUndefined();
    expect(seen["supportName"]).toBeUndefined();
    expect(JSON.stringify(seen)).not.toContain("@");
  });

  it("a solved ticket reopens on a reply by default, and refuses when the setting says blocked", async () => {
    const id = await open();
    await agent.post(`/admin/tickets/${id}/solve`, { note: "private" });
    expect((await rider.post(`/support/tickets/${id}/messages`, { text: "Still wrong" })).body["status"]).toBe("open");
    const settings = (await owner.get("/admin/support/settings?country=SE")).body;
    expect((await owner.put("/admin/support/settings", { ...settings, replyAfterSolved: "blocked" })).status).toBe(200);
    await agent.post(`/admin/tickets/${id}/solve`, {});
    const blocked = await rider.post(`/support/tickets/${id}/messages`, { text: "x" });
    expect(blocked.body["reason"]).toBe("ticket_solved");
    await owner.put("/admin/support/settings", { ...settings, replyAfterSolved: "reopen" });
  });
});

describe("Admin › Support desk commands (QO-5)", () => {
  it("claim, another admin's claim conflicts, assign, topic, waiting, solve, reopen — all audited", async () => {
    const id = await open();
    const claimed = await agent.post(`/admin/tickets/${id}/claim`, {});
    expect(claimed.status).toBe(200);
    expect(claimed.body["assignedTo"]).toMatchObject({ adminId: agent.id, name: "support admin" });
    expect(new Date(claimed.body["claimedUntil"]).getTime() - sim.clock.now.getTime()).toBe(3 * 86_400_000);
    const other = await sim.admin("support");
    const taken = await other.post(`/admin/tickets/${id}/claim`, {});
    expect(taken.status).toBe(409);
    expect(taken.body["reason"]).toBe("ticket_claimed");
    expect((await agent.get("/admin/tickets?assignedTo=me")).body["items"].map((t: Json) => t["ticketId"])).toContain(id);
    expect((await other.get("/admin/tickets?assignedTo=none")).body["items"].map((t: Json) => t["ticketId"])).not.toContain(id);
    const viewer = await sim.admin("viewer");
    expect((await agent.post(`/admin/tickets/${id}/assign`, { adminId: viewer.id, reason: "x" })).body["reason"]).toBe("assignee_not_allowed");
    const assigned = await agent.post(`/admin/tickets/${id}/assign`, { adminId: other.id, reason: "Speaks French" });
    expect(assigned.body["assignedTo"]["adminId"]).toBe(other.id);
    expect((await other.post(`/admin/tickets/${id}/topic`, { category: "payment" })).body["category"]).toBe("payment");
    expect((await other.post(`/admin/tickets/${id}/waiting`, { waiting: true })).body["status"]).toBe("pending");
    expect((await other.post(`/admin/tickets/${id}/waiting`, { waiting: false })).body["status"]).toBe("open");
    const solved = await other.post(`/admin/tickets/${id}/solve`, { note: "Refund given" });
    expect(solved.body).toMatchObject({ status: "resolved", solvedBy: other.id });
    expect(JSON.stringify((await rider.get(`/support/tickets/${id}`)).body)).not.toContain("Refund given");
    expect((await other.post(`/admin/tickets/${id}/waiting`, { waiting: true })).body["reason"]).toBe("ticket_not_open");
    const reopened = await other.post(`/admin/tickets/${id}/reopen`, { reason: "Rider wrote again" });
    expect(reopened.body["status"]).toBe("open");
    expect(reopened.body["solvedBy"]).toBeUndefined();
    expect((await other.post(`/admin/tickets/${id}/reopen`, { reason: "x" })).body["reason"]).toBe("ticket_not_solved");
    const audit = await sim.db.selectFrom("admin_audit").select("action").where("target_id", "=", id).execute();
    expect(new Set(audit.map((a) => a.action))).toEqual(new Set(["ticket.claim", "ticket.assign", "ticket.topic", "ticket.waiting", "ticket.solve", "ticket.reopen"]));
    // outside the zones and without support.reply
    const z002 = await sim.admin("super", ["Z002"]);
    expect((await z002.post(`/admin/tickets/${id}/claim`, {})).status).toBe(403);
    expect((await viewer.post(`/admin/tickets/${id}/claim`, {})).status).toBe(403);
  });

  it("open a safety case from a ticket: a support_case incident on the trip, linked once", async () => {
    const id = await open();
    const res = await agent.post(`/admin/tickets/${id}/case`, { reason: "Rider felt unsafe" });
    expect(res.status).toBe(200);
    const incidentId = res.body["incidentId"];
    expect(incidentId).toMatch(/^inc_/);
    const incident = (await owner.get(`/admin/incidents/${incidentId}`)).body;
    expect(incident).toMatchObject({ kind: "support_case", severity: "medium", tripId });
    const id2 = await open();
    expect((await agent.post(`/admin/tickets/${id2}/case`, { reason: "same trip" })).body["incidentId"]).toBe(incidentId);
    const noTrip = await driver.post("/support/tickets", { category: "help", subject: "App", text: "?" });
    expect((await agent.post(`/admin/tickets/${noTrip.body["ticketId"]}/case`, { reason: "x" })).body["reason"]).toBe("ticket_without_trip");
  });
});

describe("Support settings per country (rule 16 defaults, QO-4 same topics in both apps)", () => {
  it("defaults, save, topics off reach both apps, opening on a topic that is off is refused", async () => {
    const audited = async () => (await sim.db.selectFrom("admin_audit").select("action").where("action", "=", "support.settings").execute()).length;
    const auditBefore = await audited();
    const se = await owner.get("/admin/support/settings?country=SE");
    expect(se.body).toMatchObject({ country: "SE", claimDays: 3, replyAfterSolved: "reopen" });
    expect(se.body["topics"].map((t: Json) => t["code"])).toEqual(["ride_dispute", "help", "lost_item", "payment", "account", "safety", "other"]);
    const fr = await owner.get("/admin/support/settings?country=FR");
    expect(fr.body["country"]).toBe("FR");
    expect((await rider.get("/support/topics")).body).toEqual({ country: "SE", topics: ["ride_dispute", "help", "lost_item", "payment", "account", "safety", "other"] });
    const topics = se.body["topics"].map((t: Json) => (t["code"] === "lost_item" ? { ...t, on: false } : t));
    const support = await sim.admin("support");
    expect((await support.put("/admin/support/settings", { ...se.body, topics })).status).toBe(403);
    const france = await sim.admin("config", ["FR-PC"]);
    expect((await france.put("/admin/support/settings", { ...se.body, topics })).body["reason"]).toBe("zone_out_of_scope");
    const saved = await owner.put("/admin/support/settings", { ...se.body, claimDays: 2, topics });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ claimDays: 2, updatedBy: owner.id });
    expect((await rider.get("/support/topics")).body["topics"]).not.toContain("lost_item");
    expect((await driver.get("/support/topics")).body["topics"]).not.toContain("lost_item");
    const off = await rider.post("/support/tickets", { category: "lost_item", subject: "Bag", text: "Left my bag" });
    expect(off.status).toBe(400);
    expect(off.body["reason"]).toBe("topic_off");
    expect((await owner.put("/admin/support/settings", { ...se.body, topics: topics.map((t: Json) => ({ ...t, on: false })) })).body["reason"]).toBe("topics_required");
    expect((await owner.put("/admin/support/settings", { ...se.body, topics: topics.slice(1) })).status).toBe(400);
    expect(await audited()).toBe(auditBefore + 1);
    await owner.put("/admin/support/settings", se.body);
  });
});

// Last: the clock jumps days ahead (sign-ins run out after this).
describe("time limits", () => {
  it("a claim runs out after claimDays; time limits and late flags follow the topic", async () => {
    const id = await open({ category: "safety" });
    await agent.post(`/admin/tickets/${id}/claim`, {});
    const view = (await agent.get(`/admin/tickets/${id}`)).body;
    expect(new Date(view["firstReplyDueAt"]).getTime() - new Date(view["createdAt"]).getTime()).toBe(5 * 60_000);
    expect(view["late"]).toEqual({ reply: false, solve: false });
    await sim.advance(6 * 60);
    expect((await agent.get(`/admin/tickets/${id}`)).body["late"]).toEqual({ reply: true, solve: false });
    sim.clock.now = new Date(sim.clock.now.getTime() + 3 * 86_400_000 + 1000);
    const later = (await agent.get(`/admin/tickets/${id}`)).body;
    expect(later["assignedTo"]).toBeUndefined();
    expect((await (await sim.admin("support")).post(`/admin/tickets/${id}/claim`, {})).status).toBe(200);
  });
});
