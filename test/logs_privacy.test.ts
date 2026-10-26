import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { readEnv } from "../src/env.js";
import { freshDatabase, type TestDatabase } from "./support/db.js";

/** Audit Phase 4 (P4-7): what the server writes to its log never holds a phone number, e-mail or token. */

let database: TestDatabase;
beforeAll(async () => {
  database = await freshDatabase();
});
afterAll(async () => {
  await database.drop();
});

describe("server log privacy", () => {
  it("logs request lines without the query string or the Authorization header", async () => {
    const lines: string[] = [];
    const stream = new Writable({ write: (chunk, _enc, done) => (lines.push(String(chunk)), done()) });
    const env = readEnv({ MOVERA_ENV: "staging", DATABASE_URL: database.url, JWT_SECRET: "log-privacy-secret".padEnd(48, "l") });
    const app = await buildApp({ env, logger: { stream }, db: database.db });
    await app.inject({ method: "GET", url: "/api/v1/admin/riders?q=%2B46701740608&email=anna%40example.com", headers: { authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl" } });
    await app.close();
    const log = lines.join("");
    expect(log).toContain("/api/v1/admin/riders");
    expect(log).not.toMatch(/46701740608|anna|example\.com|eyJhbGci|Bearer/);
  });
});
