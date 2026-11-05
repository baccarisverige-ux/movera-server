import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fakeOsrm, PLACES, Sim, type Admin, type Driver, type Json, type Rider } from "./harness.js";

/**
 * v0.18.17 Book later (CONTRACT.md §41, contract.json#bookLater; owner 2026-11-03 Q1–Q7, Rules decisions/driver-g15.md):
 * booking window, now / list mode, the reservation notice, Scheduled rides accept (first tap wins), driver and rider
 * reminders, the pre-pickup dispatch, the no-driver alert, free change and cancel more than 1 h before, the admin's
 * unassign and dispatch-now. Before this the server had no GET /driver/reservations (404) and never dispatched a booked ride.
 */

let sim: Sim;
let osrm: Awaited<ReturnType<typeof fakeOsrm>>;
let rider: Rider;
let a: Driver;
let b: Driver;
let owner: Admin;

beforeAll(async () => {
  osrm = await fakeOsrm({ distance: 8000, duration: 1080 });
  sim = await Sim.start({ osrmUrl: osrm.url, now: new Date("2026-11-05T05:00:00Z") });
  rider = await sim.rider(0);
  a = await sim.driver(1, PLACES.nearSergels);
  b = await sim.driver(2, PLACES.odenplan);
  owner = await sim.owner();
});
afterAll(async () => {
  await sim.stop();
  await osrm.close();
});
beforeEach(async () => {
  // A fresh day for each case; nothing booked is left from the previous one.
  await sim.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("status", "not in", ["completed", "cancelled_by_rider", "cancelled_by_admin", "expired", "cancelled_by_system", "no_show", "failed", "cancelled_by_driver"]).execute();
  // Job 1: the cases end their trips straight in the database, so their open offers are closed here too (an overdue
  // booked ride now goes out as Exclusive only, and a left-over open Exclusive would keep a driver from the next case).
  await sim.db.updateTable("offers").set({ status: "withdrawn" }).where("status", "=", "open").execute();
  await sim.db.updateTable("drivers").set({ online_status: "online" }).where("online_status", "=", "on_trip").execute();
  await jump(6 * 3600);
  // An admin session does not last the hours these cases jump; sign one in for each case.
  owner = await sim.admin("super");
});

/** Time passes in one jump; the driver apps send a fresh fix, then every timer that came due runs. */
async function jump(seconds: number) {
  sim.clock.now = new Date(sim.clock.now.getTime() + seconds * 1000);
  for (const d of [a, b]) if (d.position) await d.heartbeat();
  await sim.tick();
}
const minutes = (m: number) => new Date(sim.clock.now.getTime() + m * 60_000).toISOString();
const until = (at: string, plusSeconds = 0) => jump((Date.parse(at) - sim.clock.now.getTime()) / 1000 + plusSeconds);

async function book(at: string, extra: Json = {}) {
  const quotes = await rider.quote({ categoryIds: ["economy"], kind: "scheduled", scheduledAt: at });
  expect(quotes.status, JSON.stringify(quotes.body)).toBe(201);
  const quote = quotes.body["quotes"][0];
  const res = await rider.post("/trips", { quoteId: quote.quoteId, categoryId: "economy", pickup: PLACES.sergels, dropoff: PLACES.medborgar, stops: [], kind: "scheduled", scheduledAt: at, paymentMethod: "cash", ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}
const kinds = async (subjectId: string, tripId: string) =>
  (await sim.db.selectFrom("notifications").select("kind").where("subject_id", "=", subjectId).where("trip_id", "=", tripId).orderBy("created_at").execute()).map((n) => n.kind);
const open = async (d: Driver) => ((await d.get("/driver/reservations?scope=open")).body["items"] as Json[]).map((i) => i["tripId"]);

describe("book later (owner Q1–Q7)", () => {
  it("Q1 window: under 15 min or over 90 days ahead is refused at quote", async () => {
    expect((await rider.quote({ categoryIds: ["economy"], kind: "scheduled", scheduledAt: minutes(10) })).body).toMatchObject({ reason: "booking_too_soon" });
    expect((await rider.quote({ categoryIds: ["economy"], kind: "scheduled", scheduledAt: minutes(91 * 1440) })).body).toMatchObject({ reason: "booking_too_far" });
    expect((await rider.quote({ categoryIds: ["economy"], kind: "scheduled", scheduledAt: minutes(89 * 1440) })).status).toBe(201);
    // The demo admin's Max Trip Distance (Reservations): a booked ride longer than maxTripKm (60 km) is refused.
    await sim.publish(owner, "driver_app_config", "Z001", (doc) => ({ ...doc, reservations: { ...(doc.reservations ?? {}), maxTripKm: 5 } }));
    expect((await rider.quote({ categoryIds: ["economy"], kind: "scheduled", scheduledAt: minutes(120) })).body).toMatchObject({ reason: "trip_too_long" });
    expect((await rider.quote({ categoryIds: ["economy"] })).status).toBe(201);
    await sim.publish(owner, "driver_app_config", "Z001", (doc) => ({ ...doc, reservations: { ...(doc.reservations ?? {}), maxTripKm: null } }));
    // BL-Q5: no limit by default.
    expect((await rider.quote({ categoryIds: ["economy"], kind: "scheduled", scheduledAt: minutes(120) })).status).toBe(201);
    const config = (await rider.get("/rider/config?zoneId=Z001")).body;
    expect(config.booking).toMatchObject({ minAheadMin: 15, maxAheadDays: 90, freeChangeBeforeMin: 60 });
  });

  it("Q2 under 30 min ahead: sent at once like a live ride (exclusive / radar offer)", async () => {
    const trip = await book(minutes(20));
    expect(trip).toMatchObject({ status: "searching", reservation: { mode: "now", noDriver: false } });
    await sim.tick();
    expect((await a.offerFor(trip.tripId)) ?? (await b.offerFor(trip.tripId))).toBeDefined();
    expect(await open(a)).not.toContain(trip.tripId);
  });

  it("Q2 + Q5: 3 h ahead goes on Scheduled rides with a notice; first tap wins; reminders; driver keeps taking live rides; start from the online time", async () => {
    const trip = await book(minutes(180));
    expect(trip).toMatchObject({ status: "requested", reservation: { mode: "list", dispatchAt: minutes(150), freeChangeUntil: minutes(120) } });
    expect(await open(a)).toContain(trip.tripId);
    expect(await open(b)).toContain(trip.tripId);
    expect(await kinds(a.id, trip.tripId)).toEqual(["reservation_new"]);

    const took = await a.post(`/driver/reservations/${trip.tripId}/accept`, { expectedVersion: trip.version });
    expect(took.status, JSON.stringify(took.body)).toBe(200);
    expect(took.body).toMatchObject({ status: "accepted", driver: { driverId: a.id }, reservation: { mustBeOnlineAt: minutes(120) } });
    expect((await b.post(`/driver/reservations/${trip.tripId}/accept`, {})).body).toMatchObject({ reason: "reservation_taken" });
    expect(await kinds(rider.id, trip.tripId)).toContain("reservation_driver_found");
    expect(await kinds(rider.id, trip.tripId)).not.toContain("trip");
    expect(((await a.get("/driver/reservations?scope=accepted")).body["items"] as Json[]).map((i) => i["tripId"])).toEqual([trip.tripId]);
    expect(await open(b)).not.toContain(trip.tripId);
    // Holding a booked ride for later, A is still free for a live ride now.
    expect((await a.get("/driver/profile")).body["onlineStatus"]).toBe("online");
    const live = await rider.book();
    await sim.tick();
    const offer = (await a.offerFor(live.tripId)) ?? (await b.offerFor(live.tripId));
    expect(offer).toBeDefined();
    await rider.command(live.tripId, "cancel", { reasonCode: "plans_changed" });

    expect((await a.post(`/driver/reservations/${trip.tripId}/start`, {})).body).toMatchObject({ reason: "reservation_too_early" });
    await jump(60 * 60 + 5); // 2 h before: the driver's reminder
    expect(await kinds(a.id, trip.tripId)).toContain("reservation_reminder");
    await jump(60 * 60); // 1 h before: be online now, and the rider's reminder
    expect(await kinds(a.id, trip.tripId)).toContain("reservation_go_online");
    expect(await kinds(rider.id, trip.tripId)).toContain("reservation_reminder");
    const started = await a.post(`/driver/reservations/${trip.tripId}/start`, {});
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect(started.body).toMatchObject({ status: "driver_to_pickup" });
    expect((await a.get("/driver/profile")).body["onlineStatus"]).toBe("on_trip");
    await a.command(trip.tripId, "cancel", { reasonCode: "scheduled_other" });
  });

  it("nobody takes it: the search starts 30 min before; Q3 no driver 10 min before → admin flag + rider told, search goes on", async () => {
    const trip = await book(minutes(120));
    await until(trip.reservation.dispatchAt, 1);
    expect((await rider.trip(trip.tripId)).status).toMatch(/searching|offered/);
    for (const d of [a, b]) {
      const offer = await d.offerFor(trip.tripId);
      if (offer) await d.decline(offer);
    }
    await until(new Date(Date.parse(trip.scheduledAt) - 10 * 60_000).toISOString(), 1);
    const adminView = (await owner.get(`/admin/trips/${trip.tripId}`)).body;
    expect(adminView).toMatchObject({ reservation: { noDriver: true } });
    expect(adminView.status).toMatch(/searching|offered/);
    expect(await kinds(rider.id, trip.tripId)).toContain("reservation_no_driver");
    expect(((await owner.get("/admin/trips?kind=scheduled")).body["items"] as Json[]).some((t) => t["tripId"] === trip.tripId)).toBe(true);
  });

  it("give back, offline driver loses it, admin unassign and dispatch-now", async () => {
    const trip = await book(minutes(240));
    const version = (await rider.trip(trip.tripId)).version;
    expect((await a.post(`/driver/reservations/${trip.tripId}/accept`, { expectedVersion: version })).status).toBe(200);
    expect((await a.post(`/driver/reservations/${trip.tripId}/release`, { reasonCode: "scheduled_cannot_make_time" })).status).toBe(204);
    expect((await rider.trip(trip.tripId)).status).toBe("requested");
    expect(await open(a)).not.toContain(trip.tripId); // he gave it back: not offered to him again
    expect((await b.post(`/driver/reservations/${trip.tripId}/accept`, {})).status).toBe(200);

    const unassign = await owner.tripCommand(trip.tripId, "reservation/unassign", { expectedVersion: (await owner.get(`/admin/trips/${trip.tripId}`)).body.version, reason: "Driver called in sick" });
    expect(unassign.status, JSON.stringify(unassign.body)).toBe(200);
    expect(unassign.body).toMatchObject({ status: "requested" });
    expect(await kinds(b.id, trip.tripId)).toContain("reservation_unassigned");
    expect(await kinds(b.id, trip.tripId)).not.toContain("reservation_lost");

    // B takes it again and goes offline: 5 min after his go-online time it goes back.
    expect((await b.post(`/driver/reservations/${trip.tripId}/accept`, {})).status).toBe(200);
    const profile = (await b.get("/driver/profile")).body;
    const off = await b.post("/driver/availability", { expectedVersion: profile.version, onlineStatus: "offline" });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    const goOnline = new Date(Date.parse(trip.scheduledAt) - 60 * 60_000);
    await until(new Date(goOnline.getTime() + 5 * 60_000).toISOString(), 1);
    expect((await rider.trip(trip.tripId)).status).toBe("requested");
    expect(await kinds(b.id, trip.tripId)).toEqual(expect.arrayContaining(["reservation_go_online", "reservation_lost"]));
    await b.goOnline(PLACES.odenplan);

    const now = await owner.tripCommand(trip.tripId, "reservation/dispatch-now", { expectedVersion: (await owner.get(`/admin/trips/${trip.tripId}`)).body.version });
    expect(now.status, JSON.stringify(now.body)).toBe(200);
    expect(now.body.status).toBe("searching");
    const audit = await sim.db.selectFrom("admin_audit").select("action").where("target_id", "=", trip.tripId).execute();
    expect(audit.map((r) => r.action)).toEqual(expect.arrayContaining(["reservation.unassign", "reservation.dispatch_now"]));
  });

  it("Q6: more than 1 h before the rider changes (new price) or cancels free; under 1 h no change", async () => {
    const trip = await book(minutes(180));
    expect((await a.post(`/driver/reservations/${trip.tripId}/accept`, {})).status).toBe(200);
    const later = minutes(240);
    const quote = (await rider.quote({ categoryIds: ["economy"], kind: "scheduled", scheduledAt: later, dropoff: PLACES.odenplan })).body.quotes[0];
    const changed = await rider.post(`/trips/${trip.tripId}/reschedule`, { quoteId: quote.quoteId, expectedVersion: (await rider.trip(trip.tripId)).version });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    // BL-Q6: A still holds it and is asked "Keep it at the new time?".
    expect(changed.body).toMatchObject({ status: "accepted", scheduledAt: later, fare: quote.total, reservation: { changeAsk: { previousAt: trip.scheduledAt } } });
    expect(await kinds(a.id, trip.tripId)).toContain("reservation_change_ask");
    const kept = await a.post(`/driver/reservations/${trip.tripId}/keep`, { keep: true });
    expect(kept.status, JSON.stringify(kept.body)).toBe(200);
    expect(kept.body).toMatchObject({ status: "accepted", driver: { driverId: a.id } });
    expect(kept.body.reservation.changeAsk).toBeUndefined();
    // Changed again; no answer within 15 min → back on the list.
    const q3 = (await rider.quote({ categoryIds: ["economy"], kind: "scheduled", scheduledAt: minutes(260), dropoff: PLACES.odenplan })).body.quotes[0];
    expect((await rider.post(`/trips/${trip.tripId}/reschedule`, { quoteId: q3.quoteId, expectedVersion: (await rider.trip(trip.tripId)).version })).status).toBe(200);
    await jump(15 * 60 + 1);
    expect((await rider.trip(trip.tripId)).status).toBe("requested");
    expect(await kinds(a.id, trip.tripId)).toContain("reservation_changed");

    expect((await b.post(`/driver/reservations/${trip.tripId}/accept`, {})).status).toBe(200);
    const free = await rider.command(trip.tripId, "cancel", { reasonCode: "plans_changed" });
    expect(free.status).toBe(200);
    expect(free.body.cancellation.fee).toBeNull();

    const soon = await book(minutes(50));
    const q2 = (await rider.quote({ categoryIds: ["economy"], kind: "scheduled", scheduledAt: minutes(200) })).body.quotes[0];
    expect((await rider.post(`/trips/${soon.tripId}/reschedule`, { quoteId: q2.quoteId, expectedVersion: (await rider.trip(soon.tripId)).version })).body).toMatchObject({ reason: "change_too_late" });
    await rider.command(soon.tripId, "cancel", { reasonCode: "plans_changed" });
  });

  it("job 5 (L36, owner fix-plan Q3 + Q5): under 1 h before pickup the cancel costs the fee even with no driver; Movera keeps it (fail-before: free)", async () => {
    // More than 1 h before, no driver → free (unchanged).
    const early = await book(minutes(180));
    const free = await rider.command(early.tripId, "cancel", { reasonCode: "plans_changed" });
    expect(free.status).toBe(200);
    expect(free.body.cancellation.fee).toBeNull();
    // Booked 3 h ahead, nobody takes it; 45 min before pickup (before the search starts) the rider cancels.
    const trip = await book(minutes(180));
    await until(trip.scheduledAt, -45 * 60);
    expect((await rider.trip(trip.tripId)).driver).toBeUndefined();
    const res = await rider.command(trip.tripId, "cancel", { reasonCode: "plans_changed" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.cancellation.fee.amountMinor).toBeGreaterThan(0);
    expect(res.body.cancellation).toMatchObject({ feeStatus: "owed", feeKind: "cancel" });
    const stored = await sim.db.selectFrom("trips").select(["cancellation", "driver_earnings_minor"]).where("trip_id", "=", trip.tripId).executeTakeFirstOrThrow();
    expect(stored.cancellation).toMatchObject({ driverShare: { amountMinor: 0 } });
    expect(Number(stored.driver_earnings_minor)).toBe(0);
    const owed = await sim.db.selectFrom("rider_fees").select(["amount_minor", "status"]).where("trip_id", "=", trip.tripId).execute();
    expect(owed.map((o) => [Number(o.amount_minor), o.status])).toEqual([[res.body.cancellation.fee.amountMinor, "owed"]]);
    const earnings = await sim.db.selectFrom("earnings_entries").select("entry_id").where("trip_id", "=", trip.tripId).execute();
    expect(earnings).toEqual([]);
    // The fee is settled before the next ride (outstandingFee); clear it so later cases start clean.
    await sim.db.updateTable("rider_fees").set({ status: "waived" }).where("trip_id", "=", trip.tripId).execute();
  });

  it("job 5 (R28, owner Q7): a driver on a trip gets a booked ride starting within 60 min as Exclusive (held as his next); not when it clashes (fail-before: never)", async () => {
    // Only A is around: B is offline for this case.
    await sim.db.updateTable("drivers").set({ online_status: "offline" }).where("driver_id", "=", b.id).execute();
    try {
      const other = await sim.rider(1);
      const live = await other.book();
      await sim.tick();
      const liveOffer = await a.offerFor(live.tripId);
      expect(liveOffer).toBeDefined();
      expect((await a.accept(liveOffer!)).status).toBe(200);
      expect((await a.get("/driver/profile")).body["onlineStatus"]).toBe("on_trip");

      // Booked 25 min ahead (sent at once): A ends his trip and drives over in time → an Exclusive offer, never Radar.
      const next = await book(minutes(25));
      await sim.tick();
      const offer = await a.offerFor(next.tripId);
      expect(offer, "on-trip driver gets the booked ride").toBeDefined();
      expect(offer!["kind"]).toBe("exclusive");
      const took = await a.accept(offer!);
      expect(took.status, JSON.stringify(took.body)).toBe(200);
      const held = await sim.db.selectFrom("trips").select(["status", "driver_id", "reservation"]).where("trip_id", "=", next.tripId).executeTakeFirstOrThrow();
      expect(held).toMatchObject({ status: "accepted", driver_id: a.id, reservation: { held: true } });
      // He stays on his current trip; the booked one waits for him.
      expect((await a.get("/driver/profile")).body["onlineStatus"]).toBe("on_trip");
      expect((await sim.db.selectFrom("trips").select("driver_id").where("trip_id", "=", live.tripId).executeTakeFirstOrThrow()).driver_id).toBe(a.id);
      await sim.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("trip_id", "=", next.tripId).execute();

      // His current trip runs an hour longer than the booked time → no offer (it clashes).
      await sim.db.updateTable("trips").set({ duration_seconds: 3600 }).where("trip_id", "=", live.tripId).execute();
      const clash = await book(minutes(20));
      await sim.tick();
      expect(await a.offerFor(clash.tripId)).toBeUndefined();
    } finally {
      await sim.db.updateTable("drivers").set({ online_status: "online" }).where("driver_id", "=", b.id).execute();
    }
  });

  it("the admin's zone settings decide: 45 min soon limit, open list to a group only", async () => {
    await sim.publish(owner, "driver_app_config", "Z001", (doc) => ({ ...doc, reservations: { ...(doc.reservations ?? {}), soonBeforeMin: 45, listTo: "group", listGroupId: "grp_none", listOpenAll: false } }));
    const soon = await book(minutes(40));
    expect(soon.status).toBe("searching");
    await rider.command(soon.tripId, "cancel", { reasonCode: "plans_changed" });
    const listed = await book(minutes(300));
    expect(listed.status).toBe("requested");
    expect(await open(a)).not.toContain(listed.tripId);
    expect((await a.post(`/driver/reservations/${listed.tripId}/accept`, {})).body).toMatchObject({ reason: "reservation_not_open" });
    await sim.publish(owner, "driver_app_config", "Z001", (doc) => ({ ...doc, reservations: { ...(doc.reservations ?? {}), soonBeforeMin: 30, listTo: "all", listGroupId: null, listOpenAll: true } }));
  });

  it("BL-Q7: pickup time passes with no driver — never expires, admin alert, still offered as Exclusive", async () => {
    const trip = await book(minutes(40));
    await until(trip.scheduledAt, 1);
    for (let i = 0; i < 6; i++) {
      for (const d of [a, b]) {
        const offer = await d.offerFor(trip.tripId);
        if (offer) await d.decline(offer);
      }
      await jump(120);
    }
    const view = (await owner.get(`/admin/trips/${trip.tripId}`)).body;
    expect(view.status).toMatch(/searching|offered/);
    expect(view.reservation).toMatchObject({ overdue: true, noDriver: true });
    await jump(5);
    const offers = await sim.db.selectFrom("offers").select(["kind", "sent_at"]).where("trip_id", "=", trip.tripId).where("sent_at", ">", new Date(trip.scheduledAt)).execute();
    expect(offers.length).toBeGreaterThan(0);
    expect(new Set(offers.map((o) => o.kind))).toEqual(new Set(["exclusive"]));
  });

  it("BL-Q4: home nearby, favourite drivers and near the pickup at that time", async () => {
    // Home area: A's home is at the pickup, B has none.
    expect((await a.put("/driver/home-area", { lat: PLACES.sergels.lat, lng: PLACES.sergels.lng, label: "Home" })).body.homeArea).toMatchObject({ label: "Home" });
    expect((await owner.get(`/admin/drivers/${a.id}`)).body.homeArea).toMatchObject({ lat: PLACES.sergels.lat });
    await sim.publish(owner, "driver_app_config", "Z001", (doc) => ({ ...doc, reservations: { ...(doc.reservations ?? {}), listTo: "homeNear", listOpenAll: false } }));
    const home = await book(minutes(300));
    expect(await open(a)).toContain(home.tripId);
    expect(await open(b)).not.toContain(home.tripId);
    await rider.command(home.tripId, "cancel", { reasonCode: "plans_changed" });

    // Favourites: only a driver of a completed ride can be one.
    expect((await rider.put(`/rider/favourite-drivers/${b.id}`, {})).status).toBe(404);
    await sim.db.updateTable("trips").set({ status: "completed" }).where("trip_id", "=", home.tripId).execute();
    await sim.db.updateTable("trips").set({ driver_id: b.id }).where("trip_id", "=", home.tripId).execute();
    expect((await rider.put(`/rider/favourite-drivers/${b.id}`, {})).body.items.map((f: Json) => f.driverId)).toEqual([b.id]);
    await sim.publish(owner, "driver_app_config", "Z001", (doc) => ({ ...doc, reservations: { ...(doc.reservations ?? {}), listTo: "favourites" } }));
    const fav = await book(minutes(300));
    expect(await open(b)).toContain(fav.tripId);
    expect(await open(a)).not.toContain(fav.tripId);
    await rider.command(fav.tripId, "cancel", { reasonCode: "plans_changed" });

    // Near the pickup at that time: A holds a ride that ends near this pickup 20 min before.
    await sim.publish(owner, "driver_app_config", "Z001", (doc) => ({ ...doc, reservations: { ...(doc.reservations ?? {}), listTo: "all" } }));
    const first = await book(minutes(300));
    expect((await a.post(`/driver/reservations/${first.tripId}/accept`, {})).status).toBe(200);
    await sim.publish(owner, "driver_app_config", "Z001", (doc) => ({ ...doc, reservations: { ...(doc.reservations ?? {}), listTo: "nearAtTime" } }));
    const quotes = await rider.quote({ categoryIds: ["economy"], kind: "scheduled", scheduledAt: minutes(338), pickup: PLACES.medborgar, dropoff: PLACES.sergels });
    const q = quotes.body.quotes[0];
    const next = (await rider.post("/trips", { quoteId: q.quoteId, categoryId: "economy", pickup: PLACES.medborgar, dropoff: PLACES.sergels, stops: [], kind: "scheduled", scheduledAt: minutes(338), paymentMethod: "cash" })).body;
    expect(await open(a)).toContain(next.tripId);
    expect(await open(b)).not.toContain(next.tripId);
    await sim.publish(owner, "driver_app_config", "Z001", (doc) => ({ ...doc, reservations: { ...(doc.reservations ?? {}), listTo: "all", listOpenAll: true } }));
  });

  it("checker H1: a booked ride accepted through a normal offer (now mode) is the driver's current trip", async () => {
    const trip = await book(minutes(20));
    await sim.tick();
    const holder = (await a.offerFor(trip.tripId)) ? a : b;
    const offer = (await holder.offerFor(trip.tripId))!;
    expect((await holder.accept(offer)).body).toMatchObject({ status: "accepted" });
    const profile = (await holder.get("/driver/profile")).body;
    expect(profile.activeTripId).toBe(trip.tripId);
    expect(profile.onlineStatus).toBe("on_trip");
    const off = await holder.post("/driver/availability", { expectedVersion: profile.version, onlineStatus: "offline" });
    expect(off.body).toMatchObject({ reason: "on_trip" });
    // The index keeps him to one current trip: a second current trip for him is refused by the database.
    const second = await book(minutes(25));
    await expect(sim.db.updateTable("trips").set({ status: "accepted", driver_id: holder.id }).where("trip_id", "=", second.tripId).execute()).rejects.toThrow(/trips_one_active_per_driver/);
    expect((await rider.get("/rider/trips?kind=scheduled")).status).toBe(200);
  });

  it("owner M6-a + checker M5: assigned notice, 2 h reminder only, admin alert when a held ride is not started at pickup time", async () => {
    const trip = await book(minutes(180));
    expect((await a.post(`/driver/reservations/${trip.tripId}/accept`, {})).status).toBe(200);
    expect(await kinds(a.id, trip.tripId)).toEqual(["reservation_new", "reservation_assigned"]);
    expect((await kinds(rider.id, trip.tripId)).filter((k) => k === "reservation_driver_found" || k === "trip")).toEqual(["reservation_driver_found"]);
    await until(trip.scheduledAt, 1);
    const reminders = (await kinds(a.id, trip.tripId)).filter((k) => k === "reservation_reminder");
    expect(reminders).toHaveLength(1);
    expect(await kinds(a.id, trip.tripId)).toContain("reservation_not_started");
    expect((await owner.get(`/admin/trips/${trip.tripId}`)).body.reservation).toMatchObject({ notStarted: true });
  });
});
