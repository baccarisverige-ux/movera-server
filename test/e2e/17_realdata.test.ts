import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { payoutLines } from "../../src/admin/payouts.js";
import { nightlyHandler, NIGHTLY, nextNightly } from "../../src/jobs/maintenance.js";
import { summarize } from "../../src/admin/kpis.js";
import { bookAndAccept, drive, fakeOsrm, PLACES, Sim, type Admin, type Driver, type Json, type Rider } from "./harness.js";

/**
 * Real data for the admin (contract v0.9.0 §16, owner real-data decisions part 3, 2026-10-27): payouts with lines
 * (weekly job and Create payout by hand, never a trip twice, Mark as paid), refunds, support tickets and answers,
 * rating tags and moderation, risk signals, KPIs (today live, earlier days from the nightly summary) and the admin
 * dispatch feed.
 */

const payoutCases = JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/payouts.json`, "utf8")) as { cases: Array<{ id: string; entries: Array<Json>; expect: { lines: Record<string, number>; tripCount: number; amountMinor: number } }> };

let sim: Sim;
let osrm: Awaited<ReturnType<typeof fakeOsrm>>;
let rider: Rider;
let other: Rider;
let driver: Driver;
let owner: Admin;
let tripId: string;

async function completedTrip(by: Rider = rider): Promise<string> {
  const { tripId: id } = await bookAndAccept(sim, by, driver);
  await drive(driver, id, "in_trip");
  const done = await driver.command(id, "complete");
  if (done.status !== 200) throw new Error(`complete ${done.status} ${JSON.stringify(done.body)}`);
  return id;
}

beforeAll(async () => {
  osrm = await fakeOsrm({ distance: 8000, duration: 1080 });
  // A Monday morning, so the week of the first trips ends in days.
  sim = await Sim.start({ osrmUrl: osrm.url, now: new Date("2026-10-26T09:00:00Z") });
  rider = await sim.rider(0);
  other = await sim.rider(2);
  driver = await sim.driver(1, PLACES.nearSergels);
  owner = await sim.owner();
  tripId = await completedTrip();
});
afterAll(async () => {
  await sim.stop();
  await osrm.close();
});

describe("payouts (contract.json#payouts, fixtures/payouts.json)", () => {
  it("the server's line maths gives every fixture case", () => {
    for (const c of payoutCases.cases) {
      const got = payoutLines(c.entries.filter((e) => !e["inPayout"]).map((e) => ({ kind: e["kind"], amountMinor: e["amountMinor"], cashMinor: e["cashMinor"] ?? 0, waitingMinor: e["waitingMinor"] ?? 0 })));
      expect({ id: c.id, lines: Object.fromEntries(got.lines.map((l) => [l.code, l.amountMinor])), tripCount: got.tripCount, amountMinor: got.amountMinor }).toEqual({ id: c.id, ...c.expect });
    }
  });

  it("Create payout by hand: the lines behind the amount, never the same trip twice, then Mark as paid", async () => {
    const before = await owner.post("/admin/payouts", { driverId: driver.id, from: "2026-10-26T00:00:00Z", to: "2026-10-26T08:59:00Z" });
    expect(before.status).toBe(409);
    expect(before.body["reason"]).toBe("nothing_to_pay");
    await sim.advance(60);
    const until = sim.clock.now.toISOString();
    const made = await owner.post("/admin/payouts", { driverId: driver.id, from: "2026-10-26T00:00:00Z", to: until, note: "by hand" });
    expect(made.status).toBe(201);
    const trip = await owner.trip(tripId);
    const earnings = trip["driverEarnings"]["amountMinor"] as number;
    const cash = trip["paymentMethod"] === "cash" ? (trip["fare"]["amountMinor"] as number) - ((trip["walletApplied"]?.["amountMinor"] as number) ?? 0) : 0;
    expect(made.body).toMatchObject({ driverId: driver.id, source: "manual", status: "pending", tripCount: 1, note: "by hand" });
    const lines = made.body["lines"] as Json[];
    expect(lines.find((l) => l["code"] === "trips")).toMatchObject({ count: 1 });
    expect(lines.reduce((sum, l) => sum + (l["amount"]["amountMinor"] as number), 0)).toBe(made.body["amount"]["amountMinor"]);
    const pickup = (trip["pickupPay"]?.["amountMinor"] as number) ?? 0;
    expect(made.body["amount"]["amountMinor"]).toBe(earnings + pickup - cash);
    const again = await owner.post("/admin/payouts", { driverId: driver.id, from: "2026-10-26T00:00:00Z", to: until });
    expect(again.body["reason"]).toBe("nothing_to_pay");
    const list = await owner.get(`/admin/payouts?driverId=${driver.id}`);
    expect(list.body["items"].map((p: Json) => p["payoutId"])).toEqual([made.body["payoutId"]]);
    const mine = await driver.get("/driver/payouts");
    expect(mine.body["items"][0]["amount"]).toEqual(made.body["amount"]);
    expect(mine.body["items"][0]["lines"]).toBeUndefined();
    const paid = await owner.post(`/admin/payouts/${made.body["payoutId"]}/paid`, { note: "Swish 26/10" });
    expect(paid.body).toMatchObject({ status: "paid", paidBy: owner.id });
    expect((await owner.post(`/admin/payouts/${made.body["payoutId"]}/paid`, {})).body["reason"]).toBe("already_paid");
    expect((await owner.get("/admin/payouts?status=failed")).body["items"]).toEqual([]);
    const future = await owner.post("/admin/payouts", { driverId: driver.id, from: "2026-10-26T00:00:00Z", to: "2026-10-30T00:00:00Z" });
    expect(future.body["reason"]).toBe("range_in_future");
  });

  it("a zone-limited admin does not see another zone's payouts", async () => {
    const z002 = await sim.admin("super", ["Z002"]);
    expect((await z002.get("/admin/payouts")).body["items"]).toEqual([]);
  });
});

describe("ratings: tags from the fixed list, admin list, hide and restore (contract.json#ratings.tags)", () => {
  it("both apps send stars, tags and a comment; a tag from the other list is refused", async () => {
    const tags = JSON.parse(readFileSync(`${CONTRACTS_DIR}/contract.json`, "utf8"))["ratings"]["tags"];
    const wrong = await rider.post(`/trips/${tripId}/rating`, { stars: 2, tags: [tags["aboutRider"][0]] });
    expect(wrong.status).toBe(400);
    const twice = await rider.post(`/trips/${tripId}/rating`, { stars: 2, tags: ["friendly", "friendly"] });
    expect(twice.status).toBe(400);
    const byRider = await rider.post(`/trips/${tripId}/rating`, { stars: 2, tags: ["clean_car"], comment: "Late and rude" });
    expect(byRider.status).toBe(201);
    expect(byRider.body).toMatchObject({ stars: 2, tags: ["clean_car"], comment: "Late and rude" });
    const byDriver = await driver.post(`/trips/${tripId}/rating`, { stars: 5, tags: ["polite", "on_time"], comment: "Thanks" });
    expect(byDriver.status).toBe(201);
  });

  it("Admin › Reviews lists them; hiding takes the stars out of the average and the risk signal, restoring puts them back", async () => {
    const list = await owner.get(`/admin/ratings?driverId=${driver.id}&rater=rider`);
    expect(list.body["items"]).toEqual([expect.objectContaining({ tripId, from: "rider", stars: 2, tags: ["clean_car"], comment: "Late and rude", hidden: false, driverId: driver.id, riderId: rider.id })]);
    const ratingOf = async () => (await owner.get(`/admin/drivers/${driver.id}`)).body["rating"];
    const signal = async () => ((await owner.get("/admin/risk/signals?who=driver")).body["items"] as Json[]).find((p) => p["id"] === driver.id)?.["signals"]?.["low_rating"];
    expect(await ratingOf()).toBe(2);
    expect(await signal()).toEqual({ value: 2, count: 1 });
    const hidden = await owner.post(`/admin/ratings/${tripId}/rider/hide`, { reason: "Insult" });
    expect(hidden.body).toMatchObject({ hidden: true, hiddenBy: owner.id, hideReason: "Insult" });
    expect(await ratingOf()).toBeUndefined();
    expect(await signal()).toBeUndefined();
    expect((await owner.post(`/admin/ratings/${tripId}/rider/hide`, { reason: "again" })).body["reason"]).toBe("already_hidden");
    expect((await owner.get("/admin/ratings?hidden=true")).body["items"].map((r: Json) => r["tripId"])).toEqual([tripId]);
    const shown = await owner.post(`/admin/ratings/${tripId}/rider/restore`, { reason: "Checked" });
    expect(shown.body["hidden"]).toBe(false);
    expect(await ratingOf()).toBe(2);
    expect((await owner.get(`/admin/audit?targetType=rating`)).body["items"].map((a: Json) => a["action"])).toEqual(["rating.restore", "rating.hide"]);
  });
});

describe("support tickets: the apps open them, Admin › Support answers, the app reads the answer", () => {
  it("a ride dispute from the rider and a help request from the driver; the answer reaches the rider", async () => {
    const bad = await rider.post("/support/tickets", { category: "made_up", subject: "x", text: "x" });
    expect(bad.status).toBe(400);
    const dispute = await rider.post("/support/tickets", { tripId, category: "ride_dispute", subject: "Charged too much", text: "The driver took a long way." });
    expect(dispute.status).toBe(201);
    expect(dispute.body).toMatchObject({ openedBy: "rider", riderId: rider.id, tripId, status: "open", zoneId: "Z001", messages: [{ from: "rider", text: "The driver took a long way." }] });
    const help = await driver.post("/support/tickets", { category: "help", subject: "App question", text: "Where are my payouts?" });
    expect(help.body).toMatchObject({ openedBy: "driver", driverId: driver.id, status: "open" });
    const notMine = await other.post("/support/tickets", { tripId, category: "ride_dispute", subject: "x", text: "x" });
    expect(notMine.status).toBe(404);
    const list = await owner.get("/admin/tickets?status=open");
    expect(list.body["items"].map((t: Json) => t["ticketId"]).sort()).toEqual([dispute.body["ticketId"], help.body["ticketId"]].sort());
    // v0.18.18 (owner "Real name from Team"): the name shown is the first name set in Team.
    await owner.send("PATCH", "/admin/auth/me", { firstName: "Ada" });
    const answer = await owner.post(`/admin/tickets/${dispute.body["ticketId"]}/reply`, { text: "We refunded 50 kr.", status: "resolved" });
    expect(answer.body).toMatchObject({ status: "resolved", messages: [{ from: "rider" }, { from: "support", text: "We refunded 50 kr.", adminName: "Ada" }] });
    const seen = await rider.get(`/support/tickets/${dispute.body["ticketId"]}`);
    expect(seen.body["messages"].at(-1)).toMatchObject({ from: "support", text: "We refunded 50 kr." });
    expect((await rider.get("/support/tickets")).body["items"].map((t: Json) => t["status"])).toEqual(["resolved"]);
    expect((await other.get(`/support/tickets/${dispute.body["ticketId"]}`)).status).toBe(404);
    const z002 = await sim.admin("super", ["Z002"]);
    expect((await z002.get(`/admin/tickets/${dispute.body["ticketId"]}`)).status).toBe(403);
    // contract v0.13.0 §22: the list is the admin's zones only, and support.reply is needed to read.
    expect(JSON.stringify((await z002.get("/admin/tickets")).body)).not.toContain(dispute.body["ticketId"]);
    const viewer = await sim.admin("viewer");
    expect((await viewer.get(`/admin/tickets/${dispute.body["ticketId"]}`)).status).toBe(403);
    await owner.post(`/admin/tickets/${help.body["ticketId"]}/reply`, { text: "Closed.", status: "closed" });
    expect((await owner.post(`/admin/tickets/${help.body["ticketId"]}/reply`, { text: "more" })).body["reason"]).toBe("ticket_closed");
  });
});

describe("refunds, risk, KPIs and the dispatch feed", () => {
  it("GET /admin/refunds lists the trip's refund with its payment id", async () => {
    const trip = await owner.trip(tripId);
    const refund = await owner.tripCommand(tripId, "refund", { expectedVersion: trip["version"], amount: { amountMinor: 1000, currency: "SEK" }, reason: "Long route" });
    expect(refund.status).toBeLessThan(300);
    const list = await owner.get(`/admin/refunds?tripId=${tripId}`);
    expect(list.body["items"]).toEqual([expect.objectContaining({ tripId, paymentId: `pay_${tripId}`, amount: { amountMinor: 1000, currency: "SEK" }, reason: "Long route" })]);
    expect((await owner.get(`/admin/refunds?paymentId=pay_${tripId}`)).body["items"]).toHaveLength(1);
  });

  it("risk: a rider who cancels is counted; a failed payment would be too", async () => {
    const { tripId: cancelled } = await other.book();
    const trip = await other.trip(cancelled);
    expect((await other.command(cancelled, "cancel", { expectedVersion: trip["version"], reasonCode: "plans_changed" })).status).toBe(200);
    const people = (await owner.get("/admin/risk/signals?who=rider")).body["items"] as Json[];
    expect(people.find((p) => p["id"] === other.id)?.["signals"]).toEqual({ cancels: { value: 100, count: 1, total: 1 } });
  });

  it("KPIs: today counted live; past days from the nightly summary, rewritten the same on a re-run; never zeros for a day not summarized", async () => {
    const today = (await owner.get("/admin/kpis?zoneId=Z001")).body["days"] as Json[];
    expect(today).toEqual([expect.objectContaining({ date: "2026-10-26", zoneId: "Z001", source: "live", currency: "SEK", completedTrips: 1 })]);
    expect(today[0]!["gross"]).toBeGreaterThan(0);
    const range = "/admin/kpis?zoneId=Z001&fromDate=2026-10-24&toDate=2026-10-26";
    // Not summarized yet: the past days are left out, never shown as zeros.
    expect(((await owner.get(range)).body["days"] as Json[]).map((d) => [d["date"], d["source"]])).toEqual([["2026-10-26", "live"]]);
    expect(await sim.database.db.transaction().execute((trx) => summarize(trx, sim.clock.now, "2026-10-24"))).toBeGreaterThanOrEqual(2);
    const first = (await owner.get(range)).body["days"] as Json[];
    expect(first.map((d) => [d["date"], d["source"], d["completedTrips"]])).toEqual([["2026-10-24", "summary", 0], ["2026-10-25", "summary", 0], ["2026-10-26", "live", 1]]);
    await sim.database.db.transaction().execute((trx) => summarize(trx, sim.clock.now, "2026-10-24"));
    const again = (await owner.get(range)).body["days"] as Json[];
    expect(again).toEqual(first);
    expect((await owner.get("/admin/kpis?fromDate=2026-11-02&toDate=2026-10-01")).status).toBe(400);
    const z002 = await sim.admin("super", ["Z002"]);
    expect((await z002.get("/admin/kpis?zoneId=Z001")).status).toBe(403);
  });

  it("the dispatch feed holds the offer sent and accepted, and the lock, as a JSON page", async () => {
    const feed = await owner.get("/admin/dispatch/stream?after=0&limit=200");
    const kinds = (feed.body["items"] as Json[]).filter((e) => e["tripId"] === tripId).map((e) => e["kind"]);
    expect(kinds).toEqual(expect.arrayContaining(["offer_sent", "offer_accepted", "assignment_locked"]));
    const accepted = (feed.body["items"] as Json[]).find((e) => e["tripId"] === tripId && e["kind"] === "offer_accepted");
    expect(accepted?.["offer"]).toMatchObject({ driverId: driver.id, status: "claimed" });
    expect(accepted?.["projection"]?.["tripId"]).toBe(tripId);
    const z002 = await sim.admin("super", ["Z002"]);
    expect((await z002.get("/admin/dispatch/stream?after=0")).body["items"]).toEqual([]);
  });
});

describe("the dispatch feed as server-sent events", () => {
  it("a new booking's offer arrives on GET /admin/dispatch/stream", async () => {
    const stream = await sim.stream("/admin/dispatch/stream?zoneId=Z001", owner.token);
    const { tripId: booked } = await other.book();
    await sim.tick();
    const event = await stream.waitFor((e) => e.data["tripId"] === booked && e.data["kind"] === "offer_sent");
    expect(event.data["offer"]).toMatchObject({ tripId: booked, status: "open" });
    expect(Number(event.id)).toBe(event.data["sequence"]);
    stream.close();
    const trip = await other.trip(booked);
    expect((await other.command(booked, "cancel", { expectedVersion: trip["version"], reasonCode: "plans_changed" })).status).toBe(200);
  });
});

describe("the nightly job (last: it moves the clock a week on)", () => {
  it("the nightly job pays each ended week once (v0.18.13 default: Monday 08:00 to Monday 08:00 in the zone's time) and is safe to run again", async () => {
    const second = await completedTrip();
    // A week later (the tokens have run out by then, so the check reads the database).
    sim.clock.now = new Date("2026-11-03T02:00:00Z");
    const run = () => sim.database.db.transaction().execute((trx) => nightlyHandler(trx, { timerId: "t", kind: NIGHTLY, refId: "all", dueAt: sim.clock.now, firedAt: sim.clock.now, attempts: 0 } as never));
    await run();
    await run();
    const weekly = await sim.database.db.selectFrom("payouts").selectAll().where("driver_id", "=", driver.id).where("source", "=", "weekly").execute();
    expect(weekly.map((p) => [p.trip_count, p.period_start.toISOString(), p.period_end.toISOString(), p.status])).toEqual([[1, "2026-10-26T07:00:00.000Z", "2026-11-02T07:00:00.000Z", "pending"]]);
    const linked = await sim.database.db.selectFrom("earnings_entries").select("payout_id").where("trip_id", "=", second).where("kind", "=", "trip").executeTakeFirstOrThrow();
    expect(linked.payout_id).toBe(weekly[0]!.payout_id);
    expect(nextNightly(new Date("2026-11-03T02:00:00Z")).toISOString()).toBe("2026-11-04T01:00:00.000Z");
  });

});
