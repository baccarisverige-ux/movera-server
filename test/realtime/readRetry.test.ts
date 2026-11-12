import { afterEach, describe, expect, it, vi } from "vitest";
import { READ_RETRY_DEFAULTS, configureReadRetry, readRetry, readRetrySettings, spreadClose } from "../../src/realtime/retry.js";
import { readEnv } from "../../src/env.js";
import { buildApp } from "../../src/app.js";

/** S04 A2: the one retry helper every stream pump uses (trip, config, offers, admin live, dispatch, incidents). */
describe("readRetry", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    configureReadRetry(READ_RETRY_DEFAULTS);
  });

  it("retries after 1, 2, 4 … s capped at 30 s, resets on success, stops when the stream closes", () => {
    vi.useFakeTimers();
    // B1.9: the back-off itself is unchanged; with more retries allowed it still doubles up to the 30 s cap.
    configureReadRetry({ maxRetries: 10 });
    let runs = 0;
    let closed = false;
    const retry = readRetry(() => (runs += 1), () => closed, () => undefined);
    const gaps = [1000, 2000, 4000, 8000, 16000, 30000, 30000];
    for (const gap of gaps) {
      retry.failed();
      retry.failed(); // a second failure while one retry waits does not stack
      vi.advanceTimersByTime(gap - 1);
      const before = runs;
      vi.advanceTimersByTime(1);
      expect(runs).toBe(before + 1);
    }
    retry.ok();
    retry.failed();
    vi.advanceTimersByTime(1000);
    expect(runs).toBe(gaps.length + 1);
    retry.failed();
    closed = true;
    vi.advanceTimersByTime(60_000);
    expect(runs).toBe(gaps.length + 1);
    closed = false;
    retry.failed();
    retry.stop();
    vi.advanceTimersByTime(60_000);
    expect(runs).toBe(gaps.length + 1);
  });

  it("B1.9: STREAM_READ_RETRIES / STREAM_CLOSE_SPREAD_MS default to 3 and 30 s", () => {
    const env = readEnv({ MOVERA_ENV: "development" });
    expect(env.STREAM_READ_RETRIES).toBe(3);
    expect(env.STREAM_CLOSE_SPREAD_MS).toBe(30_000);
    expect(READ_RETRY_DEFAULTS).toMatchObject({ maxRetries: 3, closeSpreadMs: 30_000 });
    expect(() => readEnv({ MOVERA_ENV: "development", STREAM_READ_RETRIES: "-1" })).toThrow();
  });

  it("B1.9: buildApp applies STREAM_READ_RETRIES and STREAM_CLOSE_SPREAD_MS from the env", async () => {
    const app = await buildApp({ env: readEnv({ MOVERA_ENV: "development", STREAM_READ_RETRIES: "5", STREAM_CLOSE_SPREAD_MS: "12000" }), logger: false });
    await app.close();
    expect(readRetrySettings()).toMatchObject({ maxRetries: 5, closeSpreadMs: 12_000 });
  });

  it("B1.9: a read that succeeds while the close waits cancels the close and starts the retries over", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    let closes = 0;
    let runs = 0;
    const retry = readRetry(() => (runs += 1), () => false, () => (closes += 1));
    for (const gap of [0, 1000, 2000, 4000]) {
      await vi.advanceTimersByTimeAsync(gap);
      retry.failed();
    }
    expect(runs).toBe(3);
    await vi.advanceTimersByTimeAsync(10_000); // close is due at 15 s
    retry.ok();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(closes).toBe(0);
    retry.failed();
    await vi.advanceTimersByTimeAsync(1000);
    expect(runs).toBe(4); // back to the first 1 s retry
  });

  it("B1.9: the close waits while the pool is over its shed limit, then closes after a new random delay", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.1); // 3 s each draw
    let busy = true;
    configureReadRetry({ maxRetries: 0, closeSpreadMs: 30_000, holdClose: () => busy });
    let closes = 0;
    const retry = readRetry(() => undefined, () => false, () => (closes += 1));
    retry.failed();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(closes).toBe(0);
    busy = false;
    await vi.advanceTimersByTimeAsync(2999);
    expect(closes).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(closes).toBe(1);
  });

  it("B1.9: STREAM_READ_RETRIES=0 and STREAM_CLOSE_SPREAD_MS=0 close at the first failure; stop() cancels a pending close", async () => {
    vi.useFakeTimers();
    configureReadRetry({ maxRetries: 0, closeSpreadMs: 0 });
    expect(readRetrySettings().maxRetries).toBe(0);
    let closes = 0;
    const a = readRetry(() => undefined, () => false, () => (closes += 1));
    a.failed();
    await vi.advanceTimersByTimeAsync(0);
    expect(closes).toBe(1);
    configureReadRetry({ closeSpreadMs: 30_000 });
    const b = readRetry(() => undefined, () => false, () => (closes += 1));
    b.failed();
    b.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(closes).toBe(1);
    const c = readRetry(() => undefined, () => false, () => (closes += 1), { spread: false });
    c.failed();
    expect(closes).toBe(2);
  });

  it("with spread 0 and the pool busy, a held close re-checks at most about once a second (supervisor B1.9 L1)", () => {
    vi.useFakeTimers();
    try {
      let checks = 0;
      configureReadRetry({ closeSpreadMs: 0, holdClose: () => (checks++, true) });
      const cancel = spreadClose(() => undefined, () => false);
      vi.advanceTimersByTime(10_000);
      cancel();
      expect(checks).toBeLessThanOrEqual(12);
    } finally {
      vi.useRealTimers();
    }
  });
});
