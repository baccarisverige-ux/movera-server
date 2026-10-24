import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { authenticate } from "../auth/guard.js";
import type { Db } from "../db/db.js";
import { schemaProblem } from "../contract/schemas.js";
import { ApiError, badRequest } from "../http/errors.js";
import { API_PREFIX } from "../http/prefix.js";
import { PlacesUnavailable, type Places } from "./places.js";
import type { Router } from "./routing.js";

/** contract §10: /locations/autocomplete, /geocode, /reverse-geocode, /routes, /routes/driving/{coordinates}. Read-only: no Idempotency-Key. */

export type MapsDeps = { db: Db; jwtSecret: string; places: Places; router: Router; osrmUrl?: string; clock?: () => Date };

const LANGUAGES = ["sv", "en", "fr"];
const NAV_PER_MINUTE = 30;

function check(schema: string, body: unknown): void {
  const problem = schemaProblem(schema, body);
  if (problem === null) return;
  if (/latitude|longitude|\/lat|\/lng/.test(problem)) throw badRequest(`Coordinates are not valid: ${problem}.`, "invalid_coordinates");
  throw badRequest(`The request is not valid: ${problem}.`, "invalid_body");
}

const unavailable = () => new ApiError("unavailable", "Address search is not available right now.", { reason: "maps_unavailable", retryAfterSeconds: 30 });

export async function mapsRoutes(app: FastifyInstance, deps: MapsDeps): Promise<void> {
  const guard = { db: deps.db, jwtSecret: deps.jwtSecret, ...(deps.clock ? { clock: deps.clock } : {}) };
  // One provider session per rider: typing then picking a suggestion is billed as one search.
  const sessions = new Map<string, string>();
  const navCalls = new Map<string, number[]>();

  async function language(request: FastifyRequest, actor: string, subjectId: string): Promise<string> {
    const header = request.headers["accept-language"];
    const asked = typeof header === "string" ? header.split(",")[0]?.trim().slice(0, 2).toLowerCase() : undefined;
    if (asked && LANGUAGES.includes(asked)) return asked;
    if (actor === "rider") {
      const row = await deps.db.selectFrom("riders").select("language").where("rider_id", "=", subjectId).executeTakeFirst();
      if (row?.language && LANGUAGES.includes(row.language)) return row.language;
    }
    return "sv";
  }

  const guarded = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof PlacesUnavailable) {
        app.log.warn({ err: error }, "address search unavailable");
        throw unavailable();
      }
      throw error;
    }
  };

  app.post(`${API_PREFIX}/locations/autocomplete`, async (request) => {
    const who = await authenticate(request, guard, ["rider"]);
    const body = (request.body ?? {}) as { query: string; latitude?: number; longitude?: number; limit?: number };
    check("AutocompleteRequest", body);
    const session = sessions.get(who.subjectId) ?? randomUUID();
    sessions.set(who.subjectId, session);
    const bias = body.latitude !== undefined && body.longitude !== undefined ? { lat: body.latitude, lng: body.longitude } : undefined;
    const suggestions = await guarded(() =>
      deps.places.autocomplete({ query: body.query.trim(), ...(bias ? { bias } : {}), limit: Math.min(body.limit ?? 8, 8), language: "sv", session }),
    );
    return { suggestions };
  });

  app.post(`${API_PREFIX}/locations/geocode`, async (request) => {
    const who = await authenticate(request, guard, ["rider"]);
    const body = (request.body ?? {}) as { query: string; placeId?: string };
    check("GeocodeRequest", body);
    const lang = await language(request, who.actor, who.subjectId);
    const session = sessions.get(who.subjectId);
    // Resolving a picked suggestion ends the provider session.
    if (body.placeId) sessions.delete(who.subjectId);
    return guarded(() => deps.places.geocode({ query: body.query.trim(), ...(body.placeId ? { placeId: body.placeId } : {}), language: lang, ...(session ? { session } : {}) }));
  });

  app.post(`${API_PREFIX}/locations/reverse-geocode`, async (request) => {
    const who = await authenticate(request, guard, ["rider", "driver"]);
    const body = (request.body ?? {}) as { latitude: number; longitude: number };
    check("ReverseGeocodeRequest", body);
    const lang = await language(request, who.actor, who.subjectId);
    const address = await guarded(() => deps.places.reverse({ lat: body.latitude, lng: body.longitude, language: lang }));
    return { address, latitude: body.latitude, longitude: body.longitude };
  });

  app.post(`${API_PREFIX}/routes`, async (request) => {
    await authenticate(request, guard, ["rider", "driver"]);
    const body = (request.body ?? {}) as { from: { lat: number; lng: number }; to: { lat: number; lng: number } };
    check("RouteRequest", body);
    const leg = await deps.router.route([body.from, body.to]);
    const points = leg.points && leg.points.length >= 2 ? leg.points : [body.from, body.to];
    return { points, distanceMeters: leg.distanceMeters, durationSeconds: leg.durationSeconds, provider: leg.source };
  });

  app.get(`${API_PREFIX}/routes/driving/:coordinates`, async (request, reply) => {
    const who = await authenticate(request, guard, ["driver"]);
    const { coordinates } = request.params as { coordinates: string };
    const pairs = coordinates.split(";");
    const valid =
      pairs.length >= 2 &&
      pairs.length <= 10 &&
      pairs.every((pair) => {
        const [lng, lat] = pair.split(",").map(Number);
        return pair.split(",").length === 2 && Number.isFinite(lng) && Number.isFinite(lat) && Math.abs(lat!) <= 90 && Math.abs(lng!) <= 180;
      });
    if (!valid) throw badRequest("Send 2 to 10 points as lng,lat;lng,lat.", "invalid_coordinates");
    const query = request.query as Record<string, string>;
    if (query["geometries"] !== undefined && query["geometries"] !== "geojson") throw badRequest("Only geometries=geojson is supported.", "invalid_query");

    const now = Date.now();
    const recent = (navCalls.get(who.subjectId) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= NAV_PER_MINUTE) throw new ApiError("rate_limited", "Too many route requests.", { reason: "routes_too_many", retryAfterSeconds: Math.ceil((recent[0]! + 60_000 - now) / 1000) });
    recent.push(now);
    navCalls.set(who.subjectId, recent);

    if (deps.osrmUrl === undefined) throw new ApiError("unavailable", "Navigation routes are not available yet.", { reason: "routing_unavailable", retryAfterSeconds: 60 });
    const params = new URLSearchParams();
    for (const name of ["overview", "steps", "annotations", "alternatives"]) if (query[name] !== undefined) params.set(name, String(query[name]));
    params.set("geometries", "geojson");
    let response: Response;
    try {
      response = await fetch(`${deps.osrmUrl.replace(/\/$/, "")}/route/v1/driving/${coordinates}?${params}`, { signal: AbortSignal.timeout(5000) });
    } catch {
      throw new ApiError("unavailable", "Navigation routes are not available right now.", { reason: "routing_unavailable", retryAfterSeconds: 10 });
    }
    const data = (await response.json().catch(() => null)) as { code?: string } | null;
    if (data === null) throw new ApiError("unavailable", "Navigation routes are not available right now.", { reason: "routing_unavailable", retryAfterSeconds: 10 });
    if (data.code === "NoRoute") return reply.status(200).send({ code: "NoRoute", routes: [] });
    return reply.status(200).send(data);
  });
}
