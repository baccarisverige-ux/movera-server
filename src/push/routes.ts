import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { API_PREFIX } from "../http/prefix.js";
import { parseBody } from "../http/validate.js";
import type { PushConfigSource } from "./config.js";

/**
 * GET /push/config?app=driver|rider (contract v0.18.3): no token; the public Firebase web settings or enabled false.
 * v0.18.105 (BQ-V43): `&platform=android` gives the Android app's public settings (androidConfig); no platform or
 * `web` is the v0.18.3 answer. v0.18.156: `ios` gives the iOS app's public settings (iosConfig).
 */
export async function pushRoutes(app: FastifyInstance, deps: { config: PushConfigSource }): Promise<void> {
  const Query = z.object({ app: z.enum(["driver", "rider"]), platform: z.enum(["web", "android", "ios"]).optional() });
  app.get(`${API_PREFIX}/push/config`, async (request, reply) => {
    const query = parseBody(Query, request.query);
    const config = await deps.config.get(query.app, query.platform ?? "web");
    reply.header("Cache-Control", "public, max-age=300");
    return config;
  });
}
