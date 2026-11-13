import { addTripNote, flagTrip, openTripCase, revealTripContact, tripNotes } from "./tripTools.js";
import { adminDriverPay, adminReceipt, resendReceipt } from "../trips/finish.js";
import { ModerationBody } from "../riders/moderation.js";
import { WalletCreditBody, creditRiderWallet } from "../riders/walletCredit.js";
import { FeeMarkPaidBody, markRiderFeePaid } from "../riders/feeMarkPaid.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticate, authenticateAdmin, type Principal } from "../auth/guard.js";
import type { Db, Trx } from "../db/db.js";
import { API_PREFIX } from "../http/prefix.js";
import { runIdempotent } from "../http/idempotency.js";
import { parseBody } from "../http/validate.js";
import { narrowToZones, parseQuery, withoutZoneFilter, ZoneFilterQuery } from "./zoneFilter.js";
import { chooseRefundDestination, getWallet, payoutsToMake, riderRefunds, walletEntries } from "../riders/wallet.js";
import { tripProjection } from "../trips/projection.js";
import { withDriverPosition } from "../trips/service.js";
import { activeSendOf } from "../dispatch/radarSends.js";
import { listAudit, listDrivers, listPayments, listRiders, listTrips, setDriverStatus, setRiderStatus, moderateRider } from "./lists.js";
import { audit } from "./audit.js";
import { adminAdjust, adminAssign, adminCancel, adminComplete, adminDriverBonus, adminNoShow, adminReverseNoShow, adminPinUnlock, adminRadarGroup, adminReassign, adminStopRadarZone, adminRefund, adminTrip, markRefundPaid, nearbyDrivers, tripOffers } from "./trips.js";

/** contract §3.1, §7: the admin's trip tools, lists, account status, audit; the rider's wallet and refunds. */

export type AdminTripDeps = { db: Db; jwtSecret: string; currency: string; clock?: () => Date };

const ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const Money = z.object({ amountMinor: z.number().int(), currency: z.string().regex(/^[A-Z]{3}$/) });
const Version = { expectedVersion: z.number().int().min(1) };
const Note = z.string().min(1).max(1000);
const many = <T extends z.ZodTypeAny>(item: T) => z.union([item, z.array(item)]).optional().transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v]));
const Page = { cursor: z.string().max(512).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) };
const When = { from: z.string().datetime().optional(), to: z.string().datetime().optional() };

// Owner bug 2026-11-01: which kind of offer the admin's money is for (default: the send's kind; Add money: both).
const ApplyTo = z.enum(["exclusive", "radar", "both"]);
const ReasonBody = z.object({ ...Version, reasonCode: z.string(), note: Note, driverBonus: Money.optional() });
const AssignBody = z.object({ ...Version, driverId: ID, note: z.string().max(1000).optional(), driverBonus: Money.optional(), priority: z.boolean().optional(), applyTo: ApplyTo.optional() });
const RadarBody = z.object({ ...Version, driverIds: z.array(ID).min(1).max(10).optional(), groupId: ID.optional(), radarZoneId: ID.optional(), ruleId: ID.optional(), note: z.string().max(1000).optional(), driverBonus: Money.optional(), priority: z.boolean().optional(), applyTo: ApplyTo.optional() });
const NoShowBody = z.object({ ...Version, note: Note, waiveFee: z.boolean().optional() });
const CompleteBody = z.object({ ...Version, note: Note, fare: Money.optional() });
const AdjustBody = z.object({ ...Version, fare: Money.optional(), waitingSeconds: z.number().int().min(0).optional(), waiveCancelFee: z.boolean().optional(), reason: Note });
const RefundBody = z.object({ ...Version, amount: Money, paymentId: z.string().optional(), reason: Note, fromDriver: z.boolean().optional() });
const BonusBody = z.object({ ...Version, amount: Money, priority: z.boolean().optional(), note: z.string().max(1000).optional(), applyTo: ApplyTo.optional() });
const DriverStatusBody = z.object({ ...Version, accountStatus: z.enum(["pending", "active", "on_hold", "suspended"]), note: Note });
const RiderStatusBody = z.object({ ...Version, status: z.enum(["active", "suspended"]), note: Note });

const TripsQuery = { ...Page, ...When, flagged: z.enum(["true", "false"]).optional().transform((v) => (v === undefined ? undefined : v === "true")), status: many(z.string()), kind: z.enum(["live", "scheduled"]).optional(), categoryId: z.string().optional(), riderId: ID.optional(), driverId: ID.optional(), paymentStatus: z.string().optional(), q: z.string().max(100).optional(), ...ZoneFilterQuery };
const RidersQuery = { ...Page, status: z.enum(["active", "suspended"]).optional(), q: z.string().max(100).optional(), ...ZoneFilterQuery };
const DriversQuery = { ...Page, accountStatus: many(z.string()), onlineStatus: many(z.string()), categoryId: z.string().optional(), q: z.string().max(100).optional(), ...ZoneFilterQuery };
const PaymentsQuery = { ...Page, ...When, status: z.string().optional(), method: z.string().optional(), tripId: ID.optional(), riderId: ID.optional(), ...ZoneFilterQuery };
const AuditQuery = z.object({ ...Page, ...When, actorId: z.string().optional(), targetType: z.string().optional(), targetId: z.string().optional(), action: z.string().optional(), result: z.string().optional() });
const NearbyQuery = z.object({ scope: z.enum(["radius", "zone", "zone_and_neighbours"]).default("radius"), radiusKm: z.coerce.number().min(0.1).max(100).optional() });
const OffersQuery = z.object(Page);
const PayoutsQuery = z.object({ payoutStatus: z.enum(["pending", "paid"]).default("pending") });

const keyOf = (request: FastifyRequest) => {
  const value = request.headers["idempotency-key"];
  return Array.isArray(value) ? value[0] : value;
};
const clean = <T extends Record<string, unknown>>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

export async function adminTripRoutes(app: FastifyInstance, deps: AdminTripDeps): Promise<void> {
  const guard = { db: deps.db, jwtSecret: deps.jwtSecret, ...(deps.clock ? { clock: deps.clock } : {}) };
  const now = () => deps.clock?.() ?? new Date();
  const idem = (request: FastifyRequest, who: Principal) => ({ actor: who.actor as "admin" | "rider", subjectId: who.subjectId, key: keyOf(request), method: request.method, route: request.url.split("?")[0]!, body: request.body ?? null });
  const tripParam = (request: FastifyRequest) => parseBody(z.object({ tripId: ID }), request.params).tripId;

  /* ---- reads */
  app.get(`${API_PREFIX}/admin/trips`, async (request) => {
    const who = await authenticateAdmin(request, guard, "trips.read");
    const query = parseQuery(TripsQuery, request.query);
    return listTrips(deps.db, await narrowToZones(deps.db, who, query), clean(withoutZoneFilter(query)) as never, now());
  });
  app.get(`${API_PREFIX}/admin/trips/:tripId`, async (request) => {
    const who = await authenticateAdmin(request, guard, "trips.read");
    const trip = await adminTrip(deps.db, who, tripParam(request));
    // v0.18.6 (G4-F4): the repeating radar-zone send, while one runs, for every admin who opens the trip.
    const radarZoneSend = await activeSendOf(deps.db, trip.trip_id);
    // v0.18.7 (contract.json#pickupWaiting.adminLiveRow): the driver's position and the live ETA, like the list rows.
    return { ...(await withDriverPosition(deps.db, trip, tripProjection(trip, "admin", { now: now() }), now())), ...(radarZoneSend ? { radarZoneSend } : {}) };
  });
  app.get(`${API_PREFIX}/admin/trips/:tripId/offers`, async (request) => {
    const who = await authenticateAdmin(request, guard, "trips.read");
    const trip = await adminTrip(deps.db, who, tripParam(request));
    return tripOffers(deps.db, trip, clean(parseBody(OffersQuery, request.query)));
  });
  app.get(`${API_PREFIX}/admin/trips/:tripId/nearby-drivers`, async (request) => {
    const who = await authenticateAdmin(request, guard, "trips.read");
    const trip = await adminTrip(deps.db, who, tripParam(request));
    return nearbyDrivers(deps.db, trip, clean(parseBody(NearbyQuery, request.query)), now());
  });
  app.get(`${API_PREFIX}/admin/riders`, async (request) => {
    const who = await authenticateAdmin(request, guard, "riders.read");
    const query = parseQuery(RidersQuery, request.query);
    return listRiders(deps.db, await narrowToZones(deps.db, who, query), clean(withoutZoneFilter(query)), deps.currency);
  });
  app.get(`${API_PREFIX}/admin/drivers`, async (request) => {
    const who = await authenticateAdmin(request, guard, "drivers.read");
    const query = parseQuery(DriversQuery, request.query);
    return listDrivers(deps.db, await narrowToZones(deps.db, who, query), clean(withoutZoneFilter(query)) as never);
  });
  app.get(`${API_PREFIX}/admin/payments`, async (request) => {
    const who = await authenticateAdmin(request, guard, "finance.read");
    const query = parseQuery(PaymentsQuery, request.query);
    return listPayments(deps.db, await narrowToZones(deps.db, who, query), clean(withoutZoneFilter(query)));
  });
  app.get(`${API_PREFIX}/admin/audit`, async (request) => {
    const who = await authenticateAdmin(request, guard, "audit.read");
    return listAudit(deps.db, who, clean(parseBody(AuditQuery, request.query)));
  });
  app.get(`${API_PREFIX}/admin/refunds/payouts`, async (request) => {
    const who = await authenticateAdmin(request, guard, "finance.read");
    const status = parseBody(PayoutsQuery, request.query).payoutStatus;
    // v0.18.54 §76 (contract.json#adminMasking.notMasked.refundPayouts): the full account stays (the money must reach
    // the right person) but every read writes one audit row with the count, never the numbers.
    return deps.db.transaction().execute(async (trx) => {
      const page = await payoutsToMake(trx, { status, zones: who.zones.includes("*") ? null : who.zones });
      await audit(trx, { adminId: who.subjectId, action: "refunds.payouts_viewed", targetType: "refunds", targetId: "payouts", detail: { count: page.items.length }, at: now() });
      return page;
    });
  });

  /* ---- trip commands */
  const command = <B extends z.ZodTypeAny>(path: string, permission: string, schema: B, run: (trx: Trx, who: Principal, tripId: string, body: z.infer<B>) => Promise<{ status: number; body: unknown }>) => {
    app.post(`${API_PREFIX}/admin/trips/:tripId/${path}`, async (request, reply) => {
      const who = await authenticateAdmin(request, guard, permission);
      const tripId = tripParam(request);
      const body = parseBody(schema, request.body);
      const result = await runIdempotent(deps.db, idem(request, who), async (trx) => run(trx, who, tripId, body));
      return reply.status(result.status).send(result.body);
    });
  };
  const view = async (trip: Promise<Parameters<typeof tripProjection>[0]>) => ({ status: 200, body: tripProjection(await trip, "admin") });

  command("cancel", "trips.intervene", ReasonBody, (trx, who, id, body) => view(adminCancel(trx, who, id, clean(body) as never, now())));
  command("reassign", "trips.intervene", ReasonBody, (trx, who, id, body) => view(adminReassign(trx, who, id, clean(body) as never, now())));
  command("assign", "trips.intervene", AssignBody, (trx, who, id, body) => view(adminAssign(trx, who, id, clean(body) as never, now())));
  command("radar-group", "trips.intervene", RadarBody, async (trx, who, id, body) => ({ status: 200, body: await adminRadarGroup(trx, who, id, clean(body) as never, now()) }));
  // v0.18.6 (G4-F4): stop the repeating radar-zone send of a trip.
  command("radar-zone/stop", "trips.intervene", z.object({ note: z.string().max(1000).optional() }), async (trx, who, id, body) => ({ status: 200, body: await adminStopRadarZone(trx, who, id, clean(body) as never, now()) }));
  command("no-show", "trips.intervene", NoShowBody, (trx, who, id, body) => view(adminNoShow(trx, who, id, clean(body) as never, now())));
  // v0.18.8 (contract.json#arrivedWaiting.reverseNoShow): reason required; the driver keeps his share unless taken back.
  command("reverse-no-show", "trips.intervene", z.object({ expectedVersion: z.number().int().min(1), reason: z.string().trim().min(1).max(1000), takeBackDriverShare: z.boolean().optional() }), (trx, who, id, body) => view(adminReverseNoShow(trx, who, id, clean(body) as never, now())));
  command("pin/unlock", "trips.intervene", z.object({ expectedVersion: z.number().int().min(1), reason: z.string().trim().min(1).max(1000) }), (trx, who, id, body) => view(adminPinUnlock(trx, who, id, clean(body) as never, now())));
  command("complete", "trips.intervene", CompleteBody, (trx, who, id, body) => view(adminComplete(trx, who, id, clean(body) as never, now())));
  command("driver-bonus", "trips.intervene", BonusBody, async (trx, who, id, body) => {
    const trip = await adminDriverBonus(trx, who, id, clean(body) as never, now());
    // Owner decision 2026-11-01: who got the money at once (exclusive to the nearest, radar to the others).
    return { status: 200, body: { ...tripProjection(trip, "admin"), ...(trip.moneySend ? { moneySend: trip.moneySend } : {}) } };
  });
  command("adjust", "trips.intervene", AdjustBody, (trx, who, id, body) => adminAdjust(trx, who, id, clean(body) as never, now()));
  command("refund", "payments.refund", RefundBody, (trx, who, id, body) => {
    const { paymentId: _p, ...rest } = clean(body);
    void _p;
    return adminRefund(trx, who, id, rest as never, now());
  });

  /* ---- v0.18.9 (contract.json#onTrip.adminTrip.new): flag, notes, case, reveal contact; no trip version change */
  const tool = <B extends z.ZodTypeAny>(path: string, permission: string, schema: B, status: number, run: (trx: Trx, who: Principal, tripId: string, body: z.infer<B>) => Promise<unknown>) => {
    app.post(`${API_PREFIX}/admin/trips/:tripId/${path}`, async (request, reply) => {
      const who = await authenticateAdmin(request, guard, permission);
      const tripId = tripParam(request);
      const body = parseBody(schema, request.body);
      const result = await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status, body: await run(trx, who, tripId, body) }));
      return reply.status(result.status).send(result.body);
    });
  };
  tool("flag", "trips.annotate", z.object({ flagged: z.boolean(), reason: z.string().trim().max(500).optional() }), 200, (trx, who, id, body) => flagTrip(trx, who, id, clean(body) as never, now()));
  tool("notes", "trips.annotate", z.object({ text: z.string().trim().min(1).max(2000) }), 201, (trx, who, id, body) => addTripNote(trx, who, id, body, now()));
  tool("case", "support.reply", z.object({ about: z.enum(["rider", "driver"]), category: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), subject: z.string().trim().min(1).max(200), text: z.string().trim().min(1).max(5000), visibleToPerson: z.boolean().optional() }), 201, (trx, who, id, body) => openTripCase(trx, who, id, body, now()));
  // The permission is checked per side inside (riders.viewSensitive / drivers.viewSensitive).
  // Checker MEDIUM: no idempotent replay cache here (it would keep the phone number in idempotency_keys).
  app.post(`${API_PREFIX}/admin/trips/:tripId/reveal-contact`, async (request, reply) => {
    const who = await authenticateAdmin(request, guard, "trips.read");
    const tripId = tripParam(request);
    const body = parseBody(z.object({ who: z.enum(["rider", "driver"]), reason: z.string().trim().min(1).max(500) }), request.body);
    return reply.status(200).send(await deps.db.transaction().execute((trx) => revealTripContact(trx, who, tripId, body, now())));
  });
  // v0.18.10 (contract.json#finish.receipt, finish.driverMoney): receipt, resend it, change the driver's pay.
  app.get(`${API_PREFIX}/admin/trips/:tripId/receipt`, async (request) => {
    const who = await authenticateAdmin(request, guard, "trips.read");
    return adminReceipt(deps.db, who, tripParam(request));
  });
  tool("receipt/resend", "trips.intervene", z.object({ reason: z.string().trim().min(1).max(1000) }), 200, (trx, who, id, body) => resendReceipt(trx, who, id, body, now()));
  // The trip's zone is checked before the body (another zone's admin gets 403, never a body error).
  tool("driver-pay", "finance.edit", z.unknown(), 200, async (trx, who, id, raw) => {
    await adminTrip(trx, who, id);
    const body = parseBody(z.object({ expectedVersion: z.number().int().min(1), change: Money, reason: z.string().trim().min(1).max(1000) }), raw);
    return tripProjection(await adminDriverPay(trx, who, id, body, now()), "admin");
  });
  app.get(`${API_PREFIX}/admin/trips/:tripId/notes`, async (request) => {
    const who = await authenticateAdmin(request, guard, "trips.read");
    return tripNotes(deps.db, who, tripParam(request));
  });

  app.post(`${API_PREFIX}/admin/refunds/:refundId/paid`, async (request) => {
    const who = await authenticateAdmin(request, guard, "finance.edit");
    const { refundId } = parseBody(z.object({ refundId: ID }), request.params);
    const body = parseBody(z.object({ note: z.string().max(1000).optional() }), request.body ?? {});
    return (await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: await markRefundPaid(trx, who, refundId, clean(body), now()) }))).body;
  });

  /* ---- account status */
  app.post(`${API_PREFIX}/admin/drivers/:driverId/status`, async (request) => {
    const who = await authenticateAdmin(request, guard, "drivers.activate");
    const { driverId } = parseBody(z.object({ driverId: ID }), request.params);
    const body = parseBody(DriverStatusBody, request.body);
    return (await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: await setDriverStatus(trx, who, driverId, body, now()) }))).body;
  });
  app.post(`${API_PREFIX}/admin/riders/:riderId/status`, async (request) => {
    const who = await authenticateAdmin(request, guard, "riders.block");
    const { riderId } = parseBody(z.object({ riderId: ID }), request.params);
    const body = parseBody(RiderStatusBody, request.body);
    return (await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: await setRiderStatus(trx, who, riderId, body, deps.currency, now()) }))).body;
  });

  // v0.18.39 A2 (owner G16 Q16-2): Warn → Pause → Ban with a reason; level none undoes it.
  app.post(`${API_PREFIX}/admin/riders/:riderId/moderation`, async (request) => {
    const who = await authenticateAdmin(request, guard, "riders.block");
    const { riderId } = parseBody(z.object({ riderId: ID }), request.params);
    const body = parseBody(ModerationBody, request.body);
    return (await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: await moderateRider(trx, who, riderId, body, deps.currency, now()) }))).body;
  });

  // v0.18.39 A2 (owner G12 Q5, build-spec Q2): Add money to wallet, the one way to give a rider money.
  app.post(`${API_PREFIX}/admin/riders/:riderId/wallet-credit`, async (request) => {
    const who = await authenticateAdmin(request, guard, "finance.edit");
    const { riderId } = parseBody(z.object({ riderId: ID }), request.params);
    const body = parseBody(WalletCreditBody, request.body);
    return (await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: await creditRiderWallet(trx, who, riderId, body, now()) }))).body;
  });

  // v0.18.39 fix job 0 (owner A2-2): Mark as paid on an owed fee, with a reason (no "Ask rider to pay").
  app.post(`${API_PREFIX}/admin/riders/:riderId/fees/:tripId/mark-paid`, async (request) => {
    const who = await authenticateAdmin(request, guard, "finance.edit");
    const { riderId, tripId } = parseBody(z.object({ riderId: ID, tripId: ID }), request.params);
    const body = parseBody(FeeMarkPaidBody, request.body);
    return (await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: await markRiderFeePaid(trx, who, riderId, tripId, body, deps.currency, now()) }))).body;
  });

  /* ---- the rider's wallet and refunds */
  app.get(`${API_PREFIX}/wallet`, async (request) => {
    const who = await authenticate(request, guard, ["rider"]);
    // v0.18.28 (owner Q4): ?currency= picks the balance; without it, the currency of the rider's zone.
    const { currency } = parseBody(z.object({ currency: z.string().regex(/^[A-Z]{3}$/).optional() }), request.query);
    return getWallet(deps.db, who.subjectId, deps.currency, currency);
  });
  app.get(`${API_PREFIX}/wallet/entries`, async (request) => {
    const who = await authenticate(request, guard, ["rider"]);
    return walletEntries(deps.db, who.subjectId, clean(parseBody(z.object({ ...Page, ...When }), request.query)));
  });
  app.get(`${API_PREFIX}/rider/refunds`, async (request) => {
    const who = await authenticate(request, guard, ["rider"]);
    return riderRefunds(deps.db, who.subjectId);
  });
  app.post(`${API_PREFIX}/rider/refunds/:refundId/destination`, async (request) => {
    const who = await authenticate(request, guard, ["rider"]);
    const { refundId } = parseBody(z.object({ refundId: ID }), request.params);
    return (await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: await chooseRefundDestination(trx, who.subjectId, refundId, request.body ?? {}, now()) }))).body;
  });
}
