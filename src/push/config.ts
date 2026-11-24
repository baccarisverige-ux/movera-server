import type { Env } from "../env.js";
import { FcmSender, GoogleAccessTokens, parseServiceAccount, type FetchLike, type PushSender, type ServiceAccount } from "./fcm.js";

/**
 * GET /push/config (contract v0.18.3, contract.json#auth.devices.config): the Firebase web app's public settings,
 * read once from the Firebase Management API with the service account and kept in memory, so the apps keep no key
 * in their code. A failed read is tried again after FAILURE_RETRY_MS.
 *
 * v0.18.105 (BQ-V43, G4 decision 1, owner R7): `?platform=android` gives the Android Firebase app's public settings
 * instead (androidConfig), read the same way from the app's google-services.json by its package name, so the driver's
 * Android store build starts Firebase at run time and no google-services.json is kept in any repository.
 *
 * v0.18.160 (owner 2026-11-24 "Notifications doesn't work on iPhones?", contract.json#auth.devices.config.ios): the APNs
 * key is in Firebase now, so `?platform=ios` gives the iOS Firebase app's public settings (iosConfig), read the same way
 * from the app's GoogleService-Info.plist by its bundle id. No plist and no key is kept in any repository.
 */

export type PushApp = "driver" | "rider";
export const WEB_APP_NAMES: Record<PushApp, string> = { driver: "Movera Driver web", rider: "Movera Rider web" };
export const ANDROID_PACKAGES: Record<PushApp, string> = { driver: "se.movera.driver", rider: "com.movera.rider" };
/** v0.18.160: contract.json#auth.devices.config.ios.iosBundleIds. */
export const IOS_BUNDLE_IDS: Record<PushApp, string> = { driver: "se.movera.driver", rider: "com.movera.rider" };
export type PushPlatform = "web" | "android" | "ios";
export type WebConfig = { apiKey: string; appId: string; messagingSenderId: string; projectId: string; authDomain?: string };
export type AndroidConfig = { apiKey: string; appId: string; messagingSenderId: string; projectId: string };
export type IosConfig = { apiKey: string; appId: string; messagingSenderId: string; projectId: string; iosBundleId: string };
export type PushConfig = { provider: "fcm"; enabled: boolean; projectId?: string; webConfig?: WebConfig; androidConfig?: AndroidConfig; iosConfig?: IosConfig };

const FAILURE_RETRY_MS = 5 * 60 * 1000;
const OFF: PushConfig = { provider: "fcm", enabled: false };

export interface PushConfigSource {
  /** platform web (the default) gives webConfig, android gives androidConfig, ios gives iosConfig (v0.18.160). */
  get(app: PushApp, platform?: PushPlatform): Promise<PushConfig>;
}

type CacheKey = `${PushApp}:${PushPlatform}`;

export class FirebaseWebConfig implements PushConfigSource {
  private readonly cache = new Map<CacheKey, PushConfig>();
  private readonly failedAt = new Map<CacheKey, number>();
  private readonly pending = new Map<CacheKey, Promise<PushConfig>>();

  constructor(
    private readonly account: ServiceAccount,
    private readonly tokens: GoogleAccessTokens,
    private readonly fetchFn: FetchLike,
    private readonly options: { clock?: () => Date; baseUrl?: string; warn?: (message: string) => void } = {},
  ) {}

  async get(app: PushApp, platform: PushPlatform = "web"): Promise<PushConfig> {
    const key: CacheKey = `${app}:${platform}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const now = (this.options.clock?.() ?? new Date()).getTime();
    const failed = this.failedAt.get(key);
    if (failed !== undefined && now - failed < FAILURE_RETRY_MS) return OFF;
    let pending = this.pending.get(key);
    if (!pending) {
      pending = this.loadOnce(app, platform).finally(() => this.pending.delete(key));
      this.pending.set(key, pending);
    }
    return pending;
  }

  private async loadOnce(app: PushApp, platform: PushPlatform): Promise<PushConfig> {
    const key: CacheKey = `${app}:${platform}`;
    try {
      const config = platform === "android" ? await this.loadAndroid(app) : platform === "ios" ? await this.loadIos(app) : await this.load(app);
      this.cache.set(key, config);
      this.failedAt.delete(key);
      return config;
    } catch (error) {
      this.failedAt.set(key, (this.options.clock?.() ?? new Date()).getTime());
      this.options.warn?.(`push config for ${app} (${platform}) not available: ${(error as Error).message}`);
      return OFF;
    }
  }

  private base(): string {
    return `${this.options.baseUrl ?? "https://firebase.googleapis.com"}/v1beta1/projects/${encodeURIComponent(this.account.projectId)}`;
  }

  /**
   * v0.18.105: the Android app with the app's package name, then its google-services.json (base64 in
   * configFileContents): project_info.project_number is the sender id, the client of that package gives
   * mobilesdk_app_id and its current api key. Public settings (they are inside every APK); never a secret.
   */
  private async loadAndroid(app: PushApp): Promise<PushConfig> {
    const base = this.base();
    const headers = { authorization: `Bearer ${await this.tokens.get()}` };
    const pkg = ANDROID_PACKAGES[app];
    const list = await this.fetchFn(`${base}/androidApps?pageSize=100`, { method: "GET", headers });
    if (list.status !== 200) throw new Error(`androidApps list answered ${list.status}`);
    const apps = ((JSON.parse(await list.text()) as { apps?: { appId?: string; packageName?: string; state?: string }[] }).apps ?? []).filter((a) => a.state !== "DELETED");
    const found = apps.find((a) => a.packageName === pkg);
    if (!found?.appId) throw new Error(`no Firebase Android app with package "${pkg}"`);
    const res = await this.fetchFn(`${base}/androidApps/${encodeURIComponent(found.appId)}/config`, { method: "GET", headers });
    if (res.status !== 200) throw new Error(`androidApps config answered ${res.status}`);
    const file = (JSON.parse(await res.text()) as { configFileContents?: string }).configFileContents;
    if (!file) throw new Error("the Android app config has no configFileContents");
    type Client = { client_info?: { mobilesdk_app_id?: string; android_client_info?: { package_name?: string } }; api_key?: { current_key?: string }[] };
    const json = JSON.parse(Buffer.from(file, "base64").toString("utf8")) as { project_info?: { project_number?: string; project_id?: string }; client?: Client[] };
    const client = (json.client ?? []).find((c) => c.client_info?.android_client_info?.package_name === pkg);
    const appId = client?.client_info?.mobilesdk_app_id;
    const apiKey = client?.api_key?.find((k) => k.current_key)?.current_key;
    const sender = json.project_info?.project_number;
    if (!appId || !apiKey || !sender) throw new Error("the Android app config has no app id / api key / project number");
    const projectId = json.project_info?.project_id ?? this.account.projectId;
    return { provider: "fcm", enabled: true, projectId, androidConfig: { apiKey, appId, messagingSenderId: sender, projectId } };
  }

  /**
   * v0.18.160: the iOS app with the app's bundle id, then its GoogleService-Info.plist (base64 in configFileContents):
   * GOOGLE_APP_ID, API_KEY, GCM_SENDER_ID, PROJECT_ID. Public settings (they are inside every IPA); never a secret.
   * The app id must name an iOS app: native Firebase on an iPhone aborts the app for any other one.
   */
  private async loadIos(app: PushApp): Promise<PushConfig> {
    const base = this.base();
    const headers = { authorization: `Bearer ${await this.tokens.get()}` };
    const bundle = IOS_BUNDLE_IDS[app];
    const list = await this.fetchFn(`${base}/iosApps?pageSize=100`, { method: "GET", headers });
    if (list.status !== 200) throw new Error(`iosApps list answered ${list.status}`);
    const apps = ((JSON.parse(await list.text()) as { apps?: { appId?: string; bundleId?: string; state?: string }[] }).apps ?? []).filter((a) => a.state !== "DELETED");
    const found = apps.find((a) => a.bundleId === bundle);
    if (!found?.appId) throw new Error(`no Firebase iOS app with bundle id "${bundle}"`);
    const res = await this.fetchFn(`${base}/iosApps/${encodeURIComponent(found.appId)}/config`, { method: "GET", headers });
    if (res.status !== 200) throw new Error(`iosApps config answered ${res.status}`);
    const file = (JSON.parse(await res.text()) as { configFileContents?: string }).configFileContents;
    if (!file) throw new Error("the iOS app config has no configFileContents");
    const plist = plistStrings(Buffer.from(file, "base64").toString("utf8"));
    const appId = plist.GOOGLE_APP_ID;
    const apiKey = plist.API_KEY;
    const sender = plist.GCM_SENDER_ID;
    if (!appId || !apiKey || !sender) throw new Error("the iOS app config has no app id / api key / sender id");
    if (!appId.includes(":ios:")) throw new Error("the iOS app config has an app id of another platform");
    if (plist.BUNDLE_ID && plist.BUNDLE_ID !== bundle) throw new Error("the iOS app config is for another bundle id");
    const projectId = plist.PROJECT_ID ?? this.account.projectId;
    return { provider: "fcm", enabled: true, projectId, iosConfig: { apiKey, appId, messagingSenderId: sender, projectId, iosBundleId: bundle } };
  }

  private async load(app: PushApp): Promise<PushConfig> {
    const base = this.base();
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
    return {
      provider: "fcm",
      enabled: true,
      projectId: c.projectId ?? this.account.projectId,
      webConfig: { apiKey: c.apiKey, appId: c.appId, messagingSenderId: c.messagingSenderId, projectId: c.projectId ?? this.account.projectId, ...(c.authDomain ? { authDomain: c.authDomain } : {}) },
    };
  }
}

/** v0.18.160: the `<key>K</key><string>V</string>` pairs of a GoogleService-Info.plist (XML entities decoded). */
export function plistStrings(xml: string): Record<string, string> {
  const out: Record<string, string> = {};
  const decode = (v: string) => v.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  for (const m of xml.matchAll(/<key>\s*([^<]+?)\s*<\/key>\s*<string>([^<]*)<\/string>/g)) out[m[1]!] = decode(m[2]!.trim());
  return out;
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
