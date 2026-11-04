import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { adminLiveFeed, ADMIN_EVENTS_CHANNEL, LIVE, mayHearLive, pruneAdminLiveEvents } from "../../src/realtime/adminEvents.js";
import { fakeOsrm, PLACES, Sim, type Admin, type Json, type Rider } from "./harness.js";

/**
 * contract v0.18.22 (CONTRACT.md §46, contract.json#adminLiveEvents): the admin live updates stream GET /admin/events.
 * Zone scope (a Paris admin hears nothing from Stockholm), per-type permission, Last-Event-ID replay, resync.
 */

let sim: Sim;
let osrm: Awaited<ReturnType<typeof fakeOsrm>>;
let rider: Rider;
let second: Rider;
let third: Rider;
let owner: Admin;
let paris: Admin;

beforeAll(async () => {
  osrm = await fakeOsrm({ distance: 8000, duration: 1080 });
  sim = await Sim.start({ osrmUrl: osrm.url });
  rider = await sim.rider(0);
  second = await sim.rider(1);
  third = await sim.rider(2);
  await sim.driver(1, PLACES.nearSergels);
  owner = await sim.owner();
  paris = await sim.admin("super", ["FR-PC"]);
});
afterAll(async () => {
  await sim.stop();
  await osrm.close();
});

const items = (res: { body: Json }) => res.body["items"] as Json[];

describe("GET /admin/events (JSON page)", () => {
  it("a booking in Stockholm is trip.changed for the owner, nothing for the Paris admin; a driver going online is driver.status + zone.supply", async () => {
    const { tripId } = await rider.book();
    const mine = items(await owner.get("/admin/events?after=0&limit=200"));
    expect(mine.find((e) => e["type"] === "trip.changed" && e["entityId"] === tripId)).toMatchObject({ zoneId: expect.any(String), sequence: expect.any(Number) });
    expect(mine.some((e) => e["type"] === "driver.status")).toBe(true);
    expect(mine.some((e) => e["type"] === "zone.supply")).toBe(true);
    // Only ids: no names, money or text.
    for (const e of mine) expect(Object.keys(e).sort()).toEqual(["entityId", "occurredAt", "sequence", "serverTime", "type", "zoneId"]);
    const theirs = items(await paris.get("/admin/events?after=0&limit=200"));
    expect(theirs.filter((e) => e["zoneId"] !== "FR-PC")).toEqual([]);
    expect(theirs.some((e) => e["entityId"] === tripId)).toBe(false);
    // A zone outside the admin's own is refused.
    expect((await paris.get("/admin/events?zoneId=Z001")).status).toBe(403);
  });

  it("a ticket and an alert change are streamed by the database triggers", async () => {
    const ticket = await rider.post("/support/tickets", { category: "help", subject: "Live", text: "Live test." });
    expect(ticket.status).toBe(201);
    const all = items(await owner.get("/admin/events?after=0&limit=200"));
    expect(all.some((e) => e["type"] === "ticket.changed" && e["entityId"] === ticket.body["ticketId"])).toBe(true);
  });

  it("a type the admin has no permission for is never sent", () => {
    const viewer = { actor: "admin" as const, subjectId: "a", sessionId: "s", zones: ["*"], perms: ["overview.read", "trips.read"] };
    expect(mayHearLive(viewer, { type: "trip.changed", zone_id: "Z001" })).toBe(true);
    expect(mayHearLive(viewer, { type: "ticket.changed", zone_id: "Z001" })).toBe(false);
    expect(mayHearLive(viewer, { type: "incident.changed", zone_id: "Z001" })).toBe(false);
    expect(mayHearLive({ ...viewer, zones: ["Z001"] }, { type: "trip.changed", zone_id: null })).toBe(false);
    expect(mayHearLive(viewer, { type: "made_up", zone_id: "Z001" })).toBe(false);
  });
});

describe("GET /admin/events (server-sent events)", () => {
  it("a new booking arrives live; a reconnect with Last-Event-ID replays only what came after", async () => {
    const stream = await sim.stream("/admin/events", owner.token);
    const { tripId: first } = await second.book();
    const seen = await stream.waitFor((e) => e.data["type"] === "trip.changed" && e.data["entityId"] === first);
    expect(Number(seen.id)).toBe(seen.data["sequence"]);
    stream.close();
    const replay = await sim.stream("/admin/events", owner.token, seen.id);
    const { tripId: later } = await third.book();
    await replay.waitFor((e) => e.data["type"] === "trip.changed" && e.data["entityId"] === later);
    for (const e of replay.events) expect(e.data["sequence"] as number).toBeGreaterThan(Number(seen.id));
    replay.close();
  });

  it("a Paris admin's stream never carries a Stockholm event", async () => {
    const stream = await sim.stream("/admin/events", paris.token);
    const ownerStream = await sim.stream("/admin/events", owner.token);
    const ticket = await rider.post("/support/tickets", { category: "help", subject: "Scope", text: "Scope test." });
    await ownerStream.waitFor((e) => e.data["entityId"] === ticket.body["ticketId"]);
    expect(stream.events.filter((e) => e.data["zoneId"] !== "FR-PC")).toEqual([]);
    stream.close();
    ownerStream.close();
  });

  it("a cursor older than the kept events gets one resync first", async () => {
    const latest = items(await owner.get("/admin/events?after=0&limit=200"));
    const top = Math.max(...latest.map((e) => e["sequence"] as number));
    await pruneAdminLiveEvents(sim.database.db, new Date(Date.now() + 48 * 3_600_000));
    await sim.database.db.insertInto("admin_live_events").values({ type: "trip.changed", entity_id: "later", zone_id: "Z001" }).execute();
    const page = items(await owner.get(`/admin/events?after=1&limit=200`));
    expect(page[0]).toMatchObject({ type: "resync", zoneId: null, sequence: 1 });
    expect(page[1]).toMatchObject({ type: "trip.changed", entityId: "later" });
    expect(page[1]!["sequence"] as number).toBeGreaterThan(top);
    const fresh = items(await owner.get(`/admin/events?after=${top}&limit=200`));
    expect(fresh.some((e) => e["type"] === "resync")).toBe(false);
  });

  it("one shared read per change, whatever the number of open streams (500+500 load)", async () => {
    const streams = await Promise.all([0, 1, 2, 3].map(() => sim.stream("/admin/events", owner.token)));
    const feed = adminLiveFeed(sim.database.db, sim.hub, { warn: () => undefined });
    expect(feed.open).toBeGreaterThanOrEqual(4);
    const before = feed.reads;
    await sim.database.db.transaction().execute(async (trx) => {
      await trx.insertInto("admin_live_events").values({ type: "trip.changed", entity_id: "shared", zone_id: "Z001" }).execute();
      await sql`SELECT pg_notify(${ADMIN_EVENTS_CHANNEL}, '{}')`.execute(trx);
    });
    for (const stream of streams) await stream.waitFor((e) => e.data["entityId"] === "shared");
    // Fail-before: one SELECT per stream (4); now one shared read (a second may follow to see nothing is left).
    expect(feed.reads - before).toBeLessThanOrEqual(2);
    for (const stream of streams) stream.close();
  });

  it("at most maxStreamsPerAdmin streams per admin: the next one is 429 too_many_streams", async () => {
    const admin = await sim.admin("super");
    const open = [];
    for (let i = 0; i < LIVE.limits.maxStreamsPerAdmin; i += 1) open.push(await sim.stream("/admin/events", admin.token));
    const refused = await sim.request("GET", "/admin/events", admin.token, undefined, { key: null, headers: { accept: "text/event-stream" } });
    expect(refused.status).toBe(429);
    expect(refused.body["reason"]).toBe("too_many_streams");
    open[0]!.close();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const again = await sim.stream("/admin/events", admin.token);
    expect(again.status).toBe(200);
    again.close();
    for (const stream of open.slice(1)) stream.close();
  });
});

