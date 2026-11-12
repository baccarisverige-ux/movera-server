import { Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { readEnv } from "../src/env.js";
import { seedTestPhones, TEST_PHONES } from "../src/auth/testPhones.js";
import { scrubLogError } from "../src/telemetry/scrub.js";
import { freshDatabase, type TestDatabase } from "./support/db.js";
import { signIn } from "./support/world.js";

/** Audit Phase 4 (P4-7): what the server writes to its log never holds a phone number, e-mail or token. */

let database: TestDatabase;
beforeAll(async () => {
  database = await freshDatabase();
  await seedTestPhones(database.db);
});
afterAll(async () => {
  await database.drop();
});

/** B1.27: builds the app with a log stream, runs `run`, closes, and returns everything written to the log. */
async function logOf(run: (app: FastifyInstance) => Promise<void>, options: { env?: "staging" | "development"; before?: (app: FastifyInstance) => void } = {}): Promise<string> {
  const lines: string[] = [];
  const stream = new Writable({ write: (chunk, _enc, done) => (lines.push(String(chunk)), done()) });
  const env = readEnv({ MOVERA_ENV: options.env ?? "staging", DATABASE_URL: database.url, JWT_SECRET: "log-privacy-secret".padEnd(48, "l") });
  const app = await buildApp({ env, logger: { stream }, db: database.db });
  options.before?.(app);
  try {
    await run(app);
  } finally {
    await app.close();
  }
  return lines.join("");
}

describe("server log privacy", () => {
  it("logs request lines without the query string or the Authorization header", async () => {
    const log = await logOf(async (app) => {
      await app.inject({ method: "GET", url: "/api/v1/admin/riders?q=%2B46701740608&email=anna%40example.com", headers: { authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl" } });
    });
    expect(log).toContain("/api/v1/admin/riders");
    expect(log).not.toMatch(/46701740608|anna|example\.com|eyJhbGci|Bearer/);
  });

  it("B1.27: logs the route pattern, not a path with coordinates or ids", async () => {
    const log = await logOf(async (app) => {
      await app.inject({ method: "GET", url: "/api/v1/routes/driving/18.0651,59.3331;18.0702,59.3404" });
      await app.inject({ method: "GET", url: "/api/v1/admin/trips/trp_b127secret" });
    });
    expect(log).toContain("/api/v1/routes/driving/:coordinates");
    expect(log).toContain("/api/v1/admin/trips/:tripId");
    expect(log).not.toMatch(/59\.3331|18\.0651|trp_b127secret/);
  });

  it("B1.27: an unknown path is not written", async () => {
    const log = await logOf(async (app) => {
      const res = await app.inject({ method: "GET", url: "/api/v1/nowhere/59.33261,18.06491" });
      expect(res.statusCode).toBe(404);
    });
    expect(log).toContain("incoming request");
    expect(log).not.toMatch(/59\.33261|18\.06491|nowhere/);
  });

  it("B1.27: a 500 log is scrubbed and keeps no error properties", async () => {
    const log = await logOf(
      async (app) => {
        const res = await app.inject({ method: "GET", url: "/api/v1/test-only/boom" });
        expect(res.statusCode).toBe(500);
      },
      {
        before: (app) =>
          app.get("/api/v1/test-only/boom", async () => {
            throw Object.assign(new Error("Database exploded for anna@example.com at 59.33261,18.06491"), { detail: "Key (email)=(bo@example.se) already exists", code: "23505" });
          }),
      },
    );
    expect(log).toContain("unhandled error");
    expect(log).toContain("[email]");
    expect(log).toContain('"code":"23505"');
    expect(log).not.toMatch(/anna@|bo@example|59\.33261|already exists/);
  });

  it("B1.27: a 'database busy' log is scrubbed", async () => {
    const log = await logOf(
      async (app) => {
        const res = await app.inject({ method: "GET", url: "/api/v1/test-only/busy" });
        expect(res.statusCode).toBe(503);
      },
      {
        before: (app) =>
          app.get("/api/v1/test-only/busy", async () => {
            throw Object.assign(new Error("canceling statement for anna@example.com"), { code: "57014", where: "SQL statement near 59.33261,18.06491" });
          }),
      },
    );
    expect(log).toContain("database busy");
    expect(log).not.toMatch(/anna@|59\.33261/);
  });

  it("B1.27: no e-mail change code in a staging log", async () => {
    const log = await logOf(async (app) => {
      const rider = await signIn(app, TEST_PHONES[0]!, "rider");
      const res = await app.inject({ method: "POST", url: "/api/v1/account/email/change", headers: rider.headers, payload: { email: "b127@example.se" } });
      expect(res.statusCode).toBe(200);
    });
    expect(log).not.toContain("e-mail change code");
    expect(log).not.toMatch(/"code":"\d{4,8}"/);
  });

  it("B1.27: development still logs the e-mail change code", async () => {
    const log = await logOf(
      async (app) => {
        const rider = await signIn(app, TEST_PHONES[1]!, "rider");
        const res = await app.inject({ method: "POST", url: "/api/v1/account/email/change", headers: rider.headers, payload: { email: "b127dev@example.se" } });
        expect(res.statusCode).toBe(200);
      },
      { env: "development" },
    );
    expect(log).toContain("e-mail change code");
  });

  it("B1.27: the log error serializer scrubs strings and plain objects, keeps only safe codes and cuts long stacks", () => {
    expect(scrubLogError("push failed for anna@example.com")).toEqual({ type: "string", message: "push failed for [email]", stack: "" });
    expect(scrubLogError(undefined)).toEqual({ type: "undefined", message: "undefined", stack: "" });
    expect(scrubLogError({ message: "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl", phone: "+46701740608" })).toEqual({ type: "Object", message: "token [token]", stack: "" });
    expect(scrubLogError(Object.assign(new Error("x"), { code: "bo@example.se" }))).not.toHaveProperty("code");
    expect(scrubLogError(Object.assign(new Error("x"), { code: 7 })).code).toBe(7);
    const long = new Error("x");
    long.stack = "y".repeat(10_000);
    expect(scrubLogError(long).stack.length).toBe(4000);
  });
});
