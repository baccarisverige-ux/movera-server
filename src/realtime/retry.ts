/**
 * S04 A2: a stream read that fails (pool timeout, DB blip) is tried again after 1 s, then 2, 4, … up to 30 s,
 * until one succeeds or the stream closes. Without this a failed read was only logged, and the stream stayed
 * silent (heartbeats still flowing) until some unrelated notification happened to read again.
 * Retrying keeps the stream's cursor, so nothing is skipped or sent twice; no contract change.
 */
export const READ_RETRY = { baseMs: 1000, maxMs: 30_000 };

export type ReadRetry = { failed: () => void; ok: () => void; stop: () => void };

export function readRetry(run: () => void, isClosed: () => boolean): ReadRetry {
  let attempt = 0;
  let timer: NodeJS.Timeout | undefined;
  return {
    failed: () => {
      if (timer !== undefined || isClosed()) return;
      const delay = Math.min(READ_RETRY.baseMs * 2 ** attempt, READ_RETRY.maxMs);
      attempt += 1;
      timer = setTimeout(() => {
        timer = undefined;
        if (!isClosed()) run();
      }, delay);
      timer.unref();
    },
    ok: () => {
      attempt = 0;
    },
    stop: () => {
      clearTimeout(timer);
      timer = undefined;
    },
  };
}
