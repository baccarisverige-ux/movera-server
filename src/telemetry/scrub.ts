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
