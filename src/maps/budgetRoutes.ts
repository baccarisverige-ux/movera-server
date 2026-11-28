import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { audit } from "../admin/audit.js";
import { adminCoversAllCountries, authenticateAdmin, type Principal } from "../auth/guard.js";
import type { Db } from "../db/db.js";
import { ApiError, badRequest } from "../http/errors.js";
import { runIdempotent } from "../http/idempotency.js";
import { API_PREFIX } from "../http/prefix.js";
import { DAILY_LIMIT_RANGE, googleUse, readGoogleBudget, type GoogleBudget } from "./googleBudget.js";

/**
 * v0.18.171 (contract.json#googleRoadLines.budgetSetting): GET / PUT /admin/maps/google-budget. The budget is global
 * (Google's quota is per project): GET for any settings.read admin (global counts, no personal data), PUT for a
 * settings.publish admin who covers every country. Audited like a config publish.
 */
export type BudgetDeps = { db: Db; jwtSecret: string; clock?: () => Date };

const Command = z.object({ dailyLimit: z.number().int().min(DAILY_LIMIT_RANGE[0]).max(DAILY_LIMIT_RANGE[1]), quotesPerDay: z.number().int().min(0).max(DAILY_LIMIT_RANGE[1]) }).strict();

const keyOf = (request: FastifyRequest) => {
  const value = request.headers["idempotency-key"];
  return Array.isArray(value) ? value[0] : value;
};

async function view(db: Db, budget: GoogleBudget, now: Date) {
  return { dailyLimit: budget.dailyLimit, quotesPerDay: budget.quotesPerDay, roadLinesPerDay: Math.max(0, budget.dailyLimit - budget.quotesPerDay), today: await googleUse(db, now) };
}

export async function googleBudgetRoutes(app: FastifyInstance, deps: BudgetDeps): Promise<void> {
  const guard = { db: deps.db, jwtSecret: deps.jwtSecret, ...(deps.clock ? { clock: deps.clock } : {}) };
  const now = () => deps.clock?.() ?? new Date();
  const idem = (request: FastifyRequest, who: Principal, body: unknown) => ({ actor: who.actor, subjectId: who.subjectId, key: keyOf(request), method: request.method, route: request.url.split("?")[0]!, body });

  app.get(`${API_PREFIX}/admin/maps/google-budget`, async (request) => {
    await authenticateAdmin(request, guard, "settings.read");
    return view(deps.db, await readGoogleBudget(deps.db), now());
  });

  app.put(`${API_PREFIX}/admin/maps/google-budget`, async (request) => {
    const who = await authenticateAdmin(request, guard, "settings.publish");
    if (!(await adminCoversAllCountries(deps.db, who))) throw new ApiError("forbidden", "Only an admin who covers every country can change the Google budget.", { reason: "not_all_countries" });
    const parsed = Command.safeParse(request.body ?? {});
    if (!parsed.success) throw badRequest("Send dailyLimit 100..100000 and quotesPerDay 0..dailyLimit.", "invalid_budget");
    const body = parsed.data;
    if (body.quotesPerDay > body.dailyLimit) throw badRequest("The part for prices cannot be more than the daily limit.", "invalid_budget");
    const result = await runIdempotent(deps.db, idem(request, who, body), async (trx) => {
      const at = now();
      const before = await readGoogleBudget(trx);
      await trx
        .insertInto("google_routes_budget")
        .values({ id: true, daily_limit: body.dailyLimit, quotes_per_day: body.quotesPerDay, updated_at: at, updated_by: who.subjectId })
        .onConflict((oc) => oc.column("id").doUpdateSet({ daily_limit: body.dailyLimit, quotes_per_day: body.quotesPerDay, updated_at: at, updated_by: who.subjectId }))
        .execute();
      await audit(trx, { adminId: who.subjectId, action: "google_budget.publish", targetType: "config", targetId: "google-routes-budget", zoneId: null, detail: { before, after: body }, at });
      return { status: 200, body: await view(deps.db, body, at) };
    });
    return result.body;
  });
}
