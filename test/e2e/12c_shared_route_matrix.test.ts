import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_ROLES, permissionsOf, type AdminRole } from "../../src/admin/permissions.js";
import { newId } from "../../src/ids.js";
import { bookAndAccept, PLACES, Sim, type Json } from "./harness.js";
import { contractOps, serverRoutes, type Op } from "./routeMatrix.js";
import { SHARED_ROWS, sharedServedRoutes, validBody, type Row } from "./sharedRouteRows.js";

/**
 * T11 (global plan step 66): the authorization matrix of the shared routes. Every route the contract gives to more
 * than one actor is called by every caller: no token, the owning rider, another rider, the owning driver, another
 * driver, an admin of each of the 11 roles (all zones) and a Super admin limited to another zone (Z002; the trip
 * is in Z001). Each cell expects one answer: ok (passed authorization), 401, 403, or denied (403 or 404).
 * Step 25's case (an admin without trips.read, or outside the trip's zone, must not read a trip or its live events)
 * is a row of this matrix; the cells step 25 fixed are listed in FIXED_STEP25.
 */

type Caller = { name: string; actor: "none" | "rider" | "driver" | "admin"; token?: string; owner?: boolean; role?: AdminRole; outOfZone?: boolean };
type Expect = "ok" | "401" | "403" | "denied";

/**
 * Step 25 (U10, Q 34) fixed the last known bugs of this matrix: an admin reads a trip and its live events only with
 * trips.read and the trip's zone. These cells were `it.fails` before the fix; now they are normal expectations.
 */
export const FIXED_STEP25: readonly string[] = ["GET /trips/:tripId", "GET /trips/:tripId/events"].flatMap((route) => [
  ...["compliance", "finance", "content", "config", "fleet"].map((role) => `${route} × admin ${role}`),
  `${route} × admin super Z002`,
]);

let sim: Sim;
const callers: Caller[] = [];
const ids: Record<string, string> = {};
const ops = contractOps();

beforeAll(async () => {
  sim = await Sim.start();
  const rider = await sim.rider(0);
  const otherRider = await sim.rider(1);
  const driver = await sim.driver(0, PLACES.nearSergels);
  const otherDriver = await sim.driver(1, null);
  const { tripId } = await bookAndAccept(sim, rider, driver);
  const ticket = await rider.post("/support/tickets", { category: "help", subject: "matrix", text: "matrix" });
  const call = await rider.post(`/trips/${tripId}/call`, {});
  Object.assign(ids, {
    tripId,
    ticketId: (ticket.body["ticketId"] as string | undefined) ?? newId("tkt"),
    callId: (call.body["callId"] as string | undefined) ?? newId("cll"),
    notificationId: newId("ntf"),
    paymentId: `pay_${tripId}`,
  });
  callers.push(
    { name: "no token", actor: "none" },
    { name: "other rider", actor: "rider", token: otherRider.token },
    { name: "other driver", actor: "driver", token: otherDriver.token },
  );
  for (const role of ADMIN_ROLES) callers.push({ name: `admin ${role}`, actor: "admin", role, token: (await sim.admin(role)).token });
  callers.push({ name: "admin super Z002", actor: "admin", role: "super", outOfZone: true, token: (await sim.admin("super", ["Z002"])).token });
  // The owners go last on each route, so a refused caller never sees a trip the owner already changed.
  callers.push({ name: "owner rider", actor: "rider", owner: true, token: rider.token }, { name: "owner driver", actor: "driver", owner: true, token: driver.token });
}, 60_000);
afterAll(async () => {
  await sim?.stop();
});

/** What a caller must get on a route, from the contract's x-actor and the row's scope and admin permission. */
export function expected(route: string, op: Op, row: Row, caller: Caller): Expect {
  if (caller.actor === "none") return op.optionalAuth ? "ok" : "401";
  if (!op.actors.includes(caller.actor)) return "403";
  if (caller.actor === "admin") {
    if (row.scope === "self") return "ok";
    if (row.admin !== undefined && !permissionsOf(caller.role!).includes(row.admin)) return "403";
    return caller.outOfZone ? "denied" : "ok";
  }
  if (row.scope === "self") return "ok";
  if (row.scope === "notification") return "denied";
  // A rider's ticket (and payment) is only that rider's.
  if (row.scope === "ticket" || row.scope === "payment") return caller.owner && caller.actor === "rider" ? "ok" : "denied";
  return caller.owner ? "ok" : "denied";
}

function matches(want: Expect, status: number, method: string, body: unknown, row: Row): boolean {
  // v0.18.61 §83: a cash-only route answers a caller who passed authorization with the typed 400.
  if (want === "ok" && row.cashOnly) return status === 400 && (body as { reason?: string } | null)?.reason === "payment_method_not_available";
  if (want === "401") return status === 401;
  if (want === "403") return status === 403;
  if (want === "denied") return status === 403 || status === 404;
  // ok: authorization let the caller through. A read answers 2xx (409: the path of a trip not ended yet); a write may
  // still be refused for its content.
  if (method === "GET") return (status >= 200 && status < 300) || status === 409;
  return (status >= 200 && status < 300) || status === 400 || status === 409 || status === 422;
}

const fill = (path: string) => path.replace(/:(\w+)/g, (_, name: string) => ids[name] ?? `missing_${name}`);
/** The owner's cancel goes with an empty body (400): the matrix proves the owner passes, without ending the trip. */
const bodyOf = (route: string, caller: Caller): Json | undefined => (caller.owner && route === "POST /trips/:tripId/cancel" ? {} : validBody(route, caller.actor));

async function cell(route: string, caller: Caller): Promise<{ key: string; ok: boolean; detail: string }> {
  const op = ops.get(route)!;
  const row = SHARED_ROWS[route]!;
  const want = expected(route, op, row, caller);
  const [method, path] = route.split(" ") as [string, string];
  const res = await sim.request(method, fill(path), caller.token, bodyOf(route, caller));
  const key = `${route} × ${caller.name}`;
  return { key, ok: matches(want, res.status, method, res.body, row), detail: `${key}: want ${want}, got ${res.status} ${JSON.stringify(res.body).slice(0, 160)}` };
}

describe("T11: authorization matrix of the shared routes", () => {
  for (const key of FIXED_STEP25) {
    it(`step 25 (U10): ${key} is refused`, async () => {
      const [route, name] = key.split(" × ") as [string, string];
      const result = await cell(route, callers.find((c) => c.name === name)!);
      expect(result.ok, result.detail).toBe(true);
    });
  }

  it("every shared route × every caller answers as the matrix expects", async () => {
    const shared = sharedServedRoutes(serverRoutes(sim), ops);
    const rank = (r: string) => (SHARED_ROWS[r]?.signOut ? 2 : SHARED_ROWS[r]?.last ? 1 : 0);
    const ordered = [...shared].sort((a, b) => rank(a) - rank(b));
    const failures: string[] = [];
    let cells = 0;
    for (const route of ordered) {
      for (const caller of callers) {
        const result = await cell(route, caller);
        cells += 1;
        if (!result.ok) failures.push(result.detail);
      }
    }
    console.log(`T11 shared matrix: ${ordered.length} routes × ${callers.length} callers = ${cells} cells, 0 known bugs`);
    expect(failures).toEqual([]);
  }, 120_000);

  it("step 25: the live stream (SSE) of /events refuses an admin outside the trip's zone and one without trips.read", async () => {
    const sse = { headers: { accept: "text/event-stream" } };
    const out = callers.find((c) => c.name === "admin super Z002")!;
    const outRes = await sim.request("GET", `/trips/${ids["tripId"]}/events`, out.token, undefined, sse);
    expect(outRes.status).toBe(403);
    expect(outRes.body).toMatchObject({ reason: "zone_out_of_scope" });
    const finance = callers.find((c) => c.name === "admin finance")!;
    const permRes = await sim.request("GET", `/trips/${ids["tripId"]}/events`, finance.token, undefined, sse);
    expect(permRes.status).toBe(403);
    expect(permRes.body).toMatchObject({ reason: "missing_permission" });
    const ops = callers.find((c) => c.name === "admin super")!;
    const stream = await sim.stream(`/trips/${ids["tripId"]}/events`, ops.token!);
    expect(stream).toBeDefined();
  });
});
