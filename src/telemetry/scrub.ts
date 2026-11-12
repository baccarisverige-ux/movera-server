/** contract §11: the server scrubs telemetry again before storing (e-mails, phone numbers, coordinates, tokens). */

/** Keys whose values are never kept, whatever they hold. */
const PRIVATE_KEY = /^(lat|lng|lon|latitude|longitude|phone|email|e-?mail|token|accesstoken|refreshtoken|password|authorization|code|pin)$/i;

export function scrubText(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [token]")
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, "[token]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/-?\d{1,3}\.\d{3,}\s*[,;\s]\s*-?\d{1,3}\.\d{3,}/g, "[coordinates]")
    .replace(/-?\b\d{1,3}\.\d{4,}\b/g, "[coordinate]")
    .replace(/\+?\d[\d\s().-]{6,}\d/g, "[phone]");
}

export function scrub(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return scrubText(value);
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = PRIVATE_KEY.test(k) ? "[removed]" : scrub(v, depth + 1);
  return out;
}

/** B1.27: the longest stack a log line keeps (a busy storm must not write huge lines). */
const LOG_STACK_MAX = 4000;
const LOG_CODE = /^[A-Za-z0-9_]{1,40}$/;

/**
 * B1.27 (owner, Sitting W1): what a server log line keeps of an error: its type, its scrubbed message and stack, and its
 * code (a pg code like 57014 or a Fastify code). Every other property is dropped: a pg error's `detail` or `where` can
 * hold an e-mail, a phone number or a place. A string or other plain value becomes the scrubbed message.
 */
export function scrubLogError(value: unknown): { type: string; message: string; stack: string; code?: string | number } {
  if (value === null || typeof value !== "object") return { type: typeof value, message: scrubText(String(value)), stack: "" };
  const e = value as { name?: unknown; message?: unknown; stack?: unknown; code?: unknown };
  const out: { type: string; message: string; stack: string; code?: string | number } = {
    type: typeof e.name === "string" ? e.name : (value.constructor?.name ?? "Object"),
    message: typeof e.message === "string" ? scrubText(e.message) : "",
    stack: typeof e.stack === "string" ? scrubText(e.stack.slice(0, LOG_STACK_MAX)) : "",
  };
  if ((typeof e.code === "string" && LOG_CODE.test(e.code)) || typeof e.code === "number") out.code = e.code;
  return out;
}
