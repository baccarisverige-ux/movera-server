import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { authenticate } from "../auth/guard.js";
import type { Db } from "../db/db.js";
import { schemaProblem } from "../contract/schemas.js";
import { ApiError, badRequest } from "../http/errors.js";
import { API_PREFIX } from "../http/prefix.js";
import { PlacesUnavailable, type Places } from "./places.js";
import type { LatLng, Router } from "./routing.js";
import { zoneAt } from "../config/zoneLookup.js";
import { countryLanguage } from "../notifications/noticeLanguage.js";

/** contract §10: /locations/autocomplete, /geocode, /reverse-geocode, /routes, /routes/driving/{coordinates}. Read-only: no Idempotency-Key. */

/** v0.18.163: `traffic` (Google live traffic) serves GET /routes/driving now that OSRM is not used (owner 2026-11-25). */
export type MapsDeps = { db: Db; jwtSecret: string; places: Places; router: Router; traffic?: Router; osrmUrl?: string; clock?: () => Date };

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

  /**
   * v0.18.30 (contract.json#smallFixes.addressLanguage, L20): address search speaks the language of the zone the bias
   * point is in (SE sv, FR fr, TN fr); without a bias point or outside every zone, the asked / saved language.
   */
  async function searchLanguage(request: FastifyRequest, actor: string, subjectId: string, bias: { lat: number; lng: number } | undefined): Promise<string> {
    if (bias) {
      const zone = await zoneAt(deps.db, bias);
      const row = zone ? await deps.db.selectFrom("zones").select("country").where("zone_id", "=", zone.zoneId).executeTakeFirst() : undefined;
      // v0.18.66 §87: the countries' languages come from one place (configDefaults.countries; SE sv, FR fr, TN fr).
      const lang = row ? countryLanguage(row.country) : undefined;
      if (lang) return lang;
    }
    return language(request, actor, subjectId);
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
    // Riders and drivers (owner decision G3-D3: the driver's destination mode searches any address).
    const who = await authenticate(request, guard, ["rider", "driver"]);
    const body = (request.body ?? {}) as { query: string; latitude?: number; longitude?: number; limit?: number };
    check("AutocompleteRequest", body);
    const key = `${who.actor}:${who.subjectId}`;
    const session = sessions.get(key) ?? randomUUID();
    sessions.set(key, session);
    const bias = body.latitude !== undefined && body.longitude !== undefined ? { lat: body.latitude, lng: body.longitude } : undefined;
    // Suggestions come from the countries with an open zone (Sweden, and France since the Paris zone).
    const regions = (await deps.db.selectFrom("zones").select("country").distinct().where("open", "=", true).execute()).map((z) => z.country.toLowerCase());
    const lang = await searchLanguage(request, who.actor, who.subjectId, bias);
    const suggestions = await guarded(() =>
      deps.places.autocomplete({ query: body.query.trim(), ...(bias ? { bias } : {}), limit: Math.min(body.limit ?? 8, 8), language: lang, session, regions }),
    );
    return { suggestions };
  });

  app.post(`${API_PREFIX}/locations/geocode`, async (request) => {
    const who = await authenticate(request, guard, ["rider", "driver"]);
    const body = (request.body ?? {}) as { query: string; placeId?: string };
    check("GeocodeRequest", body);
    const lang = await language(request, who.actor, who.subjectId);
    const key = `${who.actor}:${who.subjectId}`;
    const session = sessions.get(key);
    // Resolving a picked suggestion ends the provider session.
    if (body.placeId) sessions.delete(key);
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
    const body = (request.body ?? {}) as { from: LatLng; to: LatLng; via?: LatLng[] };
    check("RouteRequest", body);
    // v0.18.41 §66 (A14): through every stop, with the same router as POST /quotes; no road = straight through them.
    const waypoints = [body.from, ...(body.via ?? []), body.to];
    const leg = await deps.router.route(waypoints);
    const points = leg.points && leg.points.length >= 2 ? leg.points : waypoints;
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

    if (deps.osrmUrl === undefined) {
      // v0.18.163 (contract.json#liveTraffic.navigation; owner "no OpenStreetMap"): the driver's route line from Google
      // (live traffic, the same SKU), answered in the OSRM shape the driver app reads (routes[0].geometry.coordinates,
      // distance, duration; no turn steps). Google not answering = 503 routing_unavailable, never a straight line.
      if (deps.traffic === undefined) throw new ApiError("unavailable", "Navigation routes are not available yet.", { reason: "routing_unavailable", retryAfterSeconds: 60 });
      const points = pairs.map((pair) => {
        const [lng, lat] = pair.split(",").map(Number);
        return { lat: lat!, lng: lng! };
      });
      const leg = await deps.traffic.route(points);
      if (leg.source !== "google" || !leg.points || leg.points.length < 2) throw new ApiError("unavailable", "Navigation routes are not available right now.", { reason: "routing_unavailable", retryAfterSeconds: 10 });
      return reply.status(200).send({ code: "Ok", routes: [{ distance: leg.distanceMeters, duration: leg.durationSeconds, geometry: { type: "LineString", coordinates: leg.points.map((p) => [p.lng, p.lat]) }, legs: [] }], waypoints: [] });
    }
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
