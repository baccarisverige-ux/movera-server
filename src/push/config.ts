import type { Env } from "../env.js";
import { FcmSender, GoogleAccessTokens, parseServiceAccount, type FetchLike, type PushSender, type ServiceAccount } from "./fcm.js";

/**
 * GET /push/config (contract v0.18.3, contract.json#auth.devices.config): the Firebase web app's public settings,
 * read once from the Firebase Management API with the service account and kept in memory, so the apps keep no key
 * in their code. A failed read is tried again after FAILURE_RETRY_MS.
 */

export type PushApp = "driver" | "rider";
export const WEB_APP_NAMES: Record<PushApp, string> = { driver: "Movera Driver web", rider: "Movera Rider web" };
export type WebConfig = { apiKey: string; appId: string; messagingSenderId: string; projectId: string; authDomain?: string };
export type PushConfig = { provider: "fcm"; enabled: boolean; projectId?: string; webConfig?: WebConfig };

const FAILURE_RETRY_MS = 5 * 60 * 1000;
const OFF: PushConfig = { provider: "fcm", enabled: false };

export interface PushConfigSource {
  get(app: PushApp): Promise<PushConfig>;
}

export class FirebaseWebConfig implements PushConfigSource {
  private readonly cache = new Map<PushApp, PushConfig>();
  private readonly failedAt = new Map<PushApp, number>();
  private readonly pending = new Map<PushApp, Promise<PushConfig>>();

  constructor(
    private readonly account: ServiceAccount,
    private readonly tokens: GoogleAccessTokens,
    private readonly fetchFn: FetchLike,
    private readonly options: { clock?: () => Date; baseUrl?: string; warn?: (message: string) => void } = {},
  ) {}

  async get(app: PushApp): Promise<PushConfig> {
    const hit = this.cache.get(app);
    if (hit) return hit;
    const now = (this.options.clock?.() ?? new Date()).getTime();
    const failed = this.failedAt.get(app);
    if (failed !== undefined && now - failed < FAILURE_RETRY_MS) return OFF;
    let pending = this.pending.get(app);
    if (!pending) {
      pending = this.load(app).finally(() => this.pending.delete(app));
      this.pending.set(app, pending);
    }
    return pending;
  }

  private async load(app: PushApp): Promise<PushConfig> {
    const base = `${this.options.baseUrl ?? "https://firebase.googleapis.com"}/v1beta1/projects/${encodeURIComponent(this.account.projectId)}`;
    try {
      const headers = { authorization: `Bearer ${await this.tokens.get()}` };
      const list = await this.fetchFn(`${base}/webApps?pageSize=100`, { method: "GET", headers });
      if (list.status !== 200) throw new Error(`webApps list answered ${list.status}`);
      const apps = ((JSON.parse(await list.text()) as { apps?: { appId?: string; displayName?: string; state?: string }[] }).apps ?? []).filter((a) => a.state !== "DELETED");
      const found = apps.find((a) => a.displayName === WEB_APP_NAMES[app]);
      if (!found?.appId) throw new Error(`no Firebase web app named "${WEB_APP_NAMES[app]}"`);
      const res = await this.fetchFn(`${base}/webApps/${encodeURIComponent(found.appId)}/config`, { method: "GET", headers });
      if (res.status !== 200) throw new Error(`webApps config answered ${res.status}`);
      const c = JSON.parse(await res.text()) as Partial<WebConfig>;
      if (!c.apiKey || !c.appId || !c.messagingSenderId) throw new Error("the web app config has no apiKey / appId / messagingSenderId");
      const config: PushConfig = {
        provider: "fcm",
        enabled: true,
        projectId: c.projectId ?? this.account.projectId,
        webConfig: { apiKey: c.apiKey, appId: c.appId, messagingSenderId: c.messagingSenderId, projectId: c.projectId ?? this.account.projectId, ...(c.authDomain ? { authDomain: c.authDomain } : {}) },
      };
      this.cache.set(app, config);
      this.failedAt.delete(app);
      return config;
    } catch (error) {
      this.failedAt.set(app, (this.options.clock?.() ?? new Date()).getTime());
      this.options.warn?.(`push config for ${app} not available: ${(error as Error).message}`);
      return OFF;
    }
  }
}

export class NoPushConfig implements PushConfigSource {
  async get(): Promise<PushConfig> {
    return OFF;
  }
}

export type PushServices = { status: "on" | "off" | "invalid"; problem?: string; sender?: PushSender; config: PushConfigSource };

/** From FIREBASE_SERVICE_ACCOUNT: on, off (not set) or invalid (set but unusable; sending stays off). Never throws. */
export function pushServicesFrom(env: Pick<Env, "FIREBASE_SERVICE_ACCOUNT">, options: { fetch?: FetchLike; clock?: () => Date; warn?: (message: string) => void } = {}): PushServices {
  const parsed = parseServiceAccount(env.FIREBASE_SERVICE_ACCOUNT);
  if (!parsed.account) return { status: parsed.problem === "not_set" ? "off" : "invalid", problem: parsed.problem!, config: new NoPushConfig() };
  const fetchFn = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const tokens = new GoogleAccessTokens(parsed.account, fetchFn, options.clock);
  return {
    status: "on",
    sender: new FcmSender(parsed.account, tokens, fetchFn),
    config: new FirebaseWebConfig(parsed.account, tokens, fetchFn, { ...(options.clock ? { clock: options.clock } : {}), ...(options.warn ? { warn: options.warn } : {}) }),
  };
}
