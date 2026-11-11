import { afterEach, describe, expect, it, vi } from "vitest";
import { readRetry } from "../../src/realtime/retry.js";

/** S04 A2: the one retry helper every stream pump uses (trip, config, offers, admin live, dispatch, incidents). */
describe("readRetry", () => {
  afterEach(() => vi.useRealTimers());

  it("retries after 1, 2, 4 … s capped at 30 s, resets on success, stops when the stream closes", () => {
    vi.useFakeTimers();
    let runs = 0;
    let closed = false;
    const retry = readRetry(() => (runs += 1), () => closed);
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
});
