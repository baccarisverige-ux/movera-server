import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { seedTestPhones } from "../../src/auth/testPhones.js";
import { readEnv } from "../../src/env.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";

// Owner 2026-11-04 (B7, "B: Empty screens"): a preview token's own-account reads answer the normal empty result.
let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-11-04T10:00:00Z") };
const SECRET = "preview-reads-secret".padEnd(48, "z");

beforeAll(async () => {
  database = await freshDatabase();
  await seedTestPhones(database.db);
  app = await buildApp({ env: readEnv({ MOVERA_ENV: "staging", DATABASE_URL: database.url, JWT_SECRET: SECRET }), logger: false, db: database.db, clock: () => clock.now });
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

async function token(role: "rider" | "driver") {
  const owner = await adminSession(app, database.db, "super", { now: clock.now });
  const res = await app.inject({ method: "POST", url: "/api/v1/admin/preview-sessions", headers: { ...owner.headers, "content-type": "application/json", "idempotency-key": `pv-${role}-0000000001` }, payload: { role, zoneId: "Z001" } });
  return { authorization: `Bearer ${res.json().token}` };
}

export const RIDER_READS = ["/rider/profile", "/rider/trips", "/rider/trips/active", "/rider/refunds", "/rider/favourite-drivers", "/wallet", "/wallet/entries", "/payment-methods", "/notifications", "/support/tickets"];
export const DRIVER_READS = ["/driver/profile", "/driver/documents", "/driver/earnings", "/driver/fleet", "/driver/fleet/earnings", "/driver/fleet/invitations", "/driver/offers", "/driver/payouts", "/driver/reminders", "/driver/reservations", "/driver/vehicles", "/notifications", "/support/tickets"];

describe("preview: own-account reads are empty, never an error", () => {
  for (const role of ["rider", "driver"] as const) {
    it(`${role} reads`, async () => {
      const headers = await token(role);
      for (const path of role === "rider" ? RIDER_READS : DRIVER_READS) {
        const res = await app.inject({ method: "GET", url: `/api/v1${path}`, headers });
        // The normal answers of a brand-new account: no active trip (204), not in a fleet (404 no_fleet), not a fleet owner.
        const normal = (path === "/rider/trips/active" && res.statusCode === 204) || (path === "/driver/fleet" && res.json().reason === "no_fleet") || (path === "/driver/fleet/earnings" && res.json().reason === "not_fleet_owner");
        if (normal) continue;
        expect({ path, status: res.statusCode }).toEqual({ path, status: 200 });
        const body = res.json();
        if (Array.isArray(body.items)) expect(body.items.filter((item: { method?: string }) => item.method !== "cash")).toEqual([]);
      }
      if (role === "rider") {
        expect((await app.inject({ method: "GET", url: "/api/v1/wallet", headers })).json().balance).toEqual({ amountMinor: 0, currency: "SEK" });
        expect((await app.inject({ method: "GET", url: "/api/v1/rider/profile", headers })).json()).toMatchObject({ riderId: "preview:rider:Z001", firstName: "" });
        // A rider preview token never reads the driver's blank profile.
        expect((await app.inject({ method: "GET", url: "/api/v1/driver/profile", headers })).json().reason).toBe("wrong_actor");
      } else {
        expect((await app.inject({ method: "GET", url: "/api/v1/driver/profile", headers })).json()).toMatchObject({ driverId: "preview:driver:Z001", accountStatus: "active", onlineStatus: "offline", firstName: "" });
      }
    });
  }
});
