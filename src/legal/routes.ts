import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticate, authenticateAdmin, type Principal } from "../auth/guard.js";
import type { Db } from "../db/db.js";
import { ApiError } from "../http/errors.js";
import { API_PREFIX } from "../http/prefix.js";
import { runIdempotent } from "../http/idempotency.js";
import { parseBody } from "../http/validate.js";
import { acceptLegal, adminCoversCountry, knownCountry, legalForApps, legalHistory, liveLegal, publishLegal } from "./service.js";

/** Contract v0.18.5 §30 (G1-B2, contract.json#legal): GET /legal/{country}, the admin's page, the accept. */

export type LegalDeps = { db: Db; jwtSecret: string; clock?: () => Date };

const Lang200 = z.object({ sv: z.string().trim().min(1).max(200), fr: z.string().trim().min(1).max(200), en: z.string().trim().min(1).max(200) });
const LangText = z.object({ sv: z.string().trim().min(1).max(20000), fr: z.string().trim().min(1).max(20000), en: z.string().trim().min(1).max(20000) });
const Doc = z.object({ title: Lang200, text: LangText });
const PublishBody = z.object({
  terms: Doc,
  privacy: Doc,
  company: z
    .object({
      companyName: z.string().max(200).optional(),
      orgNumber: z.string().max(60).optional(),
      address: z.string().max(300).optional(),
      supportEmail: z.string().max(200).email().optional(),
      supportPhone: z.string().regex(/^\+[1-9]\d{6,14}$/).optional(),
    })
    .strict()
    .optional(),
  reaccept: z.boolean().optional(),
});
const AcceptBody = z.object({ country: z.string().regex(/^[A-Z]{2}$/), version: z.number().int().min(1) });
const CountryParam = z.object({ country: z.string().regex(/^[A-Z]{2}$/) });

const keyOf = (request: FastifyRequest) => {
  const value = request.headers["idempotency-key"];
  return Array.isArray(value) ? value[0] : value;
};

export async function legalRoutes(app: FastifyInstance, deps: LegalDeps): Promise<void> {
  const guard = { db: deps.db, jwtSecret: deps.jwtSecret, ...(deps.clock ? { clock: deps.clock } : {}) };
  const now = () => deps.clock?.() ?? new Date();
  const idem = (request: FastifyRequest, who: Principal, body: unknown) => ({ actor: who.actor, subjectId: who.subjectId, key: keyOf(request), method: request.method, route: request.url.split("?")[0]!, body });
  const countryOf = (request: FastifyRequest) => knownCountry(parseBody(CountryParam, request.params).country);
  const covers = async (who: Principal, country: string) => {
    if (!(await adminCoversCountry(deps.db, who.zones, country))) throw new ApiError("forbidden", "This country is outside your zones.", { reason: "zone_out_of_scope" });
  };

  // No bearer token: the sign-in screen opens the terms and the privacy policy (auth.beforeSignIn.allowed).
  app.get(`${API_PREFIX}/legal/:country`, async (request) => legalForApps(deps.db, countryOf(request)));

  app.get(`${API_PREFIX}/admin/legal/:country`, async (request) => {
    const who = await authenticateAdmin(request, guard, "settings.read");
    const country = countryOf(request);
    await covers(who, country);
    return { live: await liveLegal(deps.db, country), history: await legalHistory(deps.db, country) };
  });

  app.post(`${API_PREFIX}/admin/legal/:country/publish`, async (request) => {
    const who = await authenticateAdmin(request, guard, "settings.publish");
    const country = countryOf(request);
    const body = parseBody(PublishBody, request.body);
    await covers(who, country);
    return (await runIdempotent(deps.db, idem(request, who, body), async (trx) => ({ status: 200, body: await publishLegal(trx, who.subjectId, country, body, now()) }))).body;
  });

  app.post(`${API_PREFIX}/account/legal/accept`, async (request, reply) => {
    const who = await authenticate(request, guard, ["rider", "driver"]);
    const body = parseBody(AcceptBody, request.body);
    knownCountry(body.country);
    await runIdempotent(deps.db, idem(request, who, body), async (trx) => {
      await acceptLegal(trx, who.actor as "rider" | "driver", who.subjectId, body, now());
      return { status: 204, body: null };
    });
    return reply.status(204).send();
  });
}
