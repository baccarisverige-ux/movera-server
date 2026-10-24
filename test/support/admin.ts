import type { FastifyInstance } from "fastify";
import type { Db } from "../../src/db/db.js";
import { createAdmin, createSetupLink } from "../../src/admin/auth.js";
import type { AdminRole } from "../../src/admin/permissions.js";

let counter = 0;

/** A signed-in admin of `role` (optionally limited to some zones), through the real setup-link flow. */
export async function adminSession(app: FastifyInstance, db: Db, role: AdminRole, options: { zoneIds?: string[]; now?: Date } = {}) {
  const now = options.now ?? new Date();
  const email = `${role}${++counter}@movera.test`;
  const { adminId } = await createAdmin(db, { email, name: `${role} ${counter}`, role, zoneIds: options.zoneIds ?? null }, now);
  const link = await createSetupLink({ db, jwtSecret: "unused", panelUrl: "https://admin.example.test", clock: () => now }, adminId, "test");
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/admin/auth/setup-password",
    headers: { "content-type": "application/json" },
    payload: { setupToken: new URL(link.url).hash.replace("#token=", ""), password: "a long test password" },
  });
  if (res.statusCode !== 200) throw new Error(`admin setup failed: ${res.body}`);
  const session = res.json() as { accessToken: string };
  return { adminId, email, token: session.accessToken, headers: { authorization: `Bearer ${session.accessToken}` } };
}
