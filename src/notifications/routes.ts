import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "../auth/guard.js";
import type { Db } from "../db/db.js";
import { API_PREFIX } from "../http/prefix.js";
import { parseBody } from "../http/validate.js";
import { listNotifications, markNotificationRead, type Audience } from "./service.js";

/** contract: GET /notifications, POST /notifications/{notificationId}/read (rider and driver). */

export type NotificationDeps = { db: Db; jwtSecret: string; clock?: () => Date };

const ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const Query = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  unreadOnly: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
});

export async function notificationRoutes(app: FastifyInstance, deps: NotificationDeps): Promise<void> {
  const guard = { db: deps.db, jwtSecret: deps.jwtSecret, ...(deps.clock ? { clock: deps.clock } : {}) };
  const now = () => deps.clock?.() ?? new Date();

  app.get(`${API_PREFIX}/notifications`, async (request) => {
    const who = await authenticate(request, guard, ["rider", "driver"]);
    const query = parseBody(Query, request.query);
    return listNotifications(deps.db, { audience: who.actor as Audience, subjectId: who.subjectId }, { cursor: query.cursor, limit: query.limit, unreadOnly: query.unreadOnly });
  });

  app.post(`${API_PREFIX}/notifications/:notificationId/read`, async (request) => {
    const who = await authenticate(request, guard, ["rider", "driver"]);
    const { notificationId } = parseBody(z.object({ notificationId: ID }), request.params);
    return markNotificationRead(deps.db, { audience: who.actor as Audience, subjectId: who.subjectId }, notificationId, now());
  });
}
