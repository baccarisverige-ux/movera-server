import { ERROR_CODES } from "../contract/contract.js";

/** contract.json#errors.codes */
export type ErrorCode =
  | "invalid_request"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "otp_expired"
  | "conflict"
  | "invalid_transition"
  | "version_mismatch"
  | "rate_limited"
  | "unavailable"
  | "internal";

/** HTTP status per error code (CONTRACT.md §1 Errors, openapi responses). */
export const STATUS_OF: Record<ErrorCode, number> = {
  invalid_request: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  otp_expired: 410,
  conflict: 409,
  invalid_transition: 409,
  version_mismatch: 409,
  rate_limited: 429,
  unavailable: 503,
  internal: 500,
};

/** Only these are worth retrying with the same Idempotency-Key. */
const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>(["rate_limited", "unavailable"]);

/** contract `Error`: { code, message, requestId, retryable, reason?, projection? } */
export type ErrorBody = {
  code: ErrorCode;
  message: string;
  requestId: string;
  retryable: boolean;
  reason?: string;
  projection?: unknown;
};

const REASON = /^[a-z][a-z0-9_]{0,63}$/;

export class ApiError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly options: { reason?: string; projection?: unknown; retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.name = "ApiError";
    if (!ERROR_CODES.includes(code)) throw new Error(`Error code ${code} is not in contract.json#errors.codes`);
    if (options.reason !== undefined && !REASON.test(options.reason)) throw new Error(`Error reason ${options.reason} is not snake_case`);
    this.status = STATUS_OF[code];
    this.retryable = RETRYABLE.has(code);
  }

  body(requestId: string): ErrorBody {
    return {
      code: this.code,
      message: this.message,
      requestId,
      retryable: this.retryable,
      ...(this.options.reason !== undefined ? { reason: this.options.reason } : {}),
      ...(this.options.projection !== undefined ? { projection: this.options.projection } : {}),
    };
  }
}

export const badRequest = (message: string, reason?: string) => new ApiError("invalid_request", message, reason ? { reason } : {});
export const notFound = (message = "Not found.", reason?: string) => new ApiError("not_found", message, reason ? { reason } : {});
