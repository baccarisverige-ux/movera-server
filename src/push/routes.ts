import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { API_PREFIX } from "../http/prefix.js";
import { parseBody } from "../http/validate.js";
import type { PushConfigSource } from "./config.js";

/** GET /push/config?app=driver|rider (contract v0.18.3): no token; the public Firebase web settings or enabled false. */
export async function pushRoutes(app: FastifyInstance, deps: { config: PushConfigSource }): Promise<void> {
  const Query = z.object({ app: z.enum(["driver", "rider"]) });
  app.get(`${API_PREFIX}/push/config`, async (request, reply) => {
    const query = parseBody(Query, request.query);
    const config = await deps.config.get(query.app);
    reply.header("Cache-Control", "public, max-age=300");
    return config;
  });
}
