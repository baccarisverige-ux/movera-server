import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLEANUP_TELEMETRY, housekeepingHandlers } from "../../src/jobs/housekeeping.js";
import { Sim } from "./harness.js";

/**
 * Audit Phase 4 (P4-5, Phase 3 contract gap): POST /telemetry/logs|analytics|crashes (contract §11). The apps sent
 * their logs to a 404 (operation_not_enabled), so they were lost. No token needed (one is used when sent), no
 * Idempotency-Key, 202 with an empty body, 16 KB at most, rate limited per address, scrubbed again, kept 30 days.
 */

let sim: Sim;
beforeAll(async () => {
  sim = await Sim.start();
});
afterAll(async () => {
  await sim?.stop();
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${sim.base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("Phase 4: telemetry", () => {
  it("takes a log line without a token or key: 202, empty body, stored scrubbed", async () => {
    const res = await post("/telemetry/logs", { level: "error", event: "ride.failed", extra: { note: "call +46 70 174 06 08 or a.b@example.com at 59.33261,18.06491", count: 2 }, error: "boom for anna@example.com" });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
    const row = await sim.db.selectFrom("telemetry").selectAll().where("event", "=", "ride.failed").executeTakeFirstOrThrow();
    const text = JSON.stringify(row);
    expect(text).not.toMatch(/174 06 08|example\.com|59\.33261/);
    expect(row).toMatchObject({ kind: "log", level: "error", actor: null });
    expect(row.body).toMatchObject({ extra: { count: 2 } });
  });

  it("uses the token when one is sent; analytics and crashes too", async () => {
    const rider = await sim.rider(0);
    expect((await post("/telemetry/analytics", { event: "home.opened" }, { authorization: `Bearer ${rider.token}` })).status).toBe(202);
    expect((await post("/telemetry/crashes", { error: "StateError", stack: "at main.dart:1" })).status).toBe(202);
    const rows = await sim.db.selectFrom("telemetry").select(["kind", "actor", "subject_id"]).where("kind", "in", ["analytics", "crash"]).orderBy("kind").execute();
    expect(rows).toEqual([
      { kind: "analytics", actor: "rider", subject_id: rider.id },
      { kind: "crash", actor: null, subject_id: null },
    ]);
  });

  it("refuses a bad body and one over 16 KB (400 payload_too_large)", async () => {
    const bad = await post("/telemetry/logs", { level: "loud", event: "x" });
    expect(bad.status).toBe(400);
    const big = await post("/telemetry/logs", { level: "info", event: "x", extra: { blob: "a".repeat(17_000) } });
    expect(big.status).toBe(400);
    expect(((await big.json()) as { reason: string }).reason).toBe("payload_too_large");
  });

  it("is rate limited per address (429 with Retry-After)", async () => {
    let limited: Response | undefined;
    for (let i = 0; i < 200 && limited === undefined; i++) {
      const res = await post("/telemetry/analytics", { event: `burst.${i}` });
      if (res.status === 429) limited = res;
      else expect(res.status).toBe(202);
    }
    expect(limited?.status).toBe(429);
    expect(Number(limited?.headers.get("retry-after"))).toBeGreaterThan(0);
    await sim.advance(61);
    expect((await post("/telemetry/analytics", { event: "after.minute" })).status).toBe(202);
  });

  it("keeps entries 30 days", async () => {
    const later = new Date(sim.clock.now.getTime() + 31 * 24 * 3600_000);
    // S4 0.14b: the telemetry clean-up has its own hourly timer.
    await sim.db.transaction().execute((trx) => housekeepingHandlers[CLEANUP_TELEMETRY]!(trx, { firedAt: later } as never));
    expect(await sim.db.selectFrom("telemetry").selectAll().execute()).toEqual([]);
  });
});
