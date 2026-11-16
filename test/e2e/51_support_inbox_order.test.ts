import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeOsrm, PLACES, Sim, type Admin, type Driver, type Json, type Rider } from "./harness.js";

/**
 * BQ-A04 (contract v0.18.112, contract.json#supportDesk.inboxOrder; owner item 109 "Yes, pages + oldest first (Rec.)",
 * Rules decisions/session-2026-11-06.md:1116): GET /admin/tickets lists the oldest-waiting ticket first
 * (SupportTicket.waitingSince = the first rider / driver message with no support answer after it, open tickets only),
 * then every other ticket newest change first; one cursor pages over both parts. Fails before: the list was newest
 * change first and waitingSince did not exist.
 */

let sim: Sim;
let osrm: Awaited<ReturnType<typeof fakeOsrm>>;
let rider: Rider;
let driver: Driver;
let owner: Admin;
const T0 = new Date("2026-11-15T09:00:00Z").getTime();
const at = (min: number) => new Date(T0 + min * 60_000);
const iso = (min: number) => at(min).toISOString();
const ids: Record<string, string> = {};

beforeAll(async () => {
  osrm = await fakeOsrm({ distance: 8000, duration: 1080 });
  sim = await Sim.start({ osrmUrl: osrm.url, now: at(0) });
  rider = await sim.rider(0);
  driver = await sim.driver(1, PLACES.nearSergels);
  owner = await sim.owner();
});
afterAll(async () => {
  await sim.stop();
  await osrm.close();
});

const open = async (who: Rider | Driver, subject: string) => {
  const res = await who.post("/support/tickets", { category: "other", subject, text: subject });
  expect(res.status).toBe(201);
  return res.body["ticketId"] as string;
};

/** Every page of GET /admin/tickets with this limit, joined. */
async function allPages(limit: number, query = ""): Promise<Json[]> {
  const out: Json[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 50; i++) {
    const res = await owner.get(`/admin/tickets?limit=${limit}${query}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    expect(res.status).toBe(200);
    out.push(...(res.body["items"] as Json[]));
    cursor = res.body["nextCursor"] as string | null;
    if (!cursor) return out;
  }
  throw new Error("too many pages");
}

describe("support inbox: oldest waiting first (v0.18.112)", () => {
  beforeAll(async () => {
    sim.clock.now = at(0);
    ids["a"] = await open(rider, "A"); // waits from 09:00 … answered at 09:30, writes again 09:40 and 09:50
    sim.clock.now = at(10);
    ids["b"] = await open(rider, "B"); // waits from 09:10; waiting true then false: still from 09:10
    sim.clock.now = at(20);
    ids["c"] = await open(driver, "C"); // waits from 09:20
    sim.clock.now = at(25);
    ids["d"] = await open(rider, "D"); // solved at 09:35: not waiting
    sim.clock.now = at(26);
    ids["e"] = await open(driver, "E"); // answered at 09:45: pending, not waiting
    sim.clock.now = at(30);
    expect((await owner.post(`/admin/tickets/${ids["a"]}/reply`, { text: "We look at it." })).status).toBe(200);
    sim.clock.now = at(32);
    expect((await owner.post(`/admin/tickets/${ids["b"]}/waiting`, { waiting: true })).body["status"]).toBe("pending");
    sim.clock.now = at(35);
    expect((await owner.post(`/admin/tickets/${ids["d"]}/solve`, {})).body["status"]).toBe("resolved");
    sim.clock.now = at(40);
    expect((await rider.post(`/support/tickets/${ids["a"]}/messages`, { text: "Here is the receipt." })).status).toBe(201);
    sim.clock.now = at(45);
    expect((await owner.post(`/admin/tickets/${ids["e"]}/reply`, { text: "Done?" })).status).toBe(200);
    sim.clock.now = at(50);
    expect((await rider.post(`/support/tickets/${ids["a"]}/messages`, { text: "Hello?" })).status).toBe(201);
    sim.clock.now = at(55);
    expect((await owner.post(`/admin/tickets/${ids["b"]}/waiting`, { waiting: false })).body["status"]).toBe("open");
    sim.clock.now = at(60);
  });

  it("waitingSince = the first person message with no support answer after it, open tickets only", async () => {
    const one = async (k: string) => (await owner.get(`/admin/tickets/${ids[k]}`)).body;
    expect((await one("a"))["waitingSince"]).toBe(iso(40));
    expect((await one("b"))["waitingSince"]).toBe(iso(10));
    expect((await one("c"))["waitingSince"]).toBe(iso(20));
    expect((await one("d"))).not.toHaveProperty("waitingSince");
    expect((await one("e"))).not.toHaveProperty("waitingSince");
    // the person's own view never carries it
    expect((await rider.get(`/support/tickets/${ids["a"]}`)).body).not.toHaveProperty("waitingSince");
  });

  it("GET /admin/tickets: waiting tickets oldest first, then the others newest change first", async () => {
    const order = (await allPages(100)).map((t) => t["ticketId"]);
    // b 09:10, c 09:20, a 09:40; then e (updated 09:45), d (09:35)
    expect(order).toEqual([ids["b"], ids["c"], ids["a"], ids["e"], ids["d"]]);
  });

  it("cursor pages over both parts with every limit: same order, nothing twice, nothing lost", async () => {
    const full = (await allPages(100)).map((t) => t["ticketId"]);
    for (const limit of [1, 2, 3, 4]) expect((await allPages(limit)).map((t) => t["ticketId"])).toEqual(full);
    // status filter still works and keeps the order
    expect((await allPages(1, "&status=open&status=pending")).map((t) => t["ticketId"])).toEqual([ids["b"], ids["c"], ids["a"], ids["e"]]);
  });

  it("a cursor from before v0.18.112 continues in the second part (never 400)", async () => {
    const old = Buffer.from(`${iso(46)}|${ids["e"]}`).toString("base64url");
    const res = await owner.get(`/admin/tickets?limit=10&cursor=${old}`);
    expect(res.status).toBe(200);
    expect((res.body["items"] as Json[]).map((t) => t["ticketId"])).toEqual([ids["e"], ids["d"]]);
    expect((await owner.get("/admin/tickets?cursor=bad")).status).toBe(400);
  });

  it("the person's own list keeps newest change first", async () => {
    const own = (await rider.get("/support/tickets?limit=50")).body["items"] as Json[];
    expect(own.map((t) => t["ticketId"])).toEqual([ids["b"], ids["a"], ids["d"]]);
  });

  it("the waiting part reads a partial index (migration 0112, built CONCURRENTLY)", async () => {
    const idx = await sim.db.selectFrom("pg_indexes" as never).select(["indexdef" as never]).where("indexname" as never, "=", "support_tickets_waiting" as never).executeTakeFirst();
    expect(String((idx as { indexdef?: string } | undefined)?.indexdef)).toMatch(/\(waiting_since, ticket_id\) WHERE \(waiting_since IS NOT NULL\)/);
  });
});
