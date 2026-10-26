import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedTestPhones } from "../../src/auth/testPhones.js";
import { seedDriver } from "../../src/drivers/service.js";
import { bookAndAccept, drive, fakeOsrm, PLACES, Sim, type Admin, type Driver, type Rider } from "./harness.js";

const LONE_PHONE = "+46701740699";

let sim: Sim;
let osrm: Awaited<ReturnType<typeof fakeOsrm>>;
let alice: Rider;
let bob: Rider;
let fleetOwner: Driver;
let a: Driver;
let b: Driver;
let lone: Driver;
let owner: Admin;

beforeAll(async () => {
  osrm = await fakeOsrm({ distance: 8000, duration: 1080 });
  sim = await Sim.start({ osrmUrl: osrm.url });
  // A driver outside the test fleet (own car, made the way `seed-test` makes a lone driver).
  await seedTestPhones(sim.db, [LONE_PHONE]);
  await sim.db.transaction().execute((trx) => seedDriver(trx, { phone: LONE_PHONE, firstName: "Lone", make: "Saab", model: "9-5", year: 2011, color: "Blue", plate: "LON 001", categoryIds: ["economy"], zoneIds: ["Z001"] }, sim.clock.now));
  alice = await sim.rider(0);
  bob = await sim.rider(1);
  fleetOwner = await sim.driver(0, null);
  a = await sim.driver(1, PLACES.nearSergels);
  b = await sim.driver(2, PLACES.odenplan);
  const session = await sim.signIn(LONE_PHONE, "driver");
  lone = new (a.constructor as new (...args: ConstructorParameters<typeof Driver>) => Driver)(sim, LONE_PHONE, session);
  lone.id = (await lone.get("/driver/profile")).body.driverId;
  owner = await sim.owner();
});
afterAll(async () => {
  await sim.stop();
  await osrm.close();
});

describe("scenario 10: authorization", () => {
  it("a rider cannot see or touch another rider's trip (404, nothing changes)", async () => {
    const { tripId } = await bookAndAccept(sim, alice, a);
    const version = (await alice.trip(tripId)).version;
    expect((await bob.get(`/trips/${tripId}`)).status).toBe(404);
    for (const [path, body] of [
      ["cancel", { reasonCode: "plans_changed" }],
      ["raise-price", { increase: { amountMinor: 5000, currency: "SEK" } }],
      ["end-early", { reasonCode: "plans_changed" }],
      ["on-the-way", {}],
      ["messages", { text: "hi" }],
      ["rating", { stars: 1 }],
    ] as const) {
      const res = await bob.post(`/trips/${tripId}/${path}`, { expectedVersion: version, ...body });
      expect(res.status, `${path}: ${JSON.stringify(res.body)}`).toBe(404);
    }
    const stream = await bob.events(tripId);
    expect(stream.status).toBe(404);
    expect((await alice.trip(tripId)).version).toBe(version);
    await alice.command(tripId, "cancel", { reasonCode: "plans_changed" });
  });

  it("a driver cannot act on a trip that is not theirs, nor take another driver's offer", async () => {
    const { tripId } = await alice.book();
    await sim.tick();
    const holder = (await a.offerFor(tripId)) ? a : b;
    const other = holder === a ? b : a;
    const offer = (await holder.offerFor(tripId))!;
    const stolen = await other.post(`/offers/${offer.offerId}/accept`, { expectedVersion: offer.version });
    expect(stolen.status).toBe(404);
    expect((await holder.accept(offer)).status).toBe(200);
    const version = (await holder.trip(tripId)).version;
    expect((await other.get(`/trips/${tripId}`)).status).toBe(404);
    for (const path of ["head-to-pickup", "arrive", "board", "start", "complete", "no-show", "cancel"]) {
      const res = await other.post(`/trips/${tripId}/${path}`, { expectedVersion: version, reasonCode: "rider_requested_cancel" });
      expect(res.status, `${path}: ${JSON.stringify(res.body)}`).toBe(404);
    }
    // A rider token cannot drive, a driver token cannot book.
    expect((await alice.post(`/trips/${tripId}/arrive`, { expectedVersion: version })).status).toBe(403);
    expect((await holder.post("/quotes", { pickup: PLACES.sergels, dropoff: PLACES.medborgar, stops: [] })).status).toBe(403);
    expect((await holder.trip(tripId)).version).toBe(version);
    await alice.command(tripId, "cancel", { reasonCode: "plans_changed" });
  });

  it("the fleet owner manages only their own fleet; a driver outside it is out of reach; a member is not an owner", async () => {
    const fleet = (await fleetOwner.get("/driver/fleet")).body.fleet;
    expect(fleet).toMatchObject({ code: "MV-TESTA" });
    expect((await fleetOwner.get("/driver/fleet/earnings")).status).toBe(200);
    const removeLone = await fleetOwner.post(`/driver/fleet/drivers/${lone.id}/remove`, {});
    expect([403, 404]).toContain(removeLone.status);
    expect((await sim.db.selectFrom("drivers").select("fleet_id").where("driver_id", "=", lone.id).executeTakeFirstOrThrow()).fleet_id).toBeNull();
    // A member of the fleet (not its owner) cannot see the fleet's money or remove a colleague.
    expect([403, 404]).toContain((await a.get("/driver/fleet/earnings")).status);
    expect([403, 404]).toContain((await a.post(`/driver/fleet/drivers/${b.id}/remove`, {})).status);
    // The lone driver sees no fleet and cannot reach the test fleet's earnings.
    expect([403, 404]).toContain((await lone.get("/driver/fleet/earnings")).status);
    expect((await sim.db.selectFrom("drivers").select("fleet_id").where("driver_id", "=", b.id).executeTakeFirstOrThrow()).fleet_id).toBe(fleet.fleetId);
  });

  it("an admin limited to another zone cannot read or act on a Z001 trip, and does not see it listed", async () => {
    const { tripId } = await bookAndAccept(sim, alice, a);
    const z2 = await sim.admin("dispatcher", ["Z002"]);
    const version = (await owner.trip(tripId)).version;
    expect([403, 404]).toContain((await z2.get(`/admin/trips/${tripId}`)).status);
    expect([403, 404]).toContain((await z2.tripCommand(tripId, "reassign", { expectedVersion: version, reasonCode: "admin_operational", note: "x" })).status);
    expect([403, 404]).toContain((await z2.get(`/admin/trips/${tripId}/offers`)).status);
    const listed = (await z2.get("/admin/trips")).body.items as Array<{ tripId: string }>;
    expect(listed.map((t) => t.tripId)).not.toContain(tripId);
    const drivers = (await z2.get("/admin/drivers")).body.items as Array<{ driverId: string }>;
    expect(drivers.map((d) => d.driverId)).not.toContain(a.id);
    const profile = (await owner.get(`/admin/drivers/${a.id}`)).body;
    expect((await z2.post(`/admin/drivers/${a.id}/status`, { expectedVersion: profile.version, accountStatus: "suspended", note: "x" })).status).toBe(403);
    expect((await owner.trip(tripId)).version).toBe(version);
    await alice.command(tripId, "cancel", { reasonCode: "plans_changed" });
  });

  it("GET /admin/approvals lists only the approvals of the admin's zones (finding P3-4)", async () => {
    const { tripId } = await bookAndAccept(sim, alice, a);
    await drive(a, tripId, "in_trip");
    await sim.advance(60);
    await a.moveTo(PLACES.medborgar);
    expect((await a.command(tripId, "complete")).body.status).toBe("completed");
    const finance = await sim.admin("finance", ["Z001"]);
    const version = (await owner.trip(tripId)).version;
    const pending = await finance.tripCommand(tripId, "refund", { expectedVersion: version, amount: { amountMinor: 1000, currency: "SEK" }, reason: "detour" });
    expect(pending.status, JSON.stringify(pending.body)).toBe(202);
    const approvalId = pending.body.approvalId as string;

    const z1 = await sim.admin("finance", ["Z001"]);
    const z2 = await sim.admin("finance", ["Z002"]);
    const seen = async (admin: Admin) => {
      const res = await admin.get("/admin/approvals");
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return (res.body.items as Array<{ approvalId: string }>).map((i) => i.approvalId);
    };
    expect(await seen(owner)).toContain(approvalId);
    expect(await seen(z1)).toContain(approvalId);
    expect(await seen(z2)).not.toContain(approvalId);
    // Deciding it was already refused outside the zone.
    expect((await z2.post(`/admin/approvals/${approvalId}/approve`, {})).status).toBe(403);
  });
});
