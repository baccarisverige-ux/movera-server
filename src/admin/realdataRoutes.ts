import { giveUpStream, readRetry } from "../realtime/retry.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import { authenticate, authenticateAdmin, type Principal } from "../auth/guard.js";
import type { Db, Executor } from "../db/db.js";
import { ApiError, badRequest } from "../http/errors.js";
import { runIdempotent } from "../http/idempotency.js";
import { API_PREFIX } from "../http/prefix.js";
import { parseBody } from "../http/validate.js";
import { narrowToZones, parseQuery, withoutZoneFilter, ZoneFilterQuery } from "./zoneFilter.js";
import type { NotificationHub } from "../realtime/hub.js";
import { openEventStream, wantsEventStream } from "../realtime/sse.js";
import { SettledCursor } from "../realtime/settled.js";
import { DISPATCH_EVENTS_CHANNEL, dispatchEventOf, dispatchEventsAfter, mayHearDispatch } from "../dispatch/feed.js";
import { adminDeskCommand, adminReply, adminTicket, adminTickets, openTicket, ownTicket, ownTickets, writeOwnTicket, giveFeedback, type DeskCommand } from "../support/tickets.js";
import { reviewDone, reviewQueue, reviewRulesOf, saveReviewRules } from "./reviewRules.js";
import { incidentSettings, recordReport, saveIncidentSettings } from "../safety/incidentDesk.js";
import { alertBook, alertCommand, alertHistory, saveDoc, setMute, setQuiet, type AlertCommand } from "./alerts.js";
import { adminGetSettings, adminPutSettings, SUPPORT_COUNTRIES, topicsFor } from "../support/desk.js";
import { kpis } from "./kpis.js";
import { cursorOf, readCursor, zonesOf } from "./lists.js";
import { countTotal, totalAfterPage, withTotal } from "./listTotal.js";
import { approvePayoutRun, createPayout, driverPayouts, holdDriverPayouts, listPayouts, markPayoutPaid } from "./payouts.js";
import { driverView, loadDriver } from "../drivers/service.js";
import { listRatings, moderateRating } from "./ratings.js";
import { riskSignals } from "./risk.js";
import { maskDriverView } from "./masking.js";

/**
 * contract v0.9.0 §16 (owner real-data decisions, part 3): payouts with lines, refunds, support tickets, ratings and
 * their moderation, risk signals, KPIs and the admin dispatch feed, so the live admin never invents a value.
 */

export type RealDataDeps = { db: Db; jwtSecret: string; hub?: NotificationHub; clock?: () => Date };

const ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const many = <T extends z.ZodTypeAny>(item: T) => z.union([item, z.array(item)]).optional().transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v]));
const Page = { cursor: z.string().max(512).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) };
const When = { from: z.string().datetime().optional(), to: z.string().datetime().optional() };
const Bool = z.enum(["true", "false"]).transform((v) => v === "true");

const PayoutsQuery = { ...Page, ...When, status: many(z.enum(["pending", "pending_approval", "paid", "failed", "held"])), driverId: ID.optional(), ...ZoneFilterQuery };
const DriverPayoutsQuery = z.object({ ...Page, ...When });
const CreatePayoutBody = z.object({ driverId: ID, from: z.string().datetime(), to: z.string().datetime(), note: z.string().max(1000).optional() });
const PaidBody = z.object({ note: z.string().max(1000).optional() }).default({});
const RefundsQuery = { ...Page, ...When, status: many(z.enum(["pending_approval", "done", "rejected"])), paymentId: z.string().max(80).optional(), tripId: ID.optional(), ...ZoneFilterQuery };
const TicketStatus = z.enum(["open", "pending", "resolved", "closed"]);
const TicketsQuery = { ...Page, status: many(TicketStatus), priority: z.enum(["low", "normal", "high", "urgent"]).optional(), tripId: ID.optional(), riderId: ID.optional(), driverId: ID.optional(), q: z.string().max(200).optional(), assignedTo: z.union([z.literal("me"), z.literal("none"), ID]).optional(), ...ZoneFilterQuery };
const OwnTicketsQuery = z.object({ ...Page, status: TicketStatus.optional() });
const TicketBody = z.object({ tripId: ID.optional(), category: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), subject: z.string().min(1).max(200), text: z.string().min(1).max(5000) });
/** v0.18.30 (contract.json#smallFixes.ticketReasons): a bad category or subject / text gets its own reason. */
function ticketBody(raw: unknown): z.infer<typeof TicketBody> {
  const parsed = TicketBody.safeParse(raw ?? {});
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0]!;
  const field = String(issue.path[0] ?? "body");
  const reason = field === "category" ? "invalid_ticket_category" : field === "subject" || field === "text" ? "invalid_ticket_body" : "invalid_body";
  throw badRequest(`${field}: ${issue.message}`, reason);
}
/* v0.18.15 support desk (contract.json#supportDesk) */
const PersonMessageBody = z.object({ text: z.string().min(1).max(5000) });
const REASON = z.string().min(1).max(500);
const DESK_BODIES = {
  claim: z.object({}).passthrough(),
  leave: z.object({}).passthrough(),
  assign: z.object({ adminId: ID.nullable(), reason: REASON }),
  topic: z.object({ category: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/) }),
  waiting: z.object({ waiting: z.boolean() }),
  solve: z.object({ note: z.string().max(2000).optional() }),
  reopen: z.object({ reason: REASON }),
  case: z.object({ reason: REASON }),
} as const;
const SupportCountry = z.enum(SUPPORT_COUNTRIES as [string, ...string[]]);
const TopicSettingBody = z.object({ code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), on: z.boolean(), firstReplyMin: z.number().int().min(1).max(10080), solveHours: z.number().int().min(1).max(720), assignTo: ID.optional() });
const ReadyReplyBody = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/), lang: z.enum(["sv", "fr", "en"]), title: z.string().trim().min(1).max(80), text: z.string().trim().min(1).max(2000) });
const SupportSettingsBody = z.object({ country: SupportCountry, expectedRev: z.number().int().min(1), topics: z.array(TopicSettingBody).min(1).max(20), replies: z.array(ReadyReplyBody).max(100).optional() }).passthrough();
/* v0.18.15 alerts full flow (contract.json#alertDesk) */
const ALERT_ID = z.string().regex(/^[A-Za-z0-9_:.-]{1,200}$/);
const KIND = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const ISO = z.string().datetime({ offset: true });
const AlertBase = { kind: KIND, level: z.enum(["critical", "important", "info"]), title: z.string().min(1).max(300), zoneId: ID.optional(), since: ISO };
const ALERT_BODIES = {
  take: z.object(AlertBase),
  done: z.object({ ...AlertBase, note: z.string().max(500).optional() }),
  snooze: z.object({ ...AlertBase, minutes: z.number().int().min(1).max(1440) }),
  pass: z.object({ ...AlertBase, to: ID }),
} as const;
const HM = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/);
const ReplyBody = z.object({ text: z.string().min(1).max(5000), status: z.enum(["pending", "resolved", "closed"]).optional() });
const RatingsQuery = { ...Page, ...When, rater: z.enum(["rider", "driver"]).optional(), hidden: Bool.optional(), maxStars: z.coerce.number().int().min(1).max(5).optional(), driverId: ID.optional(), riderId: ID.optional(), ...ZoneFilterQuery };
const ModerationBody = z.object({ reason: z.string().min(1).max(500) });
const RiskQuery = { ...Page, who: z.enum(["driver", "rider"]).optional(), ...ZoneFilterQuery };
const KpiQuery = { fromDate: z.string().optional(), toDate: z.string().optional(), ...ZoneFilterQuery };
const StreamQuery = z.object({ after: z.coerce.number().int().min(0).optional(), limit: z.coerce.number().int().min(1).max(200).default(100), zoneId: ID.optional() });

const keyOf = (request: FastifyRequest) => {
  const value = request.headers["idempotency-key"];
  return Array.isArray(value) ? value[0] : value;
};
const clean = <T extends Record<string, unknown>>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/** GET /admin/refunds (RefundPage): the refunds of the admin's zones, newest first. */
export async function listRefunds(ex: Executor, who: Principal, input: { cursor?: string; limit: number; status?: string[]; paymentId?: string; tripId?: string; from?: string; to?: string }) {
  let q = ex.selectFrom("refunds").innerJoin("trips", "trips.trip_id", "refunds.trip_id").selectAll("refunds");
  const zones = zonesOf(who);
  if (zones) q = q.where("trips.zone_id", "in", zones.length ? zones : ["-"]);
  if (input.status?.length) q = q.where("refunds.status", "in", input.status as ("pending_approval" | "done" | "rejected")[]);
  // A trip's one payment is pay_<tripId> (GET /admin/payments).
  const tripOfPayment = input.paymentId?.startsWith("pay_") ? input.paymentId.slice(4) : input.paymentId ? "-" : undefined;
  if (tripOfPayment) q = q.where("refunds.trip_id", "=", tripOfPayment);
  if (input.tripId) q = q.where("refunds.trip_id", "=", input.tripId);
  if (input.from) q = q.where("refunds.created_at", ">=", new Date(input.from));
  if (input.to) q = q.where("refunds.created_at", "<", new Date(input.to));
  // L78-S (v0.18.78 adminListFilters.total).
  const filtered = q;
  if (input.cursor) {
    const c = readCursor(input.cursor);
    q = q.where(sql<boolean>`(refunds.created_at, refunds.refund_id) < (${c.at}, ${c.id})`);
  }
  const reading = q.orderBy("refunds.created_at", "desc").orderBy("refunds.refund_id", "desc").limit(input.limit + 1).execute();
  // The page asked first; the count follows it (L78-S, listTotal.ts).
  const counting = input.cursor ? undefined : countTotal(ex, filtered);
  const rows = await reading;
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return withTotal({
    items: page.map((r) => ({
      refundId: r.refund_id,
      paymentId: `pay_${r.trip_id}`,
      tripId: r.trip_id,
      amount: { amountMinor: Number(r.amount_minor), currency: r.currency },
      reason: r.reason,
      status: r.status,
      ...(r.approval_id ? { approvalId: r.approval_id } : {}),
      createdAt: r.created_at.toISOString(),
    })),
    nextCursor: rows.length > input.limit && last ? cursorOf(last.created_at, last.refund_id) : null,
  }, await totalAfterPage(counting));
}

export async function realDataRoutes(app: FastifyInstance, deps: RealDataDeps): Promise<void> {
  const guard = { db: deps.db, jwtSecret: deps.jwtSecret, ...(deps.clock ? { clock: deps.clock } : {}) };
  const now = () => deps.clock?.() ?? new Date();
  const idem = (request: FastifyRequest, who: Principal) => ({ actor: who.actor as "rider" | "driver" | "admin", subjectId: who.subjectId, key: keyOf(request), method: request.method, route: request.url.split("?")[0]!, body: request.body ?? null });
  const param = (request: FastifyRequest, name: string) => parseBody(z.object({ [name]: ID }), request.params)[name] as string;

  /* ---- payouts */
  app.get(`${API_PREFIX}/admin/payouts`, async (request) => {
    const who = await authenticateAdmin(request, guard, "finance.read");
    const query = parseQuery(PayoutsQuery, request.query);
    return listPayouts(deps.db, await narrowToZones(deps.db, who, query), clean(withoutZoneFilter(query)));
  });
  app.post(`${API_PREFIX}/admin/payouts`, async (request, reply) => {
    const who = await authenticateAdmin(request, guard, "finance.edit");
    const body = parseBody(CreatePayoutBody, request.body);
    const result = await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 201, body: await createPayout(trx, who, clean(body), now()) }));
    return reply.status(result.status).send(result.body);
  });
  // v0.18.39 A2 (owner Q4): approve a manual country's payout run.
  app.post(`${API_PREFIX}/admin/payouts/runs/approve`, async (request) => {
    const who = await authenticateAdmin(request, guard, "finance.edit");
    const body = parseBody(z.object({ country: z.string().regex(/^[A-Z]{2}$/), periodEnd: z.string().datetime(), reason: z.string().max(300).optional().default("") }), request.body);
    return (await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: await approvePayoutRun(trx, who, body, now()) }))).body;
  });
  app.post(`${API_PREFIX}/admin/payouts/:payoutId/paid`, async (request) => {
    const who = await authenticateAdmin(request, guard, "finance.edit");
    const payoutId = param(request, "payoutId");
    const body = parseBody(PaidBody, request.body ?? {});
    const result = await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: await markPayoutPaid(trx, who, payoutId, clean(body), now()) }));
    return result.body;
  });
  // v0.18.39 A2 (owner Q4): pause / release one driver's payouts from his profile.
  app.post(`${API_PREFIX}/admin/drivers/:driverId/payout-hold`, async (request) => {
    const who = await authenticateAdmin(request, guard, "finance.edit");
    const driverId = param(request, "driverId");
    const body = parseBody(z.object({ held: z.boolean(), reason: z.string().trim().min(1).max(300) }), request.body);
    const result = await runIdempotent(deps.db, idem(request, who), async (trx) => {
      await holdDriverPayouts(trx, who, driverId, body, now());
      return { status: 200, body: maskDriverView(await driverView(trx, await loadDriver(trx, driverId), "admin", now()), who) };
    });
    return result.body;
  });
  app.get(`${API_PREFIX}/driver/payouts`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    return driverPayouts(deps.db, who.subjectId, clean(parseBody(DriverPayoutsQuery, request.query)));
  });

  /* ---- refunds */
  app.get(`${API_PREFIX}/admin/refunds`, async (request) => {
    const who = await authenticateAdmin(request, guard, "finance.read");
    const query = parseQuery(RefundsQuery, request.query);
    return listRefunds(deps.db, await narrowToZones(deps.db, who, query), clean(withoutZoneFilter(query)));
  });

  /* ---- support tickets */
  app.post(`${API_PREFIX}/support/tickets`, async (request, reply) => {
    const who = await authenticate(request, guard, ["rider", "driver"]);
    const body = ticketBody(request.body);
    const actor = who.actor as "rider" | "driver";
    const result = await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 201, body: await openTicket(trx, { actor, subjectId: who.subjectId }, clean(body), now()) }));
    return reply.status(result.status).send(result.body);
  });
  app.get(`${API_PREFIX}/support/tickets`, async (request) => {
    const who = await authenticate(request, guard, ["rider", "driver"]);
    return ownTickets(deps.db, { actor: who.actor as "rider" | "driver", subjectId: who.subjectId }, clean(parseBody(OwnTicketsQuery, request.query)));
  });
  app.get(`${API_PREFIX}/support/tickets/:ticketId`, async (request) => {
    const who = await authenticate(request, guard, ["rider", "driver"]);
    return ownTicket(deps.db, { actor: who.actor as "rider" | "driver", subjectId: who.subjectId }, param(request, "ticketId"));
  });
  app.get(`${API_PREFIX}/admin/tickets`, async (request) => {
    const who = await authenticateAdmin(request, guard, "support.reply");
    const query = parseQuery(TicketsQuery, request.query);
    return adminTickets(deps.db, await narrowToZones(deps.db, who, query), clean(withoutZoneFilter(query)), now());
  });
  app.get(`${API_PREFIX}/admin/tickets/:ticketId`, async (request) => {
    const who = await authenticateAdmin(request, guard, "support.reply");
    return adminTicket(deps.db, who, param(request, "ticketId"), now());
  });
  app.post(`${API_PREFIX}/admin/tickets/:ticketId/reply`, async (request) => {
    const who = await authenticateAdmin(request, guard, "support.reply");
    const ticketId = param(request, "ticketId");
    const body = parseBody(ReplyBody, request.body);
    const result = await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: await adminReply(trx, who, ticketId, clean(body), now()) }));
    return result.body;
  });

  /* ---- support desk (v0.18.15, contract.json#supportDesk) */
  app.post(`${API_PREFIX}/support/tickets/:ticketId/messages`, async (request, reply) => {
    const who = await authenticate(request, guard, ["rider", "driver"]);
    const ticketId = param(request, "ticketId");
    const body = parseBody(PersonMessageBody, request.body);
    const result = await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 201, body: await writeOwnTicket(trx, { actor: who.actor as "rider" | "driver", subjectId: who.subjectId }, ticketId, body.text, now()) }));
    return reply.status(result.status).send(result.body);
  });
  app.post(`${API_PREFIX}/support/tickets/:ticketId/feedback`, async (request, reply) => {
    const who = await authenticate(request, guard, ["rider", "driver"]);
    const ticketId = param(request, "ticketId");
    const body = parseBody(z.object({ text: z.string().trim().min(1).max(2000) }), request.body);
    const result = await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 201, body: await giveFeedback(trx, { actor: who.actor as "rider" | "driver", subjectId: who.subjectId }, ticketId, body.text, now()) }));
    return reply.status(result.status).send(result.body);
  });
  app.get(`${API_PREFIX}/support/topics`, async (request) => {
    const who = await authenticate(request, guard, ["rider", "driver"]);
    return topicsFor(deps.db, { actor: who.actor as "rider" | "driver", subjectId: who.subjectId });
  });
  for (const verb of Object.keys(DESK_BODIES) as (keyof typeof DESK_BODIES)[]) {
    app.post(`${API_PREFIX}/admin/tickets/:ticketId/${verb}`, async (request) => {
      const who = await authenticateAdmin(request, guard, "support.reply");
      const ticketId = param(request, "ticketId");
      const body = parseBody(DESK_BODIES[verb], request.body ?? {}) as Record<string, unknown>;
      const command = { ...clean(body), verb } as DeskCommand;
      const result = await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: await adminDeskCommand(trx, who, ticketId, command, now()) }));
      return result.body;
    });
  }
  app.get(`${API_PREFIX}/admin/support/settings`, async (request) => {
    const who = await authenticateAdmin(request, guard, "support.reply");
    const { country } = parseBody(z.object({ country: SupportCountry }), request.query);
    return adminGetSettings(deps.db, who, country);
  });
  app.put(`${API_PREFIX}/admin/support/settings`, async (request) => {
    const who = await authenticateAdmin(request, guard, "settings.edit");
    const body = parseBody(SupportSettingsBody, request.body);
    const result = await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: await adminPutSettings(trx, who, body, now()) }));
    return result.body;
  });

  /* ---- alerts full flow (v0.18.15, contract.json#alertDesk) */
  const CountryQuery = z.object({ country: SupportCountry });
  app.get(`${API_PREFIX}/admin/alerts/book`, async (request) => {
    const who = await authenticateAdmin(request, guard, "overview.read");
    const { country } = parseBody(CountryQuery, request.query);
    return alertBook(deps.db, who, country, now());
  });
  app.get(`${API_PREFIX}/admin/alerts/history`, async (request) => {
    const who = await authenticateAdmin(request, guard, "overview.read");
    const q = parseBody(z.object({ country: SupportCountry, from: ISO.optional(), to: ISO.optional() }), request.query);
    return alertHistory(deps.db, who, q);
  });
  for (const verb of Object.keys(ALERT_BODIES) as (keyof typeof ALERT_BODIES)[]) {
    app.post(`${API_PREFIX}/admin/alerts/:alertId/${verb}`, async (request) => {
      // The act permission depends on the alert's kind (contract.json#alertDesk.permissions), checked in alertCommand.
      const who = await authenticateAdmin(request, guard, "overview.read");
      const alertId = parseBody(z.object({ alertId: ALERT_ID }), request.params).alertId;
      const body = parseBody(ALERT_BODIES[verb], request.body) as Record<string, unknown> & { kind: string; level: "critical" | "important" | "info"; title: string; since: string; zoneId?: string };
      const command = { verb, ...(verb === "done" ? { note: body["note"] } : {}), ...(verb === "snooze" ? { minutes: body["minutes"] } : {}), ...(verb === "pass" ? { to: body["to"] } : {}) } as AlertCommand;
      const input = { kind: body.kind, level: body.level, title: body.title, since: body.since, ...(body.zoneId ? { zoneId: body.zoneId } : {}) };
      const result = await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: await alertCommand(trx, who, alertId, input, command, now()) }));
      return result.body;
    });
  }
  app.put(`${API_PREFIX}/admin/alerts/mutes/:kind`, async (request) => {
    const who = await authenticateAdmin(request, guard, "alerts.manage");
    const { kind } = parseBody(z.object({ kind: KIND }), request.params);
    const { country } = parseBody(CountryQuery, request.query);
    const { minutes } = parseBody(z.object({ minutes: z.number().int().min(1).max(1440) }), request.body);
    const result = await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: await setMute(trx, who, country, kind, minutes, now()) }));
    return result.body;
  });
  app.delete(`${API_PREFIX}/admin/alerts/mutes/:kind`, async (request) => {
    const who = await authenticateAdmin(request, guard, "alerts.manage");
    const { kind } = parseBody(z.object({ kind: KIND }), request.params);
    const { country } = parseBody(CountryQuery, request.query);
    const result = await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: await setMute(trx, who, country, kind, null, now()) }));
    return result.body;
  });
  app.put(`${API_PREFIX}/admin/alerts/quiet`, async (request) => {
    const who = await authenticateAdmin(request, guard, "overview.read");
    const { country } = parseBody(CountryQuery, request.query);
    const body = parseBody(z.object({ on: z.boolean(), from: HM, to: HM }), request.body);
    const result = await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: await setQuiet(trx, who, country, body, now()) }));
    return result.body;
  });
  for (const which of ["settings", "rules"] as const) {
    app.put(`${API_PREFIX}/admin/alerts/${which}`, async (request) => {
      const who = await authenticateAdmin(request, guard, "alerts.manage");
      const body = parseBody(which === "settings" ? z.object({ country: SupportCountry, expectedRev: z.number().int().min(1), settings: z.record(z.string(), z.unknown()) }) : z.object({ country: SupportCountry, expectedRev: z.number().int().min(1), rules: z.array(z.record(z.string(), z.unknown())).max(200) }), request.body) as { country: string; expectedRev: number; settings?: unknown; rules?: unknown };
      const doc = which === "settings" ? body.settings : body.rules;
      const result = await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: await saveDoc(trx, who, body.country, which, body.expectedRev, doc, now()) }));
      return result.body;
    });
  }

  /* ---- incidents settings and report (v0.18.15, contract.json#incidentDesk) */
  app.get(`${API_PREFIX}/admin/incidents/settings`, async (request) => {
    const who = await authenticateAdmin(request, guard, "incidents.read");
    const { country } = parseBody(z.object({ country: SupportCountry }), request.query);
    return incidentSettings(deps.db, who, country);
  });
  app.put(`${API_PREFIX}/admin/incidents/settings`, async (request) => {
    const who = await authenticateAdmin(request, guard, "safety.edit");
    const body = parseBody(z.object({ country: SupportCountry, expectedRev: z.number().int().min(1), settings: z.record(z.string(), z.unknown()) }), request.body);
    const result = await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: await saveIncidentSettings(trx, who, body, now()) }));
    return result.body;
  });
  app.post(`${API_PREFIX}/admin/incidents/:incidentId/report`, async (request, reply) => {
    const who = await authenticateAdmin(request, guard, "incidents.read");
    const incidentId = param(request, "incidentId");
    await runIdempotent(deps.db, idem(request, who), async (trx) => { await recordReport(trx, who, incidentId, now()); return { status: 204, body: null }; });
    return reply.status(204).send();
  });

  /* ---- review rules (v0.18.15, contract.json#reviewRules) */
  const LineBody = z.object({ on: z.boolean(), below: z.number().min(1).max(5) });
  const ReviewRulesBody = z.object({ country: SupportCountry, warn: LineBody, review: LineBody, minReviews: z.number().int().min(1).max(1000), badWords: z.object({ on: z.boolean(), words: z.array(z.string().trim().min(1).max(40)).max(200) }), warningText: z.object({ sv: z.string().trim().min(1).max(500), fr: z.string().trim().min(1).max(500), en: z.string().trim().min(1).max(500) }).optional() }).passthrough();
  app.get(`${API_PREFIX}/admin/reviews/rules`, async (request) => {
    await authenticateAdmin(request, guard, "settings.read");
    const { country } = parseBody(z.object({ country: SupportCountry }), request.query);
    return reviewRulesOf(deps.db, country);
  });
  app.put(`${API_PREFIX}/admin/reviews/rules`, async (request) => {
    const who = await authenticateAdmin(request, guard, "settings.edit");
    const body = parseBody(ReviewRulesBody, request.body);
    const result = await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: await saveReviewRules(trx, who, { country: body.country, warn: body.warn, review: body.review, minReviews: body.minReviews, badWords: body.badWords, ...(body.warningText ? { warningText: body.warningText } : {}) }, now()) }));
    return result.body;
  });
  app.get(`${API_PREFIX}/admin/reviews/queue`, async (request) => {
    const who = await authenticateAdmin(request, guard, "riders.read");
    return reviewQueue(deps.db, who);
  });
  app.post(`${API_PREFIX}/admin/reviews/queue/:who/:personId/done`, async (request) => {
    const who = await authenticateAdmin(request, guard, "riders.block");
    const person = parseBody(z.object({ who: z.enum(["driver", "rider"]), personId: ID }), request.params);
    const { note } = parseBody(z.object({ note: z.string().min(1).max(500) }), request.body);
    const result = await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: await reviewDone(trx, who, person, note, now()) }));
    return result.body;
  });

  /* ---- ratings */
  app.get(`${API_PREFIX}/admin/ratings`, async (request) => {
    const who = await authenticateAdmin(request, guard, "settings.read");
    const query = parseQuery(RatingsQuery, request.query);
    return listRatings(deps.db, await narrowToZones(deps.db, who, query), clean({ cursor: query.cursor, limit: query.limit, from: query.rater, hidden: query.hidden, maxStars: query.maxStars, driverId: query.driverId, riderId: query.riderId, since: query.from, until: query.to }));
  });
  for (const verb of ["hide", "restore"] as const) {
    app.post(`${API_PREFIX}/admin/ratings/:tripId/:from/${verb}`, async (request) => {
      const who = await authenticateAdmin(request, guard, "settings.publish");
      const { tripId, from } = parseBody(z.object({ tripId: ID, from: z.enum(["rider", "driver"]) }), request.params);
      const body = parseBody(ModerationBody, request.body);
      const result = await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: await moderateRating(trx, who, tripId, from, verb === "hide", body.reason, now()) }));
      return result.body;
    });
  }

  /* ---- risk and KPIs */
  app.get(`${API_PREFIX}/admin/risk/signals`, async (request) => {
    const who = await authenticateAdmin(request, guard, "safety.edit");
    const query = parseQuery(RiskQuery, request.query);
    return riskSignals(deps.db, await narrowToZones(deps.db, who, query), clean(withoutZoneFilter(query)), now());
  });
  app.get(`${API_PREFIX}/admin/kpis`, async (request) => {
    const who = await authenticateAdmin(request, guard, "overview.read");
    const query = parseQuery(KpiQuery, request.query);
    return kpis(deps.db, await narrowToZones(deps.db, who, query), clean(withoutZoneFilter(query)), now());
  });

  /* ---- the admin dispatch feed */
  app.get(`${API_PREFIX}/admin/dispatch/stream`, async (request, reply) => {
    const who = await authenticateAdmin(request, guard, "trips.read");
    const query = parseBody(StreamQuery, request.query);
    const lastEventId = request.headers["last-event-id"];
    const after = query.after ?? (typeof lastEventId === "string" && /^\d+$/.test(lastEventId) ? Number(lastEventId) : 0);
    if (!wantsEventStream(request)) {
      const rows = await dispatchEventsAfter(deps.db, after, query.limit + 1, query.zoneId);
      const page = rows.slice(0, query.limit);
      const serverTime = now();
      const items = [];
      for (const row of page) if (mayHearDispatch(who, row)) items.push(await dispatchEventOf(deps.db, row, serverTime));
      const last = page[page.length - 1];
      return { items, nextCursor: rows.length > query.limit && last ? String(last.sequence) : null };
    }
    if (deps.hub === undefined) throw new ApiError("unavailable", "Live updates are not available; poll the dispatch feed instead.", { reason: "realtime_unavailable", retryAfterSeconds: 10 });
    const stream = openEventStream(request, reply);
    // S04 A1: a settled cursor, so an event committed after a higher one is still sent (once).
    const cursor = new SettledCursor(after, "dispatch_events_sequence_seq");
    let running = false;
    let again = false;
    const retry = readRetry(() => void pump(), () => stream.closed(), () => giveUpStream(stream));
    stream.onClose(retry.stop);
    const pump = async () => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        do {
          again = false;
          const { rows, full } = await cursor.next(deps.db, 200, (from, limit) => dispatchEventsAfter(deps.db, from, limit, query.zoneId));
          const serverTime = now();
          for (const row of rows) {
            if (stream.closed()) return;
            if (mayHearDispatch(who, row)) stream.send(Number(row.sequence), await dispatchEventOf(deps.db, row, serverTime));
          }
          if (full) again = true;
        } while (again && !stream.closed());
        retry.ok();
      } catch (error) {
        request.log.warn({ err: error }, "dispatch stream read failed");
        retry.failed();
      } finally {
        running = false;
      }
    };
    stream.onClose(deps.hub.subscribe(DISPATCH_EVENTS_CHANNEL, () => void pump()));
    await pump();
    return reply;
  });
}
