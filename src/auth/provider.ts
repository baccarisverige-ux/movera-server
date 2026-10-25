import { createPublicKey, verify as verifySignature, type KeyObject } from "node:crypto";
import { ApiError, badRequest } from "../http/errors.js";

/**
 * Apple / Google sign-in (contract §8, contract.json#auth.providerKeys): the app gets an identity token from the
 * provider and sends it to the server, which checks the signature against the provider's published keys, the
 * issuer, the audience (the owner's client ids: APPLE_CLIENT_IDS / GOOGLE_CLIENT_IDS) and the expiry. Nothing
 * else is trusted from the token. A provider without client ids is not configured: 503 provider_not_configured.
 */

export type Provider = "apple" | "google";

export type ProviderIdentity = {
  subject: string;
  email?: string | undefined;
  emailVerified?: boolean | undefined;
  firstName?: string | undefined;
  lastName?: string | undefined;
};

export interface ProviderVerifier {
  readonly provider: Provider;
  /** Answers who the token names, or throws 400 invalid_request (invalid_provider_token). */
  verify(idToken: string, now: Date): Promise<ProviderIdentity>;
}

const ISSUERS: Record<Provider, { jwks: string; issuers: string[] }> = {
  apple: { jwks: "https://appleid.apple.com/auth/keys", issuers: ["https://appleid.apple.com"] },
  google: { jwks: "https://www.googleapis.com/oauth2/v3/certs", issuers: ["https://accounts.google.com", "accounts.google.com"] },
};

type Jwk = { kid?: string; kty: string; alg?: string; use?: string; n?: string; e?: string; crv?: string; x?: string; y?: string };

const bad = (reason = "invalid_provider_token") => badRequest("This sign-in token is not valid. Try again.", reason);

/** Fetches a provider's JWKS; keys are kept for an hour and refetched once when an unknown key id turns up. */
export class JwksVerifier implements ProviderVerifier {
  private keys = new Map<string, KeyObject>();
  private fetchedAt = 0;

  constructor(
    readonly provider: Provider,
    private readonly clientIds: readonly string[],
    private readonly fetchJson: (url: string) => Promise<unknown> = defaultFetch,
    private readonly ttlMs = 3_600_000,
  ) {
    if (clientIds.length === 0) throw new Error(`${provider}: no client ids`);
  }

  async verify(idToken: string, now: Date): Promise<ProviderIdentity> {
    const parts = idToken.split(".");
    if (parts.length !== 3) throw bad();
    const header = decodeJson(parts[0]!) as { alg?: string; kid?: string };
    const payload = decodeJson(parts[1]!) as Record<string, unknown>;
    if (header.alg !== "RS256" && header.alg !== "ES256") throw bad();
    const key = await this.key(header.kid, now);
    const ok = verifySignature(header.alg === "RS256" ? "sha256" : "sha256", Buffer.from(`${parts[0]}.${parts[1]}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(parts[2]!, "base64url"));
    if (!ok) throw bad();
    const { issuers } = ISSUERS[this.provider];
    if (typeof payload.iss !== "string" || !issuers.includes(payload.iss)) throw bad("invalid_provider_issuer");
    const aud = Array.isArray(payload.aud) ? (payload.aud as unknown[]) : [payload.aud];
    if (!aud.some((a) => typeof a === "string" && this.clientIds.includes(a))) throw bad("invalid_provider_audience");
    if (typeof payload.exp !== "number" || payload.exp * 1000 <= now.getTime()) throw bad("provider_token_expired");
    if (typeof payload.sub !== "string" || payload.sub.length === 0) throw bad();
    return identityFrom(payload);
  }

  private async key(kid: string | undefined, now: Date): Promise<KeyObject> {
    if (kid === undefined) throw bad();
    const stale = now.getTime() - this.fetchedAt > this.ttlMs;
    if (stale || !this.keys.has(kid)) await this.refresh(now);
    const key = this.keys.get(kid);
    if (key === undefined) throw bad("unknown_provider_key");
    return key;
  }

  private async refresh(now: Date): Promise<void> {
    let body: unknown;
    try {
      body = await this.fetchJson(ISSUERS[this.provider].jwks);
    } catch {
      throw new ApiError("unavailable", "The sign-in provider is not reachable. Try again.", { reason: "provider_unavailable", retryAfterSeconds: 10 });
    }
    const keys = (body as { keys?: Jwk[] }).keys ?? [];
    const next = new Map<string, KeyObject>();
    for (const jwk of keys) {
      if (jwk.kid === undefined) continue;
      try {
        next.set(jwk.kid, createPublicKey({ key: jwk as never, format: "jwk" }));
      } catch {
        // A key the runtime cannot read is skipped; a token signed with it fails as unknown.
      }
    }
    this.keys = next;
    this.fetchedAt = now.getTime();
  }
}

/** What the apps show on the details screen: Google gives names, Apple gives none (the app sends them once). */
export function identityFrom(payload: Record<string, unknown>): ProviderIdentity {
  const email = typeof payload.email === "string" && payload.email.includes("@") ? payload.email : undefined;
  const verified = payload.email_verified === true || payload.email_verified === "true";
  return {
    subject: String(payload.sub),
    email,
    emailVerified: email !== undefined ? verified : undefined,
    firstName: typeof payload.given_name === "string" ? payload.given_name : undefined,
    lastName: typeof payload.family_name === "string" ? payload.family_name : undefined,
  };
}

/** "Anna Lind" → Anna / Lind; a single word is the first name. */
export function splitName(name: string | undefined): { firstName?: string; lastName?: string } {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return {};
  if (words.length === 1) return { firstName: words[0]! };
  return { firstName: words.slice(0, -1).join(" "), lastName: words[words.length - 1]! };
}

function decodeJson(part: string): unknown {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    throw bad();
  }
}

async function defaultFetch(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response.json();
}

/** The verifiers the server runs with: one per provider whose client ids are set. */
export function providersFrom(env: { APPLE_CLIENT_IDS: string[]; GOOGLE_CLIENT_IDS: string[] }): Partial<Record<Provider, ProviderVerifier>> {
  return {
    ...(env.APPLE_CLIENT_IDS.length ? { apple: new JwksVerifier("apple", env.APPLE_CLIENT_IDS) } : {}),
    ...(env.GOOGLE_CLIENT_IDS.length ? { google: new JwksVerifier("google", env.GOOGLE_CLIENT_IDS) } : {}),
  };
}
