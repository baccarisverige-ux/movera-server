import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { API_PREFIX, buildApp } from "../src/app.js";
import { readEnv } from "../src/env.js";
import { contract } from "../src/contract/contract.js";
import { ApiError, STATUS_OF } from "../src/http/errors.js";

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ env: readEnv({ MOVERA_ENV: "development" }), logger: false });
  app.get(`${API_PREFIX}/__test/boom`, async () => {
    throw new Error("kaboom");
  });
  app.post(`${API_PREFIX}/__test/conflict`, async () => {
    throw new ApiError("version_mismatch", "Stale.", { projection: { tripId: "T1", version: 3 } });
  });
  app.post(`${API_PREFIX}/__test/busy`, async () => {
    throw new ApiError("rate_limited", "Slow down.", { retryAfterSeconds: 30 });
  });
  app.post(`${API_PREFIX}/__test/echo`, async (request) => request.body);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("health", () => {
  it("answers outside /api/v1 with the contract version", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", contract: "0.18.163", apiVersion: "0.5", env: "development", database: "not_configured" });
    expect((await app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
  });
});

describe("headers (contract §1)", () => {
  it("echoes the client's X-Request-Id and always sends X-Api-Version", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz", headers: { "x-request-id": "req-abc-123" } });
    expect(res.headers["x-request-id"]).toBe("req-abc-123");
    expect(res.headers["x-api-version"]).toBe("0.5");
  });

  it("makes its own request id when the client sends none or a bad one", async () => {
    const none = await app.inject({ method: "GET", url: "/healthz" });
    const bad = await app.inject({ method: "GET", url: "/healthz", headers: { "x-request-id": "has spaces" } });
    expect(String(none.headers["x-request-id"])).toMatch(/^[0-9a-f-]{36}$/);
    expect(String(bad.headers["x-request-id"])).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("refuses another API version with 400 invalid_request", async () => {
    const res = await app.inject({ method: "GET", url: `${API_PREFIX}/anything`, headers: { "x-api-version": "0.4" } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "invalid_request", reason: "unsupported_api_version", retryable: false });
  });
});

describe("error shape (contract §1 Errors)", () => {
  it("a route this server does not serve is 404 not_found, reason operation_not_enabled", async () => {
    const res = await app.inject({ method: "GET", url: `${API_PREFIX}/trips/T1`, headers: { "x-request-id": "r-404" } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      code: "not_found",
      message: "This operation is not enabled on this server.",
      requestId: "r-404",
      retryable: false,
      reason: "operation_not_enabled",
    });
  });

  it("an unexpected failure is 500 internal and leaks nothing", async () => {
    const res = await app.inject({ method: "GET", url: `${API_PREFIX}/__test/boom` });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ code: "internal", retryable: false });
    expect(res.body).not.toContain("kaboom");
  });

  it("a 409 version_mismatch carries the projection", async () => {
    const res = await app.inject({ method: "POST", url: `${API_PREFIX}/__test/conflict`, payload: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "version_mismatch", projection: { tripId: "T1", version: 3 } });
  });

  it("429 is retryable and says when to come back", async () => {
    const res = await app.inject({ method: "POST", url: `${API_PREFIX}/__test/busy`, payload: {} });
    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBe("30");
    expect(res.json()).toMatchObject({ code: "rate_limited", retryable: true });
  });

  it("broken JSON is 400 invalid_request", async () => {
    const res = await app.inject({ method: "POST", url: `${API_PREFIX}/__test/echo`, payload: "{nope", headers: { "content-type": "application/json" } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "invalid_request", reason: "invalid_json" });
  });

  it("every contract error code has a status, and nothing else does", () => {
    expect(Object.keys(STATUS_OF).sort()).toEqual([...(contract.errors.codes as string[])].sort());
    expect(() => new ApiError("teapot" as never, "x")).toThrow(/not in contract/);
  });
});
