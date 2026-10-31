import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { ADMIN_ROLES, permissionsOf, type AdminRole } from "../../src/admin/permissions.js";
import { newId } from "../../src/ids.js";
import { bookAndAccept, PLACES, Sim, type Admin, type Driver, type Json, type Rider } from "./harness.js";

/**
 * Audit Phase 4: the route-by-route authorization matrix. Every route the server really registers (read from
 * Fastify, not from a hand list) is called with no token, with each app's token it must not accept, by an admin
 * whose role lacks the route's permission, and by a Super admin limited to another zone; owner-scoped routes are
 * also called by a rider, driver or fleet member who is not the owner. The expected answer comes from the contract
 * (`x-actor`, `x-permission`, `security: []`), so a new route that is not in the contract and not in EXTRA below
 * fails the test until someone decides who may call it.
 */

type Op = { actors: string[]; permission?: string; public?: boolean; optionalAuth?: boolean };

/** Routes the server serves that the contract does not (yet) list, with who may call them. */
const EXTRA: Record<string, Op> = {
  "GET /admin/refunds/payouts": { actors: ["admin"], permission: "finance.read" },
  "POST /admin/refunds/:refundId/paid": { actors: ["admin"], permission: "finance.edit" },
  "GET /rider/refunds": { actors: ["rider"] },
  "POST /rider/refunds/:refundId/destination": { actors: ["rider"] },
};

function contractOps(): Map<string, Op> {
  const doc = parse(readFileSync(new URL("../../contracts/openapi.yaml", import.meta.url), "utf8")) as Json;
  const ops = new Map<string, Op>();
  for (const [path, methods] of Object.entries(doc["paths"] as Json)) {
    for (const [method, op] of Object.entries(methods as Json)) {
      if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
      const security = (op as Json)["security"] as Json[] | undefined;
      const key = `${method.toUpperCase()} ${path.replace(/\{(\w+)\}/g, ":$1")}`;
      ops.set(key, {
        actors: (op as Json)["x-actor"] as string[],
        ...((op as Json)["x-permission"] ? { permission: (op as Json)["x-permission"] as string } : {}),
        ...(Array.isArray(security) && security.length === 0 ? { public: true } : {}),
        ...(Array.isArray(security) && security.some((s) => Object.keys(s).length === 0) && security.length > 0 ? { optionalAuth: true } : {}),
      });
    }
  }
  for (const [key, op] of Object.entries(EXTRA)) ops.set(key, op);
  return ops;
}

/** Every method + path Fastify serves under /api/v1, from its route tree. */
function serverRoutes(sim: Sim): string[] {
  const tree = sim.app.printRoutes({ commonPrefix: false });
  const stack: string[] = [];
  const out: string[] = [];
  for (const line of tree.split("\n")) {
    const m = /^([│ ]*)[├└]── (\S+)(?: \(([^)]*)\))?/.exec(line);
    if (!m) continue;
    const depth = m[1]!.length / 4;
    stack.length = depth;
    stack.push(m[2]!);
    const full = stack.join("");
    for (const method of (m[3] ?? "").split(",").map((s) => s.trim()).filter((s) => s && s !== "HEAD")) {
      if (full.startsWith("/api/v1/")) out.push(`${method} ${full.slice("/api/v1".length)}`);
    }
  }
  return out;
}

let sim: Sim;
let rider: Rider;
let otherRider: Rider;
let fleetOwner: Driver;
let member: Driver;
let otherDriver: Driver;
let owner: Admin;
let tripId: string;
let ids: Record<string, string>;
const admins = new Map<string, Admin>();

beforeAll(async () => {
  sim = await Sim.start();
  rider = await sim.rider(0);
  otherRider = await sim.rider(1);
  fleetOwner = await sim.driver(0, PLACES.nearSergels);
  member = await sim.driver(1, null);
  otherDriver = await sim.driver(2, null);
  owner = await sim.owner();
  ({ tripId } = await bookAndAccept(sim, rider, fleetOwner));
  const offer = await sim.db.selectFrom("offers").select("offer_id").where("trip_id", "=", tripId).executeTakeFirstOrThrow();
  const fleet = await sim.db.selectFrom("fleets").select("fleet_id").executeTakeFirstOrThrow();
  const car = await sim.db.selectFrom("vehicles").select("vehicle_id").where("fleet_id", "=", fleet.fleet_id).executeTakeFirstOrThrow();
  const doc = await sim.db.selectFrom("documents").select("document_id").where("driver_id", "=", fleetOwner.id).executeTakeFirstOrThrow();
  const invite = await fleetOwner.post("/driver/fleet/invite", { phone: "+46701740698" });
  const sos = await rider.post(`/rider/trips/${tripId}/sos`, { at: sim.clock.now.toISOString() });
  ids = {
    tripId,
    rideId: tripId,
    offerId: offer.offer_id,
    fleetId: fleet.fleet_id,
    vehicleId: car.vehicle_id,
    documentId: doc.document_id,
    driverId: fleetOwner.id,
    riderId: rider.id,
    adminId: owner.id,
    invitationId: invite.body["invitationId"] ?? newId("inv"),
    incidentId: sos.body["incidentId"] ?? newId("inc"),
    zoneId: "Z001",
    // v0.7.1: the first middle stop; a car type of the catalog.
    stopIndex: "0",
    categoryId: "economy",
    doc: "pricing",
    coordinates: "18.0649,59.3326;18.0735,59.3143",
    ...(await pendingApproval()),
    refundId: newId("rfd"),
    notificationId: newId("ntf"),
    placeId: "plc_none",
    paymentMethodId: "pm_none",
    paymentId: newId("pay"),
    payoutId: newId("pyt"),
    ticketId: newId("tkt"),
    from: "rider",
    slot: "help",
  };
});
afterAll(async () => {
  await sim?.stop();
});

const ADMIN_REASON = (JSON.parse(readFileSync(new URL("../../contracts/contract.json", import.meta.url), "utf8")) as Json)["cancelReasons"]["admin"][0] as string;
const SEK = (amountMinor: number) => ({ amountMinor, currency: "SEK" });
/** A body that passes each route's schema, so the call reaches the owner / zone check instead of stopping at 400. */
function bodyFor(route: string): Json | undefined {
  if (route.startsWith("GET ")) return undefined;
  const v = { expectedVersion: 1, note: "audit matrix", reason: "audit matrix" };
  const bodies: Record<string, Json> = {
    "POST /admin/trips/:tripId/cancel": { ...v, reasonCode: ADMIN_REASON },
    "POST /admin/trips/:tripId/reassign": { ...v, reasonCode: ADMIN_REASON },
    "POST /admin/trips/:tripId/assign": { ...v, driverId: ids["driverId"] },
    "POST /admin/trips/:tripId/radar-group": { ...v, driverIds: [ids["driverId"]] },
    "POST /admin/trips/:tripId/refund": { ...v, amount: SEK(100) },
    "POST /admin/trips/:tripId/driver-bonus": { ...v, amount: SEK(100) },
    "POST /admin/drivers/:driverId/status": { ...v, accountStatus: "suspended" },
    "POST /admin/riders/:riderId/status": { ...v, status: "suspended" },
    "POST /admin/documents/:documentId/review": { decision: "rejected" },
    "POST /admin/fleets/:fleetId/review": { ...v, decision: "blocked" },
    "POST /admin/vehicles/:vehicleId/review": { ...v, decision: "blocked" },
    "POST /trips/:tripId/cancel": { ...v, reasonCode: "plans_changed" },
    "POST /rides/:rideId/cancel": { ...v, reasonCode: "plans_changed" },
    "POST /trips/:tripId/cancel-reason": { ...v, reasonCode: "plans_changed" },
    "POST /trips/:tripId/raise-price": { ...v, increase: SEK(1000) },
    "POST /trips/:tripId/rating": { ...v, stars: 1 },
    "POST /trips/:tripId/messages": { ...v, text: "hello" },
    "POST /trips/:tripId/keep-waiting": { ...v, answer: "stop" },
    "POST /trips/:tripId/end-early": { ...v, reasonCode: "plans_changed" },
    "POST /rider/trips/:tripId/sos": { at: "2026-10-27T10:00:00Z" },
    "POST /driver/trips/:tripId/sos": { at: "2026-10-27T10:00:00Z" },
    "POST /rider/trips/:tripId/ride-check": { checkId: "rc-matrix", trigger: "long_stop", at: "2026-10-27T10:00:00Z" },
    "POST /driver/trips/:tripId/ride-check": { checkId: "rc-matrix", trigger: "long_stop", at: "2026-10-27T10:00:00Z" },
    "POST /admin/payouts": { driverId: ids["driverId"], from: "2026-10-01T00:00:00Z", to: "2026-10-08T00:00:00Z" },
    "POST /admin/tickets/:ticketId/reply": { text: "audit matrix" },
    "POST /admin/ratings/:tripId/:from/hide": { reason: "audit matrix" },
    "POST /admin/ratings/:tripId/:from/restore": { reason: "audit matrix" },
    "POST /support/tickets": { category: "help", subject: "audit matrix", text: "audit matrix" },
  };
  return bodies[route] ?? v;
}

/** A real pending approval (asked by another admin), so deciding it reaches the permission check. */
async function pendingApproval(): Promise<{ approvalId: string }> {
  const approvalId = newId("apr");
  const asker = await sim.admin("finance");
  await sim.db
    .insertInto("approvals")
    .values({ approval_id: approvalId, action: "refund.create", target_type: "trip", target_id: tripId, payload: JSON.stringify({}), approve_permission: "approval.decide", zone_id: "Z001", requested_by: asker.id, requested_at: sim.clock.now, expires_at: new Date(sim.clock.now.getTime() + 86_400_000) })
    .execute();
  return { approvalId };
}

const fill = (path: string) => path.replace(/:(\w+)/g, (_, name: string) => ids[name] ?? `missing_${name}`);

/** An admin whose role lacks `permission`; undefined when every role has it (overview.read: any signed-in admin). */
async function adminWithout(permission: string): Promise<Admin | undefined> {
  const role = ADMIN_ROLES.find((r) => r !== "super" && !permissionsOf(r).includes(permission)) as AdminRole | undefined;
  if (role === undefined) return undefined;
  const key = `without:${role}`;
  if (!admins.has(key)) admins.set(key, await sim.admin(role));
  return admins.get(key)!;
}
async function outOfZoneSuper(): Promise<Admin> {
  if (!admins.has("z002")) admins.set("z002", await sim.admin("super", ["Z002"]));
  return admins.get("z002")!;
}

describe("Phase 4: route-by-route authorization matrix", () => {
  it("every route the server serves is in the contract (or declared in EXTRA)", () => {
    const ops = contractOps();
    const unknown = serverRoutes(sim).filter((r) => !ops.has(r));
    expect(unknown).toEqual([]);
  });

  it("no token, the wrong app, a missing permission, another zone: refused on every route", async () => {
    const ops = contractOps();
    const routes = serverRoutes(sim);
    const tokens: Record<string, { token: string }> = { rider, driver: member, admin: owner };
    const failures: string[] = [];
    const before = await owner.trip(tripId);
    for (const route of routes) {
      const [method, path] = route.split(" ") as [string, string];
      const op = ops.get(route)!;
      if (op.public) continue;
      const url = fill(path);
      const body = bodyFor(route);
      if (!op.optionalAuth) {
        const res = await sim.request(method, url, undefined, body);
        if (res.status !== 401) failures.push(`${route} no token → ${res.status} ${JSON.stringify(res.body)}`);
      }
      for (const [actor, who] of Object.entries(tokens)) {
        if (op.actors.includes(actor)) continue;
        const res = await sim.request(method, url, who.token, body);
        if (res.status !== 403) failures.push(`${route} as ${actor} → ${res.status} ${JSON.stringify(res.body)}`);
      }
      if (op.actors.includes("admin") && op.permission !== undefined) {
        const lacking = await adminWithout(op.permission);
        const res = lacking ? await sim.request(method, url, lacking.token, body) : { status: 403, body: { reason: "missing_permission" } as Json };
        if (res.status !== 403 || res.body["reason"] !== "missing_permission") failures.push(`${route} without ${op.permission} → ${res.status} ${JSON.stringify(res.body)}`);
      }
      // Riders have no home zone: :riderId is in scope when the rider has a trip in the admin's zones (P4-6).
      if (op.actors.includes("admin") && path.startsWith("/admin/") && /:(tripId|driverId|fleetId|vehicleId|documentId|zoneId|adminId|approvalId|riderId|incidentId)/.test(path)) {
        const res = await sim.request(method, url, (await outOfZoneSuper()).token, body);
        if (res.status !== 403 && res.status !== 404) failures.push(`${route} by a Z002 admin on Z001 → ${res.status} ${JSON.stringify(res.body)}`);
      }
    }
    expect(failures).toEqual([]);
    const after = await owner.trip(tripId);
    expect({ status: after.status, version: after.version }).toEqual({ status: before.status, version: before.version });
    // v0.18.6 added 23 operations (Dispatch tools); every route is called many ways, so this test needs more time when the
    // whole suite runs in parallel (about 10 s alone).
  }, 60_000);

  it("P4-6: a zone-limited admin lists only riders who rode in their zones", async () => {
    const z002 = await outOfZoneSuper();
    const all = await sim.request("GET", "/admin/riders?limit=100", owner.token);
    expect(all.status).toBe(200);
    expect(JSON.stringify(all.body)).toContain(rider.id);
    const limited = await sim.request("GET", "/admin/riders?limit=100", z002.token);
    expect(limited.status).toBe(200);
    expect(JSON.stringify(limited.body)).not.toContain(rider.id);
    const byId = await sim.request("GET", `/admin/riders?q=${rider.id}`, z002.token);
    expect(byId.body["items"]).toEqual([]);
  });

  it("owner-scoped routes: another rider, another driver, a fleet member who is not the owner", async () => {
    const ops = contractOps();
    const failures: string[] = [];
    for (const route of serverRoutes(sim)) {
      const [method, path] = route.split(" ") as [string, string];
      const op = ops.get(route)!;
      if (op.public) continue;
      const body = bodyFor(route);
      if (op.actors.includes("rider") && /:(tripId|rideId)/.test(path)) {
        const res = await sim.request(method, fill(path), otherRider.token, body);
        if (res.status !== 404 && res.status !== 403) failures.push(`${route} by another rider → ${res.status} ${JSON.stringify(res.body)}`);
      }
      if (op.actors.includes("driver") && /:(tripId|offerId|documentId)/.test(path)) {
        // The member is not on the trip, never got the offer, and the document is the fleet owner's own.
        const res = await sim.request(method, fill(path), member.token, body);
        if (res.status !== 404 && res.status !== 403) failures.push(`${route} by another driver → ${res.status} ${JSON.stringify(res.body)}`);
      }
    }
    // Fleet-owner-only commands, by a member of the same fleet.
    for (const [method, path, body] of [
      ["POST", "/driver/fleet/invite", { phone: "+46701740697" }],
      ["POST", `/driver/fleet/drivers/${otherDriver.id}/remove`, {}],
      ["POST", `/driver/fleet/invitations/${ids["invitationId"]}/cancel`, {}],
      ["GET", "/driver/fleet/earnings", undefined],
    ] as const) {
      const res = await sim.request(method, path, member.token, body);
      if (res.status !== 403 && res.status !== 404) failures.push(`${method} ${path} by a fleet member → ${res.status} ${JSON.stringify(res.body)}`);
    }
    expect(failures).toEqual([]);
    const fleet = (await fleetOwner.get("/driver/fleet")).body;
    expect(JSON.stringify(fleet)).toContain(otherDriver.id);
  });
});
