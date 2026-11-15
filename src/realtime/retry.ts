/**
 * S04 A2: a stream read that fails (pool timeout, DB blip) is tried again after 1 s, then 2, 4, … up to 30 s.
 * Without this a failed read was only logged, and the stream stayed silent (heartbeats still flowing) until some
 * unrelated notification happened to read again. Retrying keeps the stream's cursor, so nothing is skipped or sent
 * twice; no contract change.
 *
 * B1.9 (owner W1 Q73, 2026-11-11): at most `maxRetries` retries (STREAM_READ_RETRIES, default 3: 1, 2, 4 s); the
 * next failure gives up and the stream is closed, so the app reconnects with its cursor (and re-reads, contract
 * v0.18.63). The close waits a random 0 – `closeSpreadMs` (STREAM_CLOSE_SPREAD_MS, default 30 s), so the streams of
 * one DB blip do not all reconnect in the same instant, and it waits again (a new random delay) while `holdClose()`
 * says the database pool is over its shed limit (SHED_POOL_WAITING). A read that succeeds meanwhile cancels the close.
 */
export const READ_RETRY = { baseMs: 1000, maxMs: 30_000 };

export type ReadRetrySettings = { maxRetries: number; closeSpreadMs: number; holdClose: () => boolean };
export const READ_RETRY_DEFAULTS: ReadRetrySettings = { maxRetries: 3, closeSpreadMs: 30_000, holdClose: () => false };
const settings: ReadRetrySettings = { ...READ_RETRY_DEFAULTS };

/** Set from the env at start (buildApp: retries and spread; main.ts: the pool check). Unset fields keep their value. */
export function configureReadRetry(next: Partial<ReadRetrySettings>): void {
  Object.assign(settings, next);
}

/** The current settings (tests, /healthz-style reads). */
export function readRetrySettings(): Readonly<ReadRetrySettings> {
  return settings;
}

/**
 * Calls `close` after a random 0 – closeSpreadMs, unless `isClosed()` by then; while `holdClose()` it draws a new
 * delay instead. Returns a cancel function. With `maxHoldMs`, the pool check stops holding the close once that long
 * has passed since the call (B1.18: a stream is never held open for ever); without it the B1.9 behaviour is unchanged.
 */
export function spreadClose(close: () => void, isClosed: () => boolean, options: { maxHoldMs?: number } = {}): () => void {
  let timer: NodeJS.Timeout | undefined;
  const holdUntil = options.maxHoldMs === undefined ? Infinity : Date.now() + options.maxHoldMs;
  // A re-check while the pool is busy waits at least 1 s, so a spread of 0 cannot spin (supervisor B1.9 L1).
  const arm = (minMs: number) => {
    timer = setTimeout(() => {
      timer = undefined;
      if (isClosed()) return;
      if (Date.now() < holdUntil && settings.holdClose()) return arm(1000);
      close();
    }, Math.max(minMs, Math.floor(Math.random() * settings.closeSpreadMs)));
    timer.unref();
  };
  arm(0);
  return () => {
    clearTimeout(timer);
    timer = undefined;
  };
}

export type ReadRetry = { failed: () => void; ok: () => void; stop: () => void };

/**
 * `giveUp` closes the stream (or, for a shared reader, its streams). With `{ spread: false }` it is called at once and
 * the caller spreads the closes itself (spreadClose per stream).
 */
export function readRetry(run: () => void, isClosed: () => boolean, giveUp: () => void, options: { spread?: boolean } = {}): ReadRetry {
  let attempt = 0;
  let timer: NodeJS.Timeout | undefined;
  let cancelClose: (() => void) | undefined;
  return {
    failed: () => {
      if (timer !== undefined || cancelClose !== undefined || isClosed()) return;
      if (attempt >= settings.maxRetries) {
        if (options.spread === false) return giveUp();
        cancelClose = spreadClose(() => {
          cancelClose = undefined;
          giveUp();
        }, isClosed);
        return;
      }
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
      cancelClose?.();
      cancelClose = undefined;
    },
    stop: () => {
      clearTimeout(timer);
      timer = undefined;
      cancelClose?.();
      cancelClose = undefined;
      attempt = 0;
    },
  };
}

/** B1.9: what a stream says when it gives up on its reads; the app reconnects with its cursor and re-reads. */
export function giveUpStream(stream: { comment: (text: string) => void; close: () => void }, why = "stream read failed; reconnect to catch up"): void {
  stream.comment(why);
  stream.close();
}
