import type pg from "pg";

/**
 * Rule 28 (Render deploy 2026-11-05, dd17083): a database that is restarting must never stop the server.
 * These errors mean "the database cannot be reached right now", not a bug: wait, back off, try again.
 *  - 57P03 the database system is starting up / shutting down (cannot_connect_now)
 *  - 57P01 / 57P02 admin or crash shutdown, 08xxx connection exceptions
 *  - ECONNREFUSED / ECONNRESET / ETIMEDOUT / ENOTFOUND / EAI_AGAIN from the socket
 *  - pg's "Connection terminated" messages and pg-pool's connect timeout
 */
const CODES = new Set(["57P01", "57P02", "57P03", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE"]);

export function isDatabaseConnectionError(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const e = error as { code?: unknown; message?: unknown; errors?: unknown; cause?: unknown };
  if (typeof e.code === "string" && (CODES.has(e.code) || e.code.startsWith("08"))) return true;
  if (typeof e.message === "string" && /connection terminated|terminating connection|the database system is (starting up|shutting down|in recovery mode)|timeout exceeded when trying to connect|Connection refused/i.test(e.message)) return true;
  // AggregateError (several addresses refused) and wrapped causes.
  if (Array.isArray(e.errors) && e.errors.some(isDatabaseConnectionError)) return true;
  return e.cause !== undefined && e.cause !== error && isDatabaseConnectionError(e.cause);
}

export type WaitOptions = {
  /** Give up after this long (default about 2 minutes). */
  maxWaitMs?: number;
  firstDelayMs?: number;
  maxDelayMs?: number;
  log?: (data: object, message: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

/**
 * Waits until the database answers `SELECT 1`, retrying connection errors with a growing delay (0.5 s, 1 s, 2 s, …
 * at most 10 s) for up to about 2 minutes. Any other error (wrong password, unknown database) is thrown at once.
 */
export async function waitForDatabase(pool: Pick<pg.Pool, "query">, options: WaitOptions = {}): Promise<number> {
  const maxWaitMs = options.maxWaitMs ?? 120_000;
  const maxDelayMs = options.maxDelayMs ?? 10_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const started = now();
  let delay = options.firstDelayMs ?? 500;
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query("SELECT 1");
      if (attempt > 1) options.log?.({ attempts: attempt }, "database is ready");
      return attempt;
    } catch (error) {
      if (!isDatabaseConnectionError(error)) throw error;
      const waited = now() - started;
      if (waited + delay > maxWaitMs) throw error;
      options.log?.({ attempt, code: (error as { code?: string }).code, err: (error as Error).message, retryInMs: delay }, "database not ready yet; waiting");
      await sleep(delay);
      delay = Math.min(delay * 2, maxDelayMs);
    }
  }
}

/**
 * Last line of defence: a database connection error that escapes some background promise is logged and the
 * process keeps running (the pool reconnects on the next query; /readyz answers 503 meanwhile). Anything else
 * still stops the process, as Node does by default, so real bugs are not hidden.
 */
export function guardProcess(
  log: { error: (data: object, message: string) => void },
  proc: Pick<NodeJS.Process, "on"> & { exit: (code: number) => void } = process,
): void {
  const handle = (kind: string) => (error: unknown) => {
    if (isDatabaseConnectionError(error)) {
      log.error({ err: error, kind }, "database connection error outside a request; the server keeps running");
      return;
    }
    log.error({ err: error, kind }, "fatal error; stopping");
    proc.exit(1);
  };
  proc.on("unhandledRejection", handle("unhandledRejection"));
  proc.on("uncaughtException", handle("uncaughtException"));
}
