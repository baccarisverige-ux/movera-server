import { X509Certificate, createHash, timingSafeEqual } from "node:crypto";
import { contract } from "../contract/contract.js";
import type { Env } from "../env.js";
import { GoogleAccessTokens, parseServiceAccount, type FetchLike } from "../push/fcm.js";

/**
 * Contract v0.18.138 (contract.json#deviceCheck; owner 2026-11-20 "Ok" to Rules
 * audits/impact/sms-abuse-open-launch-2026-11-20.md, "build BOTH"): the real-phone check before a sign-in SMS.
 *
 * Android: a Google Play Integrity token (classic request, nonce = the binding), decoded by Google with the service
 * account in PLAY_INTEGRITY_SERVICE_ACCOUNT. iPhone: an Apple App Attest attestation object for a key made for this
 * request, checked here against the Apple App Attestation root in APPLE_APP_ATTEST_ROOT_CA (INACTIVE until the owner's
 * Apple account exists: without both iPhone keys no iPhone check can pass). A platform whose keys are not set has no
 * verifier, so its check fails (fail closed). Nothing here logs a token, a key id or an install id.
 */

type DeviceCheckContract = { maxAgeSeconds: number; timeoutSeconds: number };
export const DEVICE_CHECK = (contract as unknown as { deviceCheck: DeviceCheckContract }).deviceCheck;

export type DevicePlatform = "android" | "ios";
export type DeviceCheckInput = { platform: DevicePlatform; token: string; keyId?: string | undefined };
export type DeviceCheckOutcome = { ok: true } | { ok: false; why: string };
export interface DeviceVerifier {
  verify(input: { token: string; keyId?: string | undefined; binding: Buffer; signal?: AbortSignal | undefined }): Promise<DeviceCheckOutcome>;
}
export type DeviceVerifiers = Partial<Record<DevicePlatform, DeviceVerifier>>;

/** contract.json#deviceCheck.binding: SHA-256("movera-sms-code|" + app + "|" + phone + "|" + installId). */
export function deviceBinding(app: string, phone: string, installId: string): Buffer {
  return createHash("sha256").update(`movera-sms-code|${app}|${phone}|${installId}`, "utf8").digest();
}

/** Play Integrity tokens are JWE compact text: base64url segments joined by dots. */
const B64URL_SEGMENT = /^[A-Za-z0-9_-]+$/;
const STRICT_B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * The canonical bytes of a token (review MUST 1): iPhone = the decoded attestation (strict base64 only, so one
 * attestation has one spelling); Android = the JWE text (its charset only). null = not a well-formed token.
 */
export function canonicalToken(input: DeviceCheckInput): Buffer | null {
  if (input.platform === "ios") {
    if (!STRICT_B64.test(input.token)) return null;
    const bytes = Buffer.from(input.token, "base64");
    return bytes.length > 0 && bytes.toString("base64") === input.token ? bytes : null;
  }
  // Follow-up 3: every segment must be canonical base64url (no padding, zero padding bits), so one token has one
  // spelling; the one-use hash covers the decoded segments.
  const parts: Buffer[] = [];
  const segments = input.token.split(".");
  // A Play Integrity token is a JWE in compact form: exactly 5 segments (header, key, iv, ciphertext, tag).
  if (segments.length !== 5) return null;
  for (const segment of segments) {
    if (!B64URL_SEGMENT.test(segment)) return null;
    const bytes = Buffer.from(segment, "base64url");
    if (bytes.toString("base64url") !== segment) return null;
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    parts.push(length, bytes);
  }
  return Buffer.concat(parts);
}

/** What otp_sessions keeps of a used token (SHA-256 of its canonical bytes), so the same token is never good twice. */
export function deviceTokenHash(input: DeviceCheckInput): string | null {
  const bytes = canonicalToken(input);
  return bytes === null ? null : createHash("sha256").update(input.platform).update("|").update(bytes).digest("hex");
}

/** Review MUST 2: at most this many checks at once per server copy; more fail at once (fail closed). */
export const MAX_CHECKS_IN_FLIGHT = 20;
/** Circuit breaker: after this many errors / time-outs in a row the checks fail at once for BREAKER_OPEN_MS. */
export const BREAKER_ERRORS = 5;
export const BREAKER_OPEN_MS = 30_000;
const state = { inFlight: 0, errorsInRow: 0, openUntil: 0 };
/** Tests only. */
export const resetDeviceCheckState = () => Object.assign(state, { inFlight: 0, errorsInRow: 0, openUntil: 0 });

/**
 * Runs one check with the contract's time-out (an AbortSignal the verifier passes to its HTTP calls, so a slow Google
 * call is really cut), a cap on checks in flight and a circuit breaker. A missing verifier, a throw, a time-out, a full
 * cap or an open breaker is a failed check.
 */
/** Follow-up 4: these failures are Movera's or Google's, not the caller's (never counted on the address ceiling). */
/** Failures of the call itself (Google or our own setup): they feed the circuit breaker. google_auth = Google refused OUR credentials (401 / 403). */
export const BREAKER_FAILURES: readonly string[] = ["timeout", "error", "google_429", "google_5xx", "google_auth"];
export const SERVICE_FAILURES: ReadonlySet<string> = new Set([...BREAKER_FAILURES, "busy", "breaker_open", "not_configured"]);

export async function runDeviceCheck(verifiers: DeviceVerifiers, input: DeviceCheckInput, binding: Buffer, now: () => number = Date.now, onBreakerOpen?: () => void): Promise<DeviceCheckOutcome> {
  const verifier = verifiers[input.platform];
  if (verifier === undefined) return { ok: false, why: "not_configured" };
  if (now() < state.openUntil) return { ok: false, why: "breaker_open" };
  if (state.inFlight >= MAX_CHECKS_IN_FLIGHT) return { ok: false, why: "busy" };
  state.inFlight++;
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<DeviceCheckOutcome>((resolve) => (timer = setTimeout(() => (controller.abort(), resolve({ ok: false, why: "timeout" })), DEVICE_CHECK.timeoutSeconds * 1000)));
  try {
    const outcome = await Promise.race([verifier.verify({ token: input.token, keyId: input.keyId, binding, signal: controller.signal }).catch(() => ({ ok: false, why: "error" }) as DeviceCheckOutcome), timeout]);
    const failedService = !outcome.ok && BREAKER_FAILURES.includes(outcome.why);
    state.errorsInRow = failedService ? state.errorsInRow + 1 : 0;
    if (state.errorsInRow >= BREAKER_ERRORS) {
      state.openUntil = now() + BREAKER_OPEN_MS;
      state.errorsInRow = 0;
      onBreakerOpen?.();
    }
    return outcome;
  } finally {
    clearTimeout(timer);
    state.inFlight--;
  }
}

/** Review SHOULD 5: failed checks per client address; at the ceiling an address gets no more Google calls for an hour. */
export const FAILED_CHECKS_PER_ADDRESS_PER_HOUR = 20;
const failures = new Map<string, number[]>();
export const resetFailedChecks = () => failures.clear();
export function failedChecksFrom(ip: string | undefined, now: number): number {
  if (ip === undefined) return 0;
  const list = (failures.get(ip) ?? []).filter((at) => at > now - 3_600_000);
  if (list.length === 0) failures.delete(ip);
  else failures.set(ip, list);
  return list.length;
}
export function noteFailedCheck(ip: string | undefined, now: number): void {
  if (ip === undefined) return;
  if (failures.size > 50_000) failures.clear();
  failures.set(ip, [...(failures.get(ip) ?? []), now]);
}

/* ------------------------------------------------------------------ Android: Play Integrity */

/** The decoded verdict as Google gives it (tokenPayloadExternal), only the parts read here. */
export type IntegrityPayload = {
  requestDetails?: { requestPackageName?: string; nonce?: string; timestampMillis?: string | number };
  appIntegrity?: { appRecognitionVerdict?: string };
  deviceIntegrity?: { deviceRecognitionVerdict?: string[] };
};

const unpad = (value: string) => value.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

/** contract.json#deviceCheck.check (Android): every condition must hold. */
export function judgeIntegrity(payload: IntegrityPayload, packages: readonly string[], binding: Buffer, now: Date): DeviceCheckOutcome {
  const req = payload.requestDetails ?? {};
  if (typeof req.requestPackageName !== "string" || !packages.includes(req.requestPackageName)) return { ok: false, why: "package" };
  if (typeof req.nonce !== "string" || unpad(req.nonce) !== binding.toString("base64url")) return { ok: false, why: "nonce" };
  const at = Number(req.timestampMillis);
  if (!Number.isFinite(at) || now.getTime() - at > DEVICE_CHECK.maxAgeSeconds * 1000 || at - now.getTime() > 60_000) return { ok: false, why: "age" };
  if (payload.appIntegrity?.appRecognitionVerdict !== "PLAY_RECOGNIZED") return { ok: false, why: "app_verdict" };
  if (!(payload.deviceIntegrity?.deviceRecognitionVerdict ?? []).includes("MEETS_DEVICE_INTEGRITY")) return { ok: false, why: "device_verdict" };
  return { ok: true };
}

export const PLAY_INTEGRITY_SCOPE = "https://www.googleapis.com/auth/playintegrity";

export function playIntegrityVerifier(options: { tokens: { get(): Promise<string> }; packages: readonly string[]; fetchFn: FetchLike; clock?: () => Date }): DeviceVerifier {
  return {
    async verify({ token, binding, signal }) {
      if (token.length > 16384) return { ok: false, why: "shape" };
      // The token says which package asked; Google decodes it under that package name. Ask under each allowed one only
      // if needed: the first allowed package whose decode works and passes decides.
      const access = await options.tokens.get();
      for (const pkg of options.packages) {
        const res = await options.fetchFn(`https://playintegrity.googleapis.com/v1/${encodeURIComponent(pkg)}:decodeIntegrityToken`, {
          method: "POST",
          headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
          body: JSON.stringify({ integrity_token: token }),
          ...(signal ? { signal } : {}),
        });
        const text = await res.text();
        // Review SHOULD 6: Google's own trouble is told apart from a token it refuses (log + breaker).
        if (res.status === 429) return { ok: false, why: "google_429" };
        if (res.status >= 500) return { ok: false, why: "google_5xx" };
        if (res.status === 401 || res.status === 403) return { ok: false, why: "google_auth" };
        if (res.status !== 200) continue;
        const payload = (JSON.parse(text) as { tokenPayloadExternal?: IntegrityPayload }).tokenPayloadExternal ?? {};
        return judgeIntegrity(payload, options.packages, binding, options.clock?.() ?? new Date());
      }
      return { ok: false, why: "decode" };
    },
  };
}

/* ------------------------------------------------------------------ iPhone: App Attest (inactive until the keys exist) */

type Cbor = number | string | Buffer | boolean | null | Cbor[] | Map<Cbor, Cbor>;

/** A small CBOR reader (RFC 8949: the major types App Attest uses; no tags, no floats, no indefinite lengths). */
export function decodeCbor(data: Buffer): Cbor {
  let pos = 0;
  const need = (n: number) => {
    if (pos + n > data.length) throw new Error("cbor: short");
  };
  const length = (info: number): number => {
    if (info < 24) return info;
    const size = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : 0;
    if (size === 0) throw new Error("cbor: length");
    need(size);
    const v = data.readUIntBE(pos, size);
    pos += size;
    return v;
  };
  const item = (depth: number): Cbor => {
    if (depth > 16) throw new Error("cbor: deep");
    need(1);
    const head = data[pos++]!;
    const major = head >> 5;
    const info = head & 31;
    if (major === 7) {
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22) return null;
      throw new Error("cbor: simple");
    }
    const n = length(info);
    switch (major) {
      case 0:
        return n;
      case 1:
        return -1 - n;
      case 2:
        need(n);
        return data.subarray(pos, (pos += n));
      case 3:
        need(n);
        return data.subarray(pos, (pos += n)).toString("utf8");
      case 4: {
        const out: Cbor[] = [];
        for (let k = 0; k < n; k++) out.push(item(depth + 1));
        return out;
      }
      case 5: {
        const out = new Map<Cbor, Cbor>();
        for (let k = 0; k < n; k++) {
          const key = item(depth + 1);
          out.set(key, item(depth + 1));
        }
        return out;
      }
      default:
        throw new Error("cbor: type");
    }
  };
  const value = item(0);
  if (pos !== data.length) throw new Error("cbor: trailing");
  return value;
}

const APP_ATTEST_OID = Buffer.from("06092a864886f763640802", "hex"); // OID 1.2.840.113635.100.8.2
const same = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);
const sha256 = (...parts: Buffer[]) => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
};

/** The 32-byte nonce in the leaf's App Attest extension (SEQUENCE { [1] { OCTET STRING nonce } }). */
function nonceOf(leaf: X509Certificate): Buffer | undefined {
  const raw = leaf.raw;
  const at = raw.indexOf(APP_ATTEST_OID);
  if (at < 0) return undefined;
  // After the OID: OCTET STRING (04 len) wrapping 30 24 a1 22 04 20 <32 bytes>.
  const tail = raw.subarray(at + APP_ATTEST_OID.length, at + APP_ATTEST_OID.length + 64);
  const marker = tail.indexOf(Buffer.from("a1220420", "hex"));
  if (marker < 0 || marker + 4 + 32 > tail.length) return undefined;
  return tail.subarray(marker + 4, marker + 36);
}

/** The leaf's EC public key as the uncompressed point (04 || X || Y), whose SHA-256 is the App Attest key id. */
function pointOf(leaf: X509Certificate): Buffer {
  const der = leaf.publicKey.export({ format: "der", type: "spki" });
  return der.subarray(der.length - 65);
}

export function appAttestVerifier(options: { appIds: readonly string[]; rootPem: string; production: boolean; clock?: () => Date }): DeviceVerifier {
  const root = new X509Certificate(options.rootPem);
  const rpHashes = options.appIds.map((id) => sha256(Buffer.from(id, "utf8")));
  const aaguids = [Buffer.from("appattest\0\0\0\0\0\0\0", "latin1"), ...(options.production ? [] : [Buffer.from("appattestdevelop", "latin1")])];
  return {
    async verify({ token, keyId, binding }) {
      if (keyId === undefined) return { ok: false, why: "key_id" };
      const kid = Buffer.from(keyId, "base64");
      if (kid.length !== 32) return { ok: false, why: "key_id" };
      let att: Cbor;
      try {
        att = decodeCbor(Buffer.from(token, "base64"));
      } catch {
        return { ok: false, why: "shape" };
      }
      if (!(att instanceof Map) || att.get("fmt") !== "apple-appattest") return { ok: false, why: "shape" };
      const stmt = att.get("attStmt");
      const authData = att.get("authData");
      const x5c = stmt instanceof Map ? stmt.get("x5c") : undefined;
      if (!Buffer.isBuffer(authData) || !Array.isArray(x5c) || x5c.length < 2 || !x5c.every(Buffer.isBuffer)) return { ok: false, why: "shape" };
      let leaf: X509Certificate;
      let middle: X509Certificate;
      try {
        leaf = new X509Certificate(x5c[0] as Buffer);
        middle = new X509Certificate(x5c[1] as Buffer);
      } catch {
        return { ok: false, why: "certificate" };
      }
      // 1. The chain: leaf ← intermediate ← the Apple root, each in its validity window.
      const now = (options.clock?.() ?? new Date()).getTime();
      const inTime = (c: X509Certificate) => Date.parse(c.validFrom) <= now && now <= Date.parse(c.validTo);
      if (!leaf.checkIssued(middle) || !leaf.verify(middle.publicKey) || !middle.checkIssued(root) || !middle.verify(root.publicKey) || ![leaf, middle, root].every(inTime)) return { ok: false, why: "chain" };
      // 2. The nonce: SHA-256(authData || clientDataHash), with clientDataHash = the binding.
      const nonce = nonceOf(leaf);
      if (nonce === undefined || !same(nonce, sha256(authData, binding))) return { ok: false, why: "nonce" };
      // 3. The key id is the hash of the leaf's public key.
      if (!same(sha256(pointOf(leaf)), kid)) return { ok: false, why: "key_id" };
      // 4. authData: rpIdHash (32) flags (1) counter (4) aaguid (16) credIdLen (2) credId.
      if (authData.length < 55) return { ok: false, why: "auth_data" };
      const rp = authData.subarray(0, 32);
      if (!rpHashes.some((h) => same(h, rp))) return { ok: false, why: "app_id" };
      if (authData.readUInt32BE(33) !== 0) return { ok: false, why: "counter" };
      const aaguid = authData.subarray(37, 53);
      if (!aaguids.some((a) => same(a, aaguid))) return { ok: false, why: "aaguid" };
      const idLen = authData.readUInt16BE(53);
      if (authData.length < 55 + idLen || !same(authData.subarray(55, 55 + idLen), kid)) return { ok: false, why: "credential" };
      return { ok: true };
    },
  };
}

/* ------------------------------------------------------------------ from the environment */

type DeviceEnv = Pick<Env, "PLAY_INTEGRITY_SERVICE_ACCOUNT" | "PLAY_INTEGRITY_PACKAGES" | "APPLE_APP_ATTEST_APP_IDS" | "APPLE_APP_ATTEST_ROOT_CA" | "MOVERA_ENV">;
const list = (value: string | undefined) => (value ?? "").split(",").map((v) => v.trim()).filter((v) => v.length > 0);

/**
 * The verifiers the server's keys allow (contract.json#deviceCheck.serverKeys), and start-up warnings that name only
 * what is missing. A platform without its keys has no verifier: its check fails.
 */
export function deviceVerifiersFrom(env: DeviceEnv, fetchFn: FetchLike = fetch as unknown as FetchLike): { verifiers: DeviceVerifiers; warnings: string[] } {
  const verifiers: DeviceVerifiers = {};
  const warnings: string[] = [];
  const account = parseServiceAccount(env.PLAY_INTEGRITY_SERVICE_ACCOUNT);
  const packages = list(env.PLAY_INTEGRITY_PACKAGES);
  if (account.account && packages.length > 0) {
    const tokens = new GoogleAccessTokens(account.account, fetchFn, undefined, [PLAY_INTEGRITY_SCOPE]);
    verifiers.android = playIntegrityVerifier({ tokens, packages, fetchFn });
  } else if (env.PLAY_INTEGRITY_SERVICE_ACCOUNT !== undefined || packages.length > 0) {
    warnings.push(`Play Integrity is off: PLAY_INTEGRITY_SERVICE_ACCOUNT ${account.problem ?? "ok"}, PLAY_INTEGRITY_PACKAGES ${packages.length > 0 ? "ok" : "not_set"}`);
  }
  const appIds = list(env.APPLE_APP_ATTEST_APP_IDS);
  if (appIds.length > 0 && env.APPLE_APP_ATTEST_ROOT_CA) {
    try {
      verifiers.ios = appAttestVerifier({ appIds, rootPem: env.APPLE_APP_ATTEST_ROOT_CA.replace(/\\n/g, "\n"), production: env.MOVERA_ENV === "production" });
    } catch {
      warnings.push("App Attest is off: APPLE_APP_ATTEST_ROOT_CA is not a certificate");
    }
  } else if (appIds.length > 0 || env.APPLE_APP_ATTEST_ROOT_CA) {
    warnings.push(`App Attest is off: APPLE_APP_ATTEST_APP_IDS ${appIds.length > 0 ? "ok" : "not_set"}, APPLE_APP_ATTEST_ROOT_CA ${env.APPLE_APP_ATTEST_ROOT_CA ? "ok" : "not_set"}`);
  }
  return { verifiers, warnings };
}
