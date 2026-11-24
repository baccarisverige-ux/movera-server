import { contract } from "../contract/contract.js";
import { createSign } from "node:crypto";

/**
 * Firebase Cloud Messaging HTTP v1 (contract v0.18.3 §28, owner decision R7). The server signs in to Google with the
 * service account in FIREBASE_SERVICE_ACCOUNT (OAuth2 JWT bearer grant, RS256 with node:crypto, no extra package) and
 * sends one message per device token. The service account JSON is never logged: errors name what is wrong, not the value.
 */

export type ServiceAccount = { projectId: string; clientEmail: string; privateKey: string; tokenUri: string };

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; text: () => Promise<string> }>;

export const SCOPES = ["https://www.googleapis.com/auth/firebase.messaging", "https://www.googleapis.com/auth/firebase.readonly"];

/** The parsed account, or why it cannot be used (never the value itself). */
export function parseServiceAccount(raw: string | undefined): { account?: ServiceAccount; problem?: string } {
  if (raw === undefined || raw.trim() === "") return { problem: "not_set" };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { problem: "not_json" };
  }
  const o = json as Record<string, unknown>;
  const str = (k: string) => (typeof o[k] === "string" && (o[k] as string).length > 0 ? (o[k] as string) : undefined);
  const projectId = str("project_id");
  const clientEmail = str("client_email");
  const privateKey = str("private_key");
  if (!projectId || !clientEmail || !privateKey) return { problem: "missing_fields" };
  return { account: { projectId, clientEmail, privateKey: privateKey.replace(/\\n/g, "\n"), tokenUri: str("token_uri") ?? "https://oauth2.googleapis.com/token" } };
}

const b64url = (value: string | Buffer) => Buffer.from(value).toString("base64url");

/** A signed JWT assertion for Google's token endpoint. */
export function signAssertion(account: ServiceAccount, scopes: string[], now: Date): string {
  const iat = Math.floor(now.getTime() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: account.clientEmail, scope: scopes.join(" "), aud: account.tokenUri, iat, exp: iat + 3600 }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${b64url(signer.sign(account.privateKey))}`;
}

/** OAuth2 access tokens for the service account, kept until a minute before they expire. */
export class GoogleAccessTokens {
  private cached: { token: string; until: number } | undefined;
  private pending: Promise<string> | undefined;

  constructor(
    private readonly account: ServiceAccount,
    private readonly fetchFn: FetchLike,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async get(): Promise<string> {
    const now = this.clock().getTime();
    if (this.cached && this.cached.until > now) return this.cached.token;
    this.pending ??= this.fetchToken().finally(() => (this.pending = undefined));
    return this.pending;
  }

  invalidate(): void {
    this.cached = undefined;
  }

  private async fetchToken(): Promise<string> {
    const now = this.clock();
    const body = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: signAssertion(this.account, SCOPES, now) }).toString();
    const res = await this.fetchFn(this.account.tokenUri, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    const text = await res.text();
    if (res.status !== 200) throw new Error(`Google token endpoint answered ${res.status}`);
    const json = JSON.parse(text) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new Error("Google token endpoint gave no access_token");
    this.cached = { token: json.access_token, until: now.getTime() + Math.max(60, (json.expires_in ?? 3600) - 60) * 1000 };
    return json.access_token;
  }
}

export type PushMessage = {
  token: string;
  platform: "ios" | "android" | "web";
  title: string;
  body: string;
  data: Record<string, string>;
  /** v0.18.6 (contract.json#driverOffers.push): offer = the Movera offer sound + vibration; none = quiet (Radar). */
  sound?: "offer" | "none";
  /** v0.18.6: seconds the push is still useful (until the offer runs out). */
  ttlSeconds?: number;
};

const NATIVE = (contract as unknown as { driverOffers: { push: { native: { androidChannel: string; androidQuietChannel: string; soundFile: string; iosSound: string } } } }).driverOffers.push.native;
/**
 * v0.18.160 (contract.json#auth.devices.sending.apns): what an iPhone needs to show the push as an Android phone does.
 * An alert push at priority 10 (Android is always HIGH), the notice's title + body, grouped by kind. Never a badge and
 * never content-available (no silent background push); Android has no collapse key, so no apns-collapse-id either.
 */
const APNS_HEADERS = { "apns-push-type": "alert", "apns-priority": "10" } as const;
function aps(message: PushMessage): { alert: { title: string; body: string }; "thread-id"?: string } {
  const kind = message.data.kind;
  return { alert: { title: message.title, body: message.body }, ...(kind ? { "thread-id": kind } : {}) };
}

/** sent; dead_token: FCM says the token is gone (remove it); retry: try again later; failed: give up on this one. */
export type SendResult = "sent" | "dead_token" | "retry" | "failed";

export interface PushSender {
  send(message: PushMessage): Promise<SendResult>;
}

export class FcmSender implements PushSender {
  constructor(
    private readonly account: ServiceAccount,
    private readonly tokens: GoogleAccessTokens,
    private readonly fetchFn: FetchLike,
    private readonly baseUrl = "https://fcm.googleapis.com",
  ) {}

  /** The FCM v1 message. Web gets data only (the service worker shows it and opens deepLink on tap). */
  static body(message: PushMessage) {
    const data = { ...message.data, title: message.title, body: message.body };
    const ttl = message.ttlSeconds;
    if (message.platform === "web") return { message: { token: message.token, data, webpush: { headers: { Urgency: "high", ...(ttl ? { TTL: String(ttl) } : {}) } } } };
    if (message.sound !== undefined) {
      // v0.18.6 (G4 decision 1, E6): a new offer. Sound + vibration (Exclusive / assigned) or quiet (Radar).
      const loud = message.sound === "offer";
      return {
        message: {
          token: message.token,
          notification: { title: message.title, body: message.body },
          data,
          android: {
            priority: "HIGH",
            ...(ttl ? { ttl: `${ttl}s` } : {}),
            notification: {
              click_action: "FLUTTER_NOTIFICATION_CLICK",
              channel_id: loud ? NATIVE.androidChannel : NATIVE.androidQuietChannel,
              ...(loud ? { sound: NATIVE.soundFile, default_vibrate_timings: true } : {}),
            },
          },
          apns: {
            headers: { ...APNS_HEADERS, ...(ttl ? { "apns-expiration": String(Math.floor(Date.now() / 1000) + ttl) } : {}) },
            payload: { aps: { ...aps(message), ...(loud ? { sound: NATIVE.iosSound, "interruption-level": "time-sensitive" } : {}) } },
          },
        },
      };
    }
    return {
      message: {
        token: message.token,
        notification: { title: message.title, body: message.body },
        data,
        android: { priority: "HIGH", notification: { click_action: "FLUTTER_NOTIFICATION_CLICK" } },
        apns: { headers: { ...APNS_HEADERS }, payload: { aps: { ...aps(message), sound: "default" } } },
      },
    };
  }

  async send(message: PushMessage): Promise<SendResult> {
    let access: string;
    try {
      access = await this.tokens.get();
    } catch {
      return "retry";
    }
    let res: { status: number; text: () => Promise<string> };
    try {
      res = await this.fetchFn(`${this.baseUrl}/v1/projects/${encodeURIComponent(this.account.projectId)}/messages:send`, {
        method: "POST",
        headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
        body: JSON.stringify(FcmSender.body(message)),
      });
    } catch {
      return "retry";
    }
    if (res.status === 200) return "sent";
    const text = await res.text().catch(() => "");
    return classifyFcmError(res.status, text, () => this.tokens.invalidate());
  }
}

/** FCM v1 error → what to do. UNREGISTERED (404) and an invalid registration token (400) remove the token. */
export function classifyFcmError(status: number, text: string, onAuthError: () => void = () => {}): SendResult {
  let code = "";
  let message = "";
  try {
    const error = (JSON.parse(text) as { error?: { status?: string; message?: string; details?: { errorCode?: string }[] } }).error;
    code = error?.details?.find((d) => d.errorCode)?.errorCode ?? error?.status ?? "";
    message = error?.message ?? "";
  } catch {
    // not JSON
  }
  if (status === 404 || code === "UNREGISTERED") return "dead_token";
  if (status === 400 && (code === "INVALID_ARGUMENT" || code === "INVALID_REGISTRATION") && /registration token|token/i.test(message)) return "dead_token";
  if (status === 401) {
    onAuthError();
    return "retry";
  }
  if (status === 429 || status >= 500) return "retry";
  return "failed";
}
