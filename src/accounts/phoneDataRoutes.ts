import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticate, authenticateAdmin, type Principal } from "../auth/guard.js";
import type { Db } from "../db/db.js";
import { API_PREFIX } from "../http/prefix.js";
import { runIdempotent } from "../http/idempotency.js";
import { parseBody } from "../http/validate.js";
import { adminDriverPreferences, adminRiderPlaces, MAX_CONTACTS_CAP, MAX_PLACES_CAP, riderContacts, saveRiderContacts, deletePlace, driverContacts, driverPreferences, importPlaces, incidentEmergencyContacts, listPlaces, saveDriverContacts, saveDriverPreferences, savePlace, updatePlace } from "./phoneData.js";

/** BASE B13 (contract v0.18.26 §47, contract.json#phoneDataToServer): the routes; each reads the owner from the token. */

export type PhoneDataDeps = { db: Db; jwtSecret: string; clock?: () => Date };

const ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const PlaceBody = z.object({
  label: z.string().min(1).max(80),
  kind: z.enum(["home", "work", "other"]),
  type: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/).optional(),
  place: z.object({ address: z.string().min(1).max(512), lat: z.number().min(-90).max(90).optional(), lng: z.number().min(-180).max(180).optional() }).strict(),
}).strict();
const ImportBody = z.object({ items: z.array(PlaceBody).max(MAX_PLACES_CAP) }).strict();
const CATEGORY = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const PreferencesBody = z.object({ categoriesOff: z.array(CATEGORY).max(50) }).strict();
const Contact = z.object({ name: z.string().min(1).max(80), phone: z.string().regex(/^\+?[0-9]{3,15}$/), relation: z.string().max(40).optional() }).strict();
// The count is checked by the service (400 too_many_contacts), so a long list gets that reason, not a schema error.
const ContactsBody = z.object({ items: z.array(Contact).max(MAX_CONTACTS_CAP * 2) }).strict();

const keyOf = (request: FastifyRequest) => {
  const value = request.headers["idempotency-key"];
  return Array.isArray(value) ? value[0] : value;
};

export async function phoneDataRoutes(app: FastifyInstance, deps: PhoneDataDeps): Promise<void> {
  const guard = { db: deps.db, jwtSecret: deps.jwtSecret, ...(deps.clock ? { clock: deps.clock } : {}) };
  const now = () => deps.clock?.() ?? new Date();
  const idem = (request: FastifyRequest, who: Principal) => ({ actor: who.actor, subjectId: who.subjectId, key: keyOf(request), method: request.method, route: request.url.split("?")[0]!, body: request.body ?? null });
  const placeId = (request: FastifyRequest) => parseBody(z.object({ placeId: ID }), request.params).placeId;

  app.get(`${API_PREFIX}/rider/places`, async (request) => {
    const who = await authenticate(request, guard, ["rider"]);
    return listPlaces(deps.db, who.subjectId);
  });
  app.post(`${API_PREFIX}/rider/places`, async (request, reply) => {
    const who = await authenticate(request, guard, ["rider"]);
    const body = parseBody(PlaceBody, request.body);
    const result = await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 201, body: await savePlace(trx, who.subjectId, body, now()) }));
    return reply.code(result.status).send(result.body);
  });
  app.post(`${API_PREFIX}/rider/places/import`, async (request) => {
    const who = await authenticate(request, guard, ["rider"]);
    const body = parseBody(ImportBody, request.body);
    return (await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: await importPlaces(trx, who.subjectId, body.items, now()) }))).body;
  });
  app.put(`${API_PREFIX}/rider/places/:placeId`, async (request) => {
    const who = await authenticate(request, guard, ["rider"]);
    const id = placeId(request);
    const body = parseBody(PlaceBody, request.body);
    return (await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: await updatePlace(trx, who.subjectId, id, body, now()) }))).body;
  });
  app.delete(`${API_PREFIX}/rider/places/:placeId`, async (request, reply) => {
    const who = await authenticate(request, guard, ["rider"]);
    const id = placeId(request);
    await runIdempotent(deps.db, idem(request, who), async (trx) => {
      await deletePlace(trx, who.subjectId, id);
      return { status: 204, body: null };
    });
    return reply.code(204).send();
  });

  app.get(`${API_PREFIX}/driver/preferences`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    return driverPreferences(deps.db, who.subjectId);
  });
  app.put(`${API_PREFIX}/driver/preferences`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    const body = parseBody(PreferencesBody, request.body);
    return (await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: await saveDriverPreferences(trx, who.subjectId, body.categoriesOff, now()) }))).body;
  });
  app.get(`${API_PREFIX}/driver/emergency-contacts`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    return driverContacts(deps.db, who.subjectId);
  });
  app.put(`${API_PREFIX}/driver/emergency-contacts`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    const body = parseBody(ContactsBody, request.body);
    return (await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: await saveDriverContacts(trx, who.subjectId, body.items, now()) }))).body;
  });

  // Owner 2026-11-04 "Yes, same as drivers": the rider's emergency contacts on the server too.
  app.get(`${API_PREFIX}/rider/emergency-contacts`, async (request) => {
    const who = await authenticate(request, guard, ["rider"]);
    return riderContacts(deps.db, who.subjectId);
  });
  app.put(`${API_PREFIX}/rider/emergency-contacts`, async (request) => {
    const who = await authenticate(request, guard, ["rider"]);
    const body = parseBody(ContactsBody, request.body);
    return (await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: await saveRiderContacts(trx, who.subjectId, body.items, now()) }))).body;
  });

  app.get(`${API_PREFIX}/admin/incidents/:incidentId/emergency-contacts`, async (request) => {
    const who = await authenticateAdmin(request, guard, "incidents.read");
    const { incidentId } = parseBody(z.object({ incidentId: ID }), request.params);
    // A read, but it writes the audit line in the same transaction.
    return deps.db.transaction().execute((trx) => incidentEmergencyContacts(trx, who, incidentId, now()));
  });

  app.get(`${API_PREFIX}/admin/riders/:riderId/saved-places`, async (request) => {
    const who = await authenticateAdmin(request, guard, "riders.read");
    const { riderId } = parseBody(z.object({ riderId: ID }), request.params);
    return deps.db.transaction().execute((trx) => adminRiderPlaces(trx, who, riderId, now()));
  });
  app.get(`${API_PREFIX}/admin/drivers/:driverId/preferences`, async (request) => {
    const who = await authenticateAdmin(request, guard, "drivers.read");
    const { driverId } = parseBody(z.object({ driverId: ID }), request.params);
    return deps.db.transaction().execute((trx) => adminDriverPreferences(trx, who, driverId, now()));
  });
}
