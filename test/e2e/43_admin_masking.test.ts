import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_FLEET_CODE } from "../../src/drivers/seedTest.js";
import { bookAndAccept, Sim, type Admin, type Driver, type Rider } from "./harness.js";

/**
 * Global plan step 37 (contract v0.18.54 §76, owner Q40 "Yes, now" / Q41 "Yes, logged"): an admin without the matching
 * viewSensitive right sees a rider's / driver's phone, e-mail and date of birth and a fleet's owner e-mail MASKED, with
 * sensitiveMasked true; Reveal with a reason answers the full values once and is audited (the reason, never the values);
 * one click on an open SOS reveals both phone numbers. Own profiles stay full. Fails before: every role saw full values.
 */

let sim: Sim;
let rider: Rider;
let driver: Driver;
let viewer: Admin;
let support: Admin;
let dispatcher: Admin;
let safety: Admin;
let finance: Admin;
let farViewer: Admin;
let fleetId: string;

const DOT = "•";
// Rider 0 = +46701740608, driver 1 = +46701740606 (test group): +46, one dot per hidden digit, the last two digits.
const maskedRiderPhone = `+46${DOT.repeat(7)}08`;

const audits = (action: string) => sim.db.selectFrom("admin_audit").select(["admin_id", "target_id", "detail"]).where("action", "=", action).execute();

beforeAll(async () => {
  sim = await Sim.start({ now: new Date("2026-11-09T10:00:00Z") });
  rider = await sim.rider(0);
  driver = await sim.driver(1);
  viewer = await sim.admin("viewer");
  support = await sim.admin("support");
  dispatcher = await sim.admin("dispatcher");
  safety = await sim.admin("safety", ["Z001"]);
  finance = await sim.admin("finance");
  farViewer = await sim.admin("viewer", ["Z999"]);
  await sim.db.updateTable("riders").set({ email: "anna@example.com" }).where("rider_id", "=", rider.id).execute();
  await sim.db.updateTable("drivers").set({ email: "bo@example.com", date_of_birth: "1990-05-17" }).where("driver_id", "=", driver.id).execute();
  const fleet = await sim.db.selectFrom("fleets").select(["fleet_id", "owner_driver_id"]).where("code", "=", TEST_FLEET_CODE).executeTakeFirstOrThrow();
  fleetId = fleet.fleet_id;
  await sim.db.updateTable("drivers").set({ email: "owner@fleet.example.com" }).where("driver_id", "=", fleet.owner_driver_id).execute();
  await sim.db.insertInto("sign_in_waitlist").values({ phone: "+33612345678", app: "rider", locale: "fr", ip: null, first_at: sim.clock.now, last_at: sim.clock.now }).execute();
});
afterAll(async () => {
  await sim.stop();
});

describe("step 37: admin masking, Reveal with a reason, SOS reveal (v0.18.54 §76)", () => {
  it("a viewer sees riders masked with sensitiveMasked; support sees the full values", async () => {
    const masked = await viewer.get("/admin/riders");
    expect(masked.status).toBe(200);
    const row = masked.body.items.find((r: { riderId: string }) => r.riderId === rider.id);
    expect(row).toMatchObject({ phone: maskedRiderPhone, email: `a${DOT}${DOT}${DOT}@example.com`, sensitiveMasked: true });
    // The server still searches the full number for every role; the row comes back masked.
    const found = await viewer.get(`/admin/riders?q=${encodeURIComponent(rider.login)}`);
    expect(found.body.items.map((r: { riderId: string; phone: string }) => [r.riderId, r.phone])).toEqual([[rider.id, maskedRiderPhone]]);
    const full = await support.get("/admin/riders");
    const fullRow = full.body.items.find((r: { riderId: string }) => r.riderId === rider.id);
    expect(fullRow).toMatchObject({ phone: rider.login, email: "anna@example.com" });
    expect(fullRow).not.toHaveProperty("sensitiveMasked");
  });

  it("the rider's own profile stays full", async () => {
    const me = await rider.get("/rider/profile");
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ phone: rider.login, email: "anna@example.com" });
    expect(me.body).not.toHaveProperty("sensitiveMasked");
  });

  it("Reveal a rider: full values once, audited with the reason and never the phone; a short reason is refused", async () => {
    const shown = await viewer.post(`/admin/riders/${rider.id}/reveal`, { reason: "Rider asked us to call back" });
    expect(shown.status).toBe(200);
    expect(shown.body).toEqual({ riderId: rider.id, phone: rider.login, email: "anna@example.com", revealedAt: sim.clock.now.toISOString() });
    const rows = await audits("rider.reveal");
    expect(rows).toEqual([{ admin_id: viewer.id, target_id: rider.id, detail: { reason: "Rider asked us to call back" } }]);
    expect(JSON.stringify(rows)).not.toContain(rider.login.slice(1));
    const short = await viewer.post(`/admin/riders/${rider.id}/reveal`, { reason: "ab" });
    expect(short.status).toBe(400);
    expect(short.body).toMatchObject({ code: "invalid_request", reason: "reason_required" });
    const none = await viewer.post(`/admin/riders/${rider.id}/reveal`, {});
    expect(none.status).toBe(400);
    expect(none.body.reason).toBe("reason_required");
    // Another zone's admin: the rider has no trip there.
    const far = await farViewer.post(`/admin/riders/${rider.id}/reveal`, { reason: "Checking something" });
    expect(far.status).toBe(403);
    expect(far.body.reason).toBe("zone_out_of_scope");
    // Idempotency: a second call with the same key is a new read, not a replay (no body kept in idempotency_keys).
    const kept = await sim.db.selectFrom("idempotency_keys").select("route").where("route", "like", "%/reveal").execute();
    expect(kept).toEqual([]);
    expect((await audits("rider.reveal")).length).toBe(1);
  });

  it("driver detail and list: e-mail and date of birth masked for a viewer, full for a dispatcher and for the driver", async () => {
    const masked = await viewer.get(`/admin/drivers/${driver.id}`);
    expect(masked.status).toBe(200);
    expect(masked.body).toMatchObject({ email: `b${DOT}${DOT}${DOT}@example.com`, dateOfBirth: "1990", sensitiveMasked: true });
    const list = await viewer.get("/admin/drivers");
    expect(list.body.items.find((d: { driverId: string }) => d.driverId === driver.id)).toMatchObject({ dateOfBirth: "1990", sensitiveMasked: true });
    const full = await dispatcher.get(`/admin/drivers/${driver.id}`);
    expect(full.body).toMatchObject({ email: "bo@example.com", dateOfBirth: "1990-05-17" });
    expect(full.body).not.toHaveProperty("sensitiveMasked");
    const own = await driver.get("/driver/profile");
    expect(own.body).toMatchObject({ email: "bo@example.com", dateOfBirth: "1990-05-17" });
    expect(own.body).not.toHaveProperty("sensitiveMasked");
    const shown = await viewer.post(`/admin/drivers/${driver.id}/reveal`, { reason: "Document check" });
    expect(shown.status).toBe(200);
    expect(shown.body).toEqual({ driverId: driver.id, phone: driver.login, email: "bo@example.com", dateOfBirth: "1990-05-17", revealedAt: sim.clock.now.toISOString() });
    expect(await audits("driver.reveal")).toEqual([{ admin_id: viewer.id, target_id: driver.id, detail: { reason: "Document check" } }]);
  });

  it("fleets: the owner's e-mail masked for a viewer, full for a dispatcher; Reveal audited", async () => {
    const list = await viewer.get("/admin/fleets");
    expect(list.status).toBe(200);
    expect(list.body.items.find((f: { fleetId: string }) => f.fleetId === fleetId)).toMatchObject({ ownerEmail: `o${DOT}${DOT}${DOT}@fleet.example.com`, sensitiveMasked: true });
    const detail = await viewer.get(`/admin/fleets/${fleetId}`);
    expect(detail.body.fleet).toMatchObject({ ownerEmail: `o${DOT}${DOT}${DOT}@fleet.example.com`, sensitiveMasked: true });
    const full = await dispatcher.get(`/admin/fleets/${fleetId}`);
    expect(full.body.fleet).toMatchObject({ ownerEmail: "owner@fleet.example.com" });
    expect(full.body.fleet).not.toHaveProperty("sensitiveMasked");
    const shown = await viewer.post(`/admin/fleets/${fleetId}/reveal`, { reason: "Invoice question" });
    expect(shown.status).toBe(200);
    expect(shown.body).toEqual({ fleetId, ownerEmail: "owner@fleet.example.com", revealedAt: sim.clock.now.toISOString() });
    expect(await audits("fleet.reveal")).toEqual([{ admin_id: viewer.id, target_id: fleetId, detail: { reason: "Invoice question" } }]);
  });

  it("the waitlist is masked for an admin without riders.viewSensitive", async () => {
    const masked = await viewer.get("/admin/waitlist");
    expect(masked.status).toBe(200);
    expect(masked.body.items.map((w: { phone: string }) => w.phone)).toEqual([`+33${DOT.repeat(7)}78`]);
    const full = await support.get("/admin/waitlist");
    expect(full.body.items.map((w: { phone: string }) => w.phone)).toEqual(["+33612345678"]);
  });

  it("GET /admin/refunds/payouts keeps the full values and writes refunds.payouts_viewed { count }", async () => {
    const res = await finance.get("/admin/refunds/payouts");
    expect(res.status).toBe(200);
    expect(await audits("refunds.payouts_viewed")).toEqual([{ admin_id: finance.id, target_id: "payouts", detail: { count: res.body.items.length } }]);
  });

  it("SOS: one click on an open case reveals both phones with one audit row; a closed case is 409", async () => {
    const { tripId } = await bookAndAccept(sim, rider, driver);
    const sos = await rider.post(`/rider/trips/${tripId}/sos`, { at: sim.clock.now.toISOString() });
    expect(sos.status).toBe(200);
    const incidentId: string = sos.body.incidentId;
    expect((await finance.post(`/admin/incidents/${incidentId}/reveal-contacts`, {})).status).toBe(403);
    const shown = await safety.post(`/admin/incidents/${incidentId}/reveal-contacts`, {});
    expect(shown.status).toBe(200);
    expect(shown.body).toEqual({ incidentId, rider: { phone: rider.login }, driver: { phone: driver.login }, revealedAt: sim.clock.now.toISOString() });
    expect(await audits("incident.reveal_contacts")).toEqual([{ admin_id: safety.id, target_id: incidentId, detail: { reason: "SOS" } }]);
    const taken = await safety.post(`/admin/incidents/${incidentId}/take`, { expectedVersion: 1 });
    expect(taken.status).toBe(200);
    const solved = await safety.post(`/admin/incidents/${incidentId}/resolve`, { expectedVersion: taken.body.version, note: "Rider safe" });
    expect(solved.status).toBe(200);
    const closed = await safety.post(`/admin/incidents/${incidentId}/reveal-contacts`, { reason: "Follow-up" });
    expect(closed.status).toBe(409);
    expect(closed.body).toMatchObject({ code: "invalid_transition", reason: "incident_closed" });
    expect((await audits("incident.reveal_contacts")).length).toBe(1);
  });
});
