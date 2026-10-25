import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { readEnv } from "../src/env.js";

/** CORS_ORIGINS: the apps' web builds on another site may call the API; any other site may not. */

let app: FastifyInstance;
const PAGES = "https://owner.github.io";

beforeAll(async () => {
  app = await buildApp({ env: readEnv({ MOVERA_ENV: "development", CORS_ORIGINS: `${PAGES}/, https://other.example` }), logger: false });
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

describe("cross-site browser calls", () => {
  it("answers an allowed origin's preflight with the contract's headers", async () => {
    const res = await app.inject({
      method: "OPTIONS",
      url: "/api/v1/trips",
      headers: { origin: PAGES, "access-control-request-method": "POST", "access-control-request-headers": "authorization, idempotency-key" },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(PAGES);
    expect(res.headers["access-control-allow-headers"]).toContain("Idempotency-Key");
    expect(res.headers["access-control-allow-methods"]).toContain("POST");
  });

  it("marks an allowed origin's answers and exposes the request id", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz", headers: { origin: PAGES } });
    expect(res.headers["access-control-allow-origin"]).toBe(PAGES);
    expect(res.headers["access-control-expose-headers"]).toContain("X-Request-Id");
    expect(res.headers.vary).toContain("Origin");
  });

  it("gives any other origin nothing", async () => {
    const res = await app.inject({ method: "OPTIONS", url: "/api/v1/trips", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(res.statusCode).not.toBe(204);
  });

  it("is off when no origins are set", async () => {
    const plain = await buildApp({ env: readEnv({ MOVERA_ENV: "development" }), logger: false });
    const res = await plain.inject({ method: "GET", url: "/healthz", headers: { origin: PAGES } });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    await plain.close();
  });

  it("refuses a setting that is not an origin", () => {
    expect(() => readEnv({ MOVERA_ENV: "development", CORS_ORIGINS: "owner.github.io" })).toThrow(/CORS_ORIGINS/);
  });
});

describe("blank settings", () => {
  it("count as not set, as a host's dashboard keeps an empty field", () => {
    const env = readEnv({ MOVERA_ENV: "development", GOOGLE_MAPS_API_KEY: "", ADMIN_BOOTSTRAP_EMAIL: "  ", CORS_ORIGINS: "" });
    expect(env.GOOGLE_MAPS_API_KEY).toBeUndefined();
    expect(env.ADMIN_BOOTSTRAP_EMAIL).toBeUndefined();
    expect(env.CORS_ORIGINS).toEqual([]);
  });
});
