import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, authenticateAdmin, type Principal } from "../auth/guard.js";
import type { Db } from "../db/db.js";
import { API_PREFIX } from "../http/prefix.js";
import { audit } from "../admin/audit.js";
import { zonesOf } from "../admin/lists.js";
import { narrowToZones, parseQuery, ZoneFilterQuery } from "../admin/zoneFilter.js";
import { checkCountry, checkIncomeQuery, checkTripLines, CSV_COLUMNS, csvLines, incomeAllPages, incomePage, ownPayee, type IncomeDetail, type IncomeScope } from "./driverIncome.js";

/**
 * v0.18.153 P29 (contract.json#driverIncomeYear, DAC7): GET /admin/finance/driver-income (+ .csv) for the accountant and
 * GET /driver/income-statement for the driver. Read only; every admin download is audited.
 */
export type FinanceDeps = { db: Db; jwtSecret: string; clock?: () => Date };

const ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const Base = { year: z.string().max(10), month: z.string().max(10).optional(), payeeId: ID.optional() };
const AdminQuery = { ...Base, ...ZoneFilterQuery, detail: z.enum(["quarter", "month", "day", "trips"]).default("quarter") };
const PageQuery = { ...AdminQuery, cursor: z.string().max(400).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) };
const CSV_BATCH = 200;
const DriverQuery = { year: Base.year, month: Base.month, detail: z.enum(["month", "day", "trips"]).default("month") };

export async function financeRoutes(app: FastifyInstance, deps: FinanceDeps): Promise<void> {
  const guard = { db: deps.db, jwtSecret: deps.jwtSecret, ...(deps.clock ? { clock: deps.clock } : {}) };
  const now = () => deps.clock?.() ?? new Date();

  /** The checked scope of an admin query (400s first, then the zone scope: 403 zone_out_of_scope). */
  async function adminScope(who: Principal, query: z.infer<z.ZodObject<typeof AdminQuery>>): Promise<IncomeScope> {
    const { year, month } = checkIncomeQuery({ year: query.year, month: query.month, detail: query.detail, payeeId: query.payeeId }, now());
    await checkCountry(deps.db, query.country);
    const narrowed = await narrowToZones(deps.db, who, query);
    const scope: IncomeScope = { year, month, detail: query.detail as IncomeDetail, zones: zonesOf(narrowed), payeeId: query.payeeId };
    await checkTripLines(deps.db, scope);
    return scope;
  }
  const auditDetail = (scope: IncomeScope, query: { country?: string | undefined; zoneId?: string | undefined; zoneIds?: string[] | undefined }, format: "json" | "csv", rows?: number) => ({
    year: scope.year, detail: scope.detail, ...(scope.month ? { month: scope.month } : {}), ...(query.country ? { country: query.country } : {}),
    ...(query.zoneId || query.zoneIds?.length ? { zoneIds: [...(query.zoneId ? [query.zoneId] : []), ...(query.zoneIds ?? [])] } : {}),
    ...(scope.payeeId ? { payeeId: scope.payeeId } : {}), format, ...(rows !== undefined ? { rows } : {}),
  });

  app.get(`${API_PREFIX}/admin/finance/driver-income`, async (request) => {
    const who = await authenticateAdmin(request, guard, "finance.read");
    const query = parseQuery(PageQuery, request.query);
    const scope = await adminScope(who, query);
    const page = await incomePage(deps.db, scope, { cursor: query.cursor, limit: query.limit });
    await audit(deps.db, { adminId: who.subjectId, action: "finance.driver_income.read", targetType: "driver_income", targetId: String(scope.year), detail: auditDetail(scope, query, "json", page.items.length), at: now() });
    return { year: scope.year, detail: scope.detail, ...(scope.month ? { month: scope.month } : {}), items: page.items, nextCursor: page.nextCursor, generatedAt: now().toISOString() };
  });

  app.get(`${API_PREFIX}/admin/finance/driver-income.csv`, async (request, reply) => {
    const who = await authenticateAdmin(request, guard, "finance.read");
    const query = parseQuery(AdminQuery, request.query);
    const scope = await adminScope(who, query);
    // The first page is read before the headers go out, so most failures are a clean JSON error (not a cut file).
    const first = await incomePage(deps.db, scope, { limit: CSV_BATCH });
    await audit(deps.db, { adminId: who.subjectId, action: "finance.driver_income.csv", targetType: "driver_income", targetId: String(scope.year), detail: auditDetail(scope, query, "csv"), at: now() });
    const db = deps.db;
    async function* lines() {
      yield `\uFEFF${CSV_COLUMNS.join(",")}\r\n`;
      // Every payee, in the JSON order (payeeId, then currency), 200 at a time: nothing is held for the whole file.
      for await (const rows of incomeAllPages(db, scope, CSV_BATCH, first)) yield rows.flatMap((row) => csvLines(row)).map((l) => `${l}\r\n`).join("");
    }
    const name = `movera-driver-income-${scope.year}${scope.month ? `-${scope.month.slice(5)}` : ""}-${scope.detail}.csv`;
    return reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", `attachment; filename="${name}"`).header("cache-control", "no-store").send(Readable.from(lines()));
  });

  app.get(`${API_PREFIX}/driver/income-statement`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    const query = parseQuery(DriverQuery, request.query);
    const own = await ownPayee(deps.db, who.subjectId);
    const { year, month } = checkIncomeQuery({ year: query.year, month: query.month, detail: query.detail, payeeId: undefined }, now());
    const scope: IncomeScope = { year, month, detail: query.detail, zones: null, payeeId: own.payeeId, ...(own.driverId ? { driverId: own.driverId } : {}) };
    await checkTripLines(deps.db, scope);
    // One payee, one row per currency (a handful at most).
    const page = await incomePage(deps.db, scope, { limit: 10 });
    return { year, detail: scope.detail, ...(month ? { month } : {}), items: page.items };
  });
}
