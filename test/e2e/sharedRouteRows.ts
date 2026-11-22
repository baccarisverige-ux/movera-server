import type { Json } from "./harness.js";
import type { Op } from "./routeMatrix.js";

/**
 * T11 (global plan step 66): one row for every route the contract gives to more than one actor (rider / driver /
 * admin on the same resource). The row says what the route's id points at, so the matrix knows who owns it:
 * - trip: the trip's rider and its driver own it; any other rider or driver gets 403 or 404.
 * - ticket: the rider who opened the ticket owns it; anyone else gets 403 or 404.
 * - call: an in-app call between the trip's rider and driver; anyone else gets 403 or 404.
 * - notification: a notification id nobody has (the owner cell is 404; owning a real one is NOT CHECKED here).
 * - payment: pay_<tripId>; only the trip's rider owns it (any other rider gets 404). `cashOnly` routes answer the
 *   typed 400 payment_method_not_available to a caller who passed authorization (v0.18.61 §83).
 * - self: no id; the caller acts on their own account (every allowed actor is "owner").
 * `admin` is the permission an admin needs, when the contract lets admins call the route. For the trip read and its
 * live events the contract names none; step 25 (U10, Q 34) decided trips.read + the trip's zone.
 * `last` routes end something (a call, the session), so they run after every other row; `signOut` runs at the very end.
 */
export type Scope = "trip" | "ticket" | "call" | "notification" | "payment" | "self";
export type Row = { scope: Scope; admin?: string; cashOnly?: true; last?: true; signOut?: true };

export const SHARED_ROWS: Record<string, Row> = {
  "POST /auth/sign-out": { scope: "self", last: true, signOut: true },
  "POST /push/devices": { scope: "self" },
  "POST /push/devices/unregister": { scope: "self" },
  "GET /trips/:tripId": { scope: "trip", admin: "trips.read" },
  "POST /trips/:tripId/cancel": { scope: "trip" },
  "GET /trips/:tripId/events": { scope: "trip", admin: "trips.read" },
  "POST /trips/:tripId/rating": { scope: "trip" },
  "GET /notifications": { scope: "self" },
  "POST /notifications/:notificationId/read": { scope: "notification" },
  "GET /trips/:tripId/messages": { scope: "trip", admin: "support.reply" },
  "POST /trips/:tripId/messages": { scope: "trip", admin: "support.reply" },
  // v0.18.56 §78: the trip's rider and driver only (no admin).
  "GET /trips/:tripId/messages/options": { scope: "trip" },
  "POST /trips/:tripId/messages/translate": { scope: "trip" },
  "POST /trips/:tripId/call": { scope: "trip" },
  // v0.18.144 (contract.json#liveLocation): the trip's rider and driver only (no admin).
  "PUT /trips/:tripId/live-location": { scope: "trip" },
  "GET /support/tickets": { scope: "self" },
  "POST /support/tickets": { scope: "self" },
  "GET /support/tickets/:ticketId": { scope: "ticket" },
  "POST /support/tickets/:ticketId/messages": { scope: "ticket" },
  "POST /support/tickets/:ticketId/feedback": { scope: "ticket" },
  "GET /support/topics": { scope: "self" },
  "POST /locations/autocomplete": { scope: "self" },
  "POST /locations/geocode": { scope: "self" },
  "POST /locations/reverse-geocode": { scope: "self" },
  "POST /routes": { scope: "self" },
  "POST /telemetry/logs": { scope: "self" },
  "POST /telemetry/analytics": { scope: "self" },
  "POST /telemetry/crashes": { scope: "self" },
  "GET /trips/:tripId/path": { scope: "trip" },
  "POST /account/terms/accept": { scope: "self" },
  "POST /account/legal/accept": { scope: "self" },
  "POST /account/phone/change": { scope: "self" },
  "POST /account/phone/verify": { scope: "self" },
  "POST /account/email/change": { scope: "self" },
  "POST /account/email/verify": { scope: "self" },
  // v0.18.61 §83: the trip's rider, or an admin with finance.read and the trip's zone; cash-only → typed 400.
  "GET /payments/:paymentId": { scope: "payment", admin: "finance.read", cashOnly: true },
  "POST /calls/:callId/signal": { scope: "call" },
  "POST /calls/:callId/answer": { scope: "call" },
  "POST /calls/:callId/end": { scope: "call", last: true },
};

/** Shared (more than one actor), signed-in routes the server really serves. Public sign-in routes are not authorization rows. */
export function sharedServedRoutes(served: readonly string[], ops: Map<string, Op>): string[] {
  return served.filter((route) => {
    const op = ops.get(route);
    return op !== undefined && !op.public && Array.isArray(op.actors) && op.actors.length > 1;
  });
}

/** The guard: a shared served route without a row, or a row for a route nobody serves any more. */
export function missingRows(shared: readonly string[], rows: Record<string, Row>, served: readonly string[]): { withoutRow: string[]; staleRows: string[] } {
  return {
    withoutRow: shared.filter((route) => !(route in rows)),
    staleRows: Object.keys(rows).filter((route) => !served.includes(route)),
  };
}

/** A valid body per write, so a refused caller is refused by authorization and not by a 400 schema answer. */
export function validBody(route: string, actor: string): Json | undefined {
  if (route.startsWith("GET ")) return undefined;
  const v = { expectedVersion: 1 };
  const bodies: Record<string, Json> = {
    "POST /trips/:tripId/cancel": actor === "driver" ? { ...v, reasonCode: "rider_no_show" } : { ...v, reasonCode: "plans_changed" },
    "POST /trips/:tripId/rating": { ...v, stars: 1 },
    "POST /trips/:tripId/messages": { ...v, text: "matrix" },
    "POST /trips/:tripId/call": {},
    "PUT /trips/:tripId/live-location": { sharing: false },
    "POST /support/tickets/:ticketId/messages": { text: "matrix" },
    "POST /support/tickets/:ticketId/feedback": { text: "matrix" },
    "POST /calls/:callId/signal": { type: "ice", candidate: { candidate: "candidate:matrix" } },
    "POST /calls/:callId/answer": {},
    "POST /calls/:callId/end": { reason: "hangup" },
  };
  return bodies[route] ?? {};
}
