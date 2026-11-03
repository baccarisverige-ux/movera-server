import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bookAndAccept, drive, fakeOsrm, PLACES, Sim, type Admin, type Driver, type Json, type Rider } from "./harness.js";
import { countryOfPhone } from "../../src/support/desk.js";

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

/** Checker LOW: a save carries the rev it read (the owner's read, so another admin's refusal still shows). */
async function putSettings(who: Admin, body: Json) {
  const current = await owner.get(`/admin/support/settings?country=${String(body["country"] ?? "SE")}`);
  return who.put("/admin/support/settings", { ...body, expectedRev: current.body["rev"] });
}

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

  it("owner: a solved ticket takes no more messages (ticket_solved); the person opens a new one", async () => {
    const id = await open();
    await agent.post(`/admin/tickets/${id}/solve`, { note: "private" });
    const refused = await rider.post(`/support/tickets/${id}/messages`, { text: "Still wrong" });
    expect(refused.status).toBe(409);
    expect(refused.body["reason"]).toBe("ticket_solved");
    expect((await rider.get(`/support/tickets/${id}`)).body["status"]).toBe("resolved");
    expect((await open()).length).toBeGreaterThan(0);
  });

  it("owner: no stars after solve, an optional comment once; admins see it", async () => {
    const id = await open();
    expect((await rider.post(`/support/tickets/${id}/feedback`, { text: "x" })).body["reason"]).toBe("ticket_not_solved");
    await agent.post(`/admin/tickets/${id}/solve`, {});
    const given = await rider.post(`/support/tickets/${id}/feedback`, { text: " Quick help, thanks! " });
    expect(given.status).toBe(201);
    expect(given.body["feedback"]).toMatchObject({ text: "Quick help, thanks!" });
    expect((await rider.post(`/support/tickets/${id}/feedback`, { text: "again" })).body["reason"]).toBe("feedback_given");
    expect((await agent.get(`/admin/tickets/${id}`)).body["feedback"]).toMatchObject({ text: "Quick help, thanks!" });
    expect((await driver.post(`/support/tickets/${id}/feedback`, { text: "x" })).status).toBe(404);
  });
});

describe("Admin › Support desk commands (QO-5)", () => {
  it("claim, another admin's claim conflicts, assign, topic, waiting, solve, reopen — all audited", async () => {
    const id = await open();
    const claimed = await agent.post(`/admin/tickets/${id}/claim`, {});
    expect(claimed.status).toBe(200);
    expect(claimed.body["assignedTo"]).toMatchObject({ adminId: agent.id, name: "support admin" });
    expect(claimed.body).not.toHaveProperty("claimedUntil");
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
    expect(se.body).toMatchObject({ country: "SE" });
    expect(se.body).not.toHaveProperty("claimDays");
    expect(se.body).not.toHaveProperty("replyAfterSolved");
    expect(se.body["topics"].map((t: Json) => t["code"])).toEqual(["ride_dispute", "help", "lost_item", "payment", "account", "safety", "other"]);
    const fr = await owner.get("/admin/support/settings?country=FR");
    expect(fr.body["country"]).toBe("FR");
    expect((await rider.get("/support/topics")).body).toEqual({ country: "SE", topics: ["ride_dispute", "help", "lost_item", "payment", "account", "safety", "other"] });
    const topics = se.body["topics"].map((t: Json) => (t["code"] === "lost_item" ? { ...t, on: false } : t));
    const support = await sim.admin("support");
    expect((await putSettings(support, { ...se.body, topics })).status).toBe(403);
    const france = await sim.admin("config", ["FR-PC"]);
    expect((await putSettings(france, { ...se.body, topics })).body["reason"]).toBe("zone_out_of_scope");
    expect((await (await sim.admin("support", ["FR-PC"])).get("/admin/support/settings?country=SE")).body["reason"]).toBe("zone_out_of_scope");
    const saved = await putSettings(owner, { ...se.body, topics });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ updatedBy: owner.id });
    expect((await rider.get("/support/topics")).body["topics"]).not.toContain("lost_item");
    expect((await driver.get("/support/topics")).body["topics"]).not.toContain("lost_item");
    const off = await rider.post("/support/tickets", { category: "lost_item", subject: "Bag", text: "Left my bag" });
    expect(off.status).toBe(400);
    expect(off.body["reason"]).toBe("topic_off");
    expect((await putSettings(owner, { ...se.body, topics: topics.map((t: Json) => ({ ...t, on: false })) })).body["reason"]).toBe("topics_required");
    expect((await putSettings(owner, { ...se.body, topics: topics.slice(1) })).status).toBe(400);
    // Checker LOW: a stale revision is refused.
    expect((await owner.put("/admin/support/settings", { ...se.body, expectedRev: 1 })).body["code"]).toBe("version_mismatch");
    expect(await audited()).toBe(auditBefore + 1);
    await putSettings(owner, se.body);
  });
});

describe("owner \"Leave ticket\": the claiming admin gives the ticket back to the queue", () => {
  it("only the admin who works on it can leave it; then any admin can claim it", async () => {
    const id = await open();
    await agent.post(`/admin/tickets/${id}/claim`, {});
    const other = await sim.admin("support");
    expect((await other.post(`/admin/tickets/${id}/leave`, {})).body["reason"]).toBe("ticket_not_yours");
    const left = await agent.post(`/admin/tickets/${id}/leave`, {});
    expect(left.status).toBe(200);
    expect(left.body["assignedTo"]).toBeUndefined();
    expect((await other.get("/admin/tickets?assignedTo=none")).body["items"].map((x: Json) => x["ticketId"])).toContain(id);
    expect((await other.post(`/admin/tickets/${id}/claim`, {})).body["assignedTo"]).toMatchObject({ adminId: other.id });
    const audit = await sim.db.selectFrom("admin_audit").select("action").where("target_id", "=", id).where("action", "=", "ticket.leave").execute();
    expect(audit).toHaveLength(1);
  });

  it("checker MED1: only the claiming admin acts on a claimed ticket (no override)", async () => {
    const id = await open();
    await agent.post(`/admin/tickets/${id}/claim`, {});
    const other = await sim.admin("support");
    const tries = [
      other.post(`/admin/tickets/${id}/reply`, { text: "Hi" }),
      other.post(`/admin/tickets/${id}/assign`, { adminId: other.id, reason: "mine now" }),
      other.post(`/admin/tickets/${id}/solve`, {}),
      other.post(`/admin/tickets/${id}/topic`, { category: "payment" }),
      other.post(`/admin/tickets/${id}/waiting`, { waiting: true }),
      owner.post(`/admin/tickets/${id}/solve`, {}),
      (async () => (await sim.admin("ops")).post(`/admin/tickets/${id}/claim`, {}))(),
    ];
    for (const res of await Promise.all(tries)) expect([res.status]).toEqual([409]);
    expect((await agent.post(`/admin/tickets/${id}/reply`, { text: "On it" })).status).toBe(200);
    await agent.post(`/admin/tickets/${id}/solve`, {});
    expect((await other.post(`/admin/tickets/${id}/reopen`, { reason: "x" })).body["reason"]).toBe("ticket_not_yours");
    // Owner 2026-11-03: a Super admin can take over another admin's claim (audited); then only he acts.
    const id2 = await open();
    await agent.post(`/admin/tickets/${id2}/claim`, {});
    const taken = await owner.post(`/admin/tickets/${id2}/claim`, {});
    expect(taken.body["assignedTo"]).toMatchObject({ adminId: owner.id });
    expect((await agent.post(`/admin/tickets/${id2}/reply`, { text: "x" })).body["reason"]).toBe("ticket_not_yours");
    const takeover = await sim.db.selectFrom("admin_audit").select(["action", "detail"]).where("target_id", "=", id2).where("action", "=", "ticket.takeover").execute();
    expect(takeover).toHaveLength(1);
    expect(takeover[0]!.detail).toMatchObject({ from: agent.id });
    // Checker LOW: a solved ticket cannot be claimed.
    await agent.post(`/admin/tickets/${id}/leave`, {});
    expect((await other.post(`/admin/tickets/${id}/claim`, {})).body["reason"]).toBe("ticket_not_open");
  });
});

describe("owner \"Yes\": ready replies per language in Support settings", () => {
  it("none by default; saved per country; kept when a save leaves them out; ids unique; sv/fr/en only", async () => {
    const se = (await owner.get("/admin/support/settings?country=SE")).body;
    expect(se["replies"]).toEqual([]);
    const replies = [{ id: "hello-sv", lang: "sv", title: "Första svar", text: " Hej! Vi tittar på det nu. " }, { id: "hello-en", lang: "en", title: "First answer", text: "Hi! We are looking at it now." }];
    const saved = await putSettings(owner, { ...se, replies });
    expect(saved.body["replies"]).toEqual([{ ...replies[0], text: "Hej! Vi tittar på det nu." }, replies[1]]);
    const { replies: _left, ...withoutReplies } = saved.body;
    expect((await putSettings(owner, withoutReplies)).body["replies"]).toHaveLength(2);
    expect((await putSettings(owner, { ...se, replies: [replies[0], replies[0]] })).status).toBe(400);
    expect((await putSettings(owner, { ...se, replies: [{ ...replies[0], lang: "de" }] })).status).toBe(400);
    expect((await owner.get("/admin/support/settings?country=FR")).body["replies"]).toEqual([]);
    await putSettings(owner, { ...se, replies: [] });
  });
});

describe("owner \"Yes, by topic\": new tickets land with the admin set for their topic", () => {
  it("lost items go to the chosen agent; nobody when he cannot work on the zone; a viewer cannot be chosen", async () => {
    const se = (await owner.get("/admin/support/settings?country=SE")).body;
    const lostAgent = await sim.admin("support", ["Z001"]);
    // Checker LOW: the settings list only admins who may get tickets in this country.
    const agents = (await owner.get("/admin/support/settings?country=SE")).body["agents"].map((a: Json) => a["adminId"]);
    expect(agents).toContain(lostAgent.id);
    expect(agents).not.toContain((await sim.admin("viewer")).id);
    expect(agents).not.toContain((await sim.admin("support", ["FR-PC"])).id);
    const withAssign = (adminId: string) => se["topics"].map((x: Json) => (x["code"] === "lost_item" ? { ...x, assignTo: adminId } : x));
    const viewer = await sim.admin("viewer");
    expect((await putSettings(owner, { ...se, topics: withAssign(viewer.id) })).body["reason"]).toBe("assignee_not_allowed");
    expect((await putSettings(owner, { ...se, topics: withAssign(lostAgent.id) })).status).toBe(200);
    const sorted = await open({ category: "lost_item" });
    expect((await owner.get(`/admin/tickets/${sorted}`)).body["assignedTo"]).toMatchObject({ adminId: lostAgent.id });
    const other = await open({ category: "payment" });
    expect((await owner.get(`/admin/tickets/${other}`)).body["assignedTo"]).toBeUndefined();
    const france = await sim.admin("support", ["FR-PC"]);
    expect((await putSettings(owner, { ...se, topics: withAssign(france.id) })).body["reason"]).toBe("assignee_not_allowed");
    const elsewhere = await sim.admin("support", ["Z002"]);
    await putSettings(owner, { ...se, topics: withAssign(elsewhere.id) });
    const notCovered = await open({ category: "lost_item" });
    expect((await owner.get(`/admin/tickets/${notCovered}`)).body["assignedTo"]).toBeUndefined();
    await putSettings(owner, se);
  });
});

describe("owner: a person without a country gets it from the phone prefix", () => {
  it("+33 without a trip reads the French topics; +216 Tunisia; unknown prefixes nothing", async () => {
    expect([countryOfPhone("+46701740605"), countryOfPhone("+33612345678"), countryOfPhone("+21620123456"), countryOfPhone("+4930123"), countryOfPhone(null)]).toEqual(["SE", "FR", "TN", null, null]);
    const newcomer = await sim.rider(1);
    await sim.db.updateTable("riders").set({ phone: "+33612345678" }).where("rider_id", "=", newcomer.id).execute();
    const fr = (await owner.get("/admin/support/settings?country=FR")).body;
    await putSettings(owner, { ...fr, topics: fr["topics"].map((x: Json) => (x["code"] === "payment" ? { ...x, on: false } : x)) });
    const topics = (await newcomer.get("/support/topics")).body;
    expect(topics["country"]).toBe("FR");
    expect(topics["topics"]).not.toContain("payment");
    expect((await newcomer.post("/support/tickets", { category: "payment", subject: "x", text: "x" })).body["reason"]).toBe("topic_off");
    await putSettings(owner, fr);
    // Owner 2026-11-03: the zone-less ticket goes to the French team (phone prefix), not to Swedish support.
    const ticket = await newcomer.post("/support/tickets", { category: "help", subject: "Aide", text: "Bonjour" });
    expect(ticket.body["zoneId"]).toBeUndefined();
    const frAgent = await sim.admin("support", ["FR-PC"]);
    expect((await frAgent.get(`/admin/tickets/${ticket.body["ticketId"]}`)).status).toBe(200);
    expect((await frAgent.get("/admin/tickets")).body["items"].map((x: Json) => x["ticketId"])).toContain(ticket.body["ticketId"]);
    const seAgent = await sim.admin("support", ["Z001"]);
    expect((await seAgent.get(`/admin/tickets/${ticket.body["ticketId"]}`)).body["reason"]).toBe("zone_out_of_scope");
    expect((await seAgent.get("/admin/tickets")).body["items"].map((x: Json) => x["ticketId"])).not.toContain(ticket.body["ticketId"]);
    expect((await owner.get(`/admin/tickets/${ticket.body["ticketId"]}`)).status).toBe(200);
  });
});

describe("Incidents settings and report (contract.json#incidentDesk)", () => {
  it("settings: safety.edit saves one revision at a time; every admin reads the same; a report download is audited", async () => {
    const first = await owner.get("/admin/incidents/settings?country=SE");
    expect(first.body).toMatchObject({ country: "SE", rev: 1, settings: {} });
    const france = await sim.admin("safety", ["FR-PC"]);
    expect((await france.put("/admin/incidents/settings", { country: "SE", expectedRev: 1, settings: {} })).body["reason"]).toBe("zone_out_of_scope");
    expect((await france.put("/admin/incidents/settings", { country: "FR", expectedRev: 1, settings: { lateAlerts: true } })).body["rev"]).toBe(2);
    const support = await sim.admin("support");
    expect((await support.put("/admin/incidents/settings", { country: "SE", expectedRev: 1, settings: { lateAlerts: false } })).status).toBe(403);
    const safety = await sim.admin("safety");
    const saved = await safety.put("/admin/incidents/settings", { country: "SE", expectedRev: 1, settings: { lateAlerts: false, emergency: { FR: [{ label: "SAMU", number: "15" }] } } });
    expect(saved.body).toMatchObject({ rev: 2, updatedBy: safety.id, settings: { lateAlerts: false } });
    expect((await safety.put("/admin/incidents/settings", { country: "SE", expectedRev: 1, settings: {} })).body["code"]).toBe("version_mismatch");
    expect((await owner.get("/admin/incidents/settings?country=SE")).body["settings"]).toMatchObject({ emergency: { FR: [{ number: "15" }] } });
    const id = await open();
    const incidentId = (await agent.post(`/admin/tickets/${id}/case`, { reason: "report test" })).body["incidentId"];
    expect((await safety.post(`/admin/incidents/${incidentId}/report`, {})).status).toBe(204);
    const z002 = await sim.admin("super", ["Z002"]);
    expect((await z002.post(`/admin/incidents/${incidentId}/report`, {})).status).toBe(403);
    const audit = await sim.db.selectFrom("admin_audit").select(["action", "admin_id"]).where("target_id", "=", incidentId).where("action", "=", "incident.report").execute();
    expect(audit).toEqual([{ action: "incident.report", admin_id: safety.id }]);
  });
});

// Last: the clock jumps days ahead (sign-ins run out after this).
describe("time limits", () => {
  it("owner \"Never\": a claim does not run out after days; time limits and late flags follow the topic", async () => {
    const id = await open({ category: "safety" });
    await agent.post(`/admin/tickets/${id}/claim`, {});
    const view = (await agent.get(`/admin/tickets/${id}`)).body;
    expect(new Date(view["firstReplyDueAt"]).getTime() - new Date(view["createdAt"]).getTime()).toBe(5 * 60_000);
    expect(view["late"]).toEqual({ reply: false, solve: false });
    await sim.advance(6 * 60);
    expect((await agent.get(`/admin/tickets/${id}`)).body["late"]).toEqual({ reply: true, solve: false });
    sim.clock.now = new Date(sim.clock.now.getTime() + 3 * 86_400_000 + 1000);
    const later = await sim.admin("support");
    expect((await later.get(`/admin/tickets/${id}`)).body["assignedTo"]).toMatchObject({ adminId: agent.id });
    expect((await later.post(`/admin/tickets/${id}/claim`, {})).body["reason"]).toBe("ticket_claimed");
  });
});
