import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Access tokens (contract §8): a short-lived JWT, HS256, signed with JWT_SECRET. Claims: sub (subject id), actor,
 * sid (the session, checked on every request so sign-out takes effect at once), zones, iat, exp.
 * Only this server makes and reads them, so one shared secret is enough; no other algorithm is accepted.
 */

export type Actor = "rider" | "driver" | "admin";

export type AccessClaims = {
  sub: string;
  actor: Actor;
  sid: string;
  zones: string[];
  iat: number;
  exp: number;
  iss: "movera";
  typ: "access";
  /** Admins only: the role and the fully expanded permissions (contract §9). */
  role?: string;
  perms?: string[];
};

const HEADER = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

function sign(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

export function signAccessToken(
  claims: { sub: string; actor: Actor; sid: string; zones: string[]; role?: string; perms?: string[] },
  secret: string,
  ttlSeconds: number,
  now: Date = new Date(),
): string {
  const iat = Math.floor(now.getTime() / 1000);
  const body: AccessClaims = { ...claims, iat, exp: iat + ttlSeconds, iss: "movera", typ: "access" };
  const payload = base64url(JSON.stringify(body));
  return `${HEADER}.${payload}.${sign(`${HEADER}.${payload}`, secret)}`;
}

export type VerifyResult = { ok: true; claims: AccessClaims } | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

/**
 * Checks the signature first, then the claims. `graceSeconds` accepts a token that expired at most that long ago;
 * only sign-out uses it, so an app can always sign out, but a token from long ago cannot.
 */
export function verifyAccessToken(token: string, secret: string, now: Date = new Date(), graceSeconds = 0): VerifyResult {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [header, payload, signature] = parts as [string, string, string];
  if (header !== HEADER) return { ok: false, reason: "malformed" };
  const expected = Buffer.from(sign(`${header}.${payload}`, secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: "bad_signature" };
  let claims: AccessClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as AccessClaims;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    claims.typ !== "access" ||
    claims.iss !== "movera" ||
    typeof claims.sub !== "string" ||
    typeof claims.sid !== "string" ||
    !["rider", "driver", "admin"].includes(claims.actor) ||
    !Array.isArray(claims.zones) ||
    typeof claims.exp !== "number"
  ) {
    return { ok: false, reason: "malformed" };
  }
  if (claims.exp + graceSeconds <= Math.floor(now.getTime() / 1000)) return { ok: false, reason: "expired" };
  return { ok: true, claims };
}
