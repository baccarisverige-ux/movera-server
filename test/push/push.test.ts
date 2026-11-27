import { createVerify, generateKeyPairSync } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { readEnv } from "../../src/env.js";
import { notify, onNotify } from "../../src/notifications/service.js";
import { pushServicesFrom } from "../../src/push/config.js";
import { classifyFcmError, FcmSender, GoogleAccessTokens, parseServiceAccount, signAssertion, type FetchLike, type PushMessage, type PushSender, type SendResult } from "../../src/push/fcm.js";
import { PushDispatcher, subjectHash } from "../../src/push/dispatcher.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";

/** Contract v0.18.3 §28 (owner decision R7): push through FCM HTTP v1, with a fake Google and a fake clock. */

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const ACCOUNT_JSON = JSON.stringify({ type: "service_account", project_id: "movera-test", client_email: "push@movera-test.iam.example", private_key: privateKey, token_uri: "https://oauth.example/token" });
const SECRET = "test-secret-".padEnd(48, "x");
const clock = { now: new Date("2026-10-30T10:00:00Z") };

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };

/** A fake of Google's token endpoint, FCM and the Firebase Management API. */
function fakeGoogle(fcm: (body: { message: { token: string } }) => { status: number; body?: unknown } = () => ({ status: 200, body: { name: "projects/movera-test/messages/1" } })) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, ...init });
    const reply = (status: number, body: unknown) => ({ status, text: async () => JSON.stringify(body) });
    if (url === "https://oauth.example/token") return reply(200, { access_token: "access-1", expires_in: 3600 });
    if (url.endsWith("/messages:send")) {
      const r = fcm(JSON.parse(init.body!) as { message: { token: string } });
      return reply(r.status, r.body ?? {});
    }
    if (url.includes("/webApps?")) return reply(200, { apps: [{ appId: "1:42:web:driver", displayName: "Movera Driver web" }, { appId: "1:42:web:rider", displayName: "Movera Rider web" }] });
    if (url.endsWith("/webApps/1%3A42%3Aweb%3Adriver/config")) return reply(200, { projectId: "movera-test", appId: "1:42:web:driver", apiKey: "public-web-key", messagingSenderId: "42", authDomain: "movera-test.firebaseapp.com" });
    // v0.18.105 (BQ-V43): the Android apps (rider's has no config file here) and the driver's google-services.json.
    if (url.includes("/androidApps?")) return reply(200, { apps: [{ appId: "1:42:android:old", packageName: "se.movera.driver", state: "DELETED" }, { appId: "1:42:android:driver", packageName: "se.movera.driver", state: "ACTIVE" }, { appId: "1:42:android:rider", packageName: "com.movera.rider" }] });
    if (url.endsWith("/androidApps/1%3A42%3Aandroid%3Adriver/config")) {
      const file = { project_info: { project_number: "42", project_id: "movera-test" }, client: [{ client_info: { mobilesdk_app_id: "1:42:android:other", android_client_info: { package_name: "se.movera.other" } }, api_key: [{ current_key: "other-key" }] }, { client_info: { mobilesdk_app_id: "1:42:android:driver", android_client_info: { package_name: "se.movera.driver" } }, api_key: [{ current_key: "public-android-key" }] }] };
      return reply(200, { configFilename: "google-services.json", configFileContents: Buffer.from(JSON.stringify(file)).toString("base64") });
    }
    // v0.18.156: the iOS apps (rider's config has a web app id, never used) and the driver's GoogleService-Info.plist.
    if (url.includes("/iosApps?")) return reply(200, { apps: [{ appId: "1:42:ios:old", bundleId: "se.movera.driver", state: "DELETED" }, { appId: "1:42:ios:driver", bundleId: "se.movera.driver", state: "ACTIVE" }, { appId: "1:42:ios:rider", bundleId: "com.movera.rider" }] });
    if (url.endsWith("/iosApps/1%3A42%3Aios%3Adriver/config")) {
      const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n\t<key>API_KEY</key>\n\t<string>public-ios-key</string>\n\t<key>GCM_SENDER_ID</key>\n\t<string>42</string>\n\t<key>PLIST_VERSION</key>\n\t<string>1</string>\n\t<key>BUNDLE_ID</key>\n\t<string>se.movera.driver</string>\n\t<key>PROJECT_ID</key>\n\t<string>movera-test</string>\n\t<key>IS_GCM_ENABLED</key>\n\t<true></true>\n\t<key>GOOGLE_APP_ID</key>\n\t<string>1:42:ios:driver</string>\n</dict>\n</plist>\n`;
      return reply(200, { configFilename: "GoogleService-Info.plist", configFileContents: Buffer.from(plist).toString("base64") });
    }
    if (url.endsWith("/iosApps/1%3A42%3Aios%3Arider/config")) {
      const plist = `<plist><dict><key>API_KEY</key><string>k</string><key>GCM_SENDER_ID</key><string>42</string><key>GOOGLE_APP_ID</key><string>1:42:web:rider</string></dict></plist>`;
      return reply(200, { configFileContents: Buffer.from(plist).toString("base64") });
    }
    return reply(404, {});
  };
  return { calls, fetch };
}

describe("FCM sender (unit)", () => {
  it("reads the service account and says what is wrong without its value", () => {
    expect(parseServiceAccount(undefined)).toEqual({ problem: "not_set" });
    expect(parseServiceAccount("{oops")).toEqual({ problem: "not_json" });
    expect(parseServiceAccount(JSON.stringify({ project_id: "p" }))).toEqual({ problem: "missing_fields" });
    expect(parseServiceAccount(ACCOUNT_JSON).account).toMatchObject({ projectId: "movera-test", clientEmail: "push@movera-test.iam.example", tokenUri: "https://oauth.example/token" });
  });

  it("signs an RS256 JWT for Google's token endpoint", () => {
    const account = parseServiceAccount(ACCOUNT_JSON).account!;
    const jwt = signAssertion(account, ["scope-a", "scope-b"], clock.now);
    const [h, c, s] = jwt.split(".") as [string, string, string];
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = JSON.parse(Buffer.from(c, "base64url").toString());
    expect(claims).toEqual({ iss: account.clientEmail, scope: "scope-a scope-b", aud: account.tokenUri, iat: 1793354400, exp: 1793358000 });
    expect(createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, Buffer.from(s, "base64url"))).toBe(true);
  });

  it("gets one access token and keeps it until a minute before it expires", async () => {
    const google = fakeGoogle();
    const t = { now: new Date(clock.now) };
    const tokens = new GoogleAccessTokens(parseServiceAccount(ACCOUNT_JSON).account!, google.fetch, () => t.now);
    expect(await Promise.all([tokens.get(), tokens.get()])).toEqual(["access-1", "access-1"]);
    t.now = new Date(t.now.getTime() + 3000 * 1000);
    await tokens.get();
    expect(google.calls.filter((c) => c.url.endsWith("/token"))).toHaveLength(1);
    t.now = new Date(t.now.getTime() + 600 * 1000);
    await tokens.get();
    expect(google.calls.filter((c) => c.url.endsWith("/token"))).toHaveLength(2);
    const form = new URLSearchParams(google.calls[0]!.body);
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
  });

  it("sends an FCM v1 message: notification + data on phones, data only on the web", async () => {
    const google = fakeGoogle();
    const account = parseServiceAccount(ACCOUNT_JSON).account!;
    const sender = new FcmSender(account, new GoogleAccessTokens(account, google.fetch, () => clock.now), google.fetch, "https://fcm.example");
    const data = { notificationId: "ntf_1", kind: "document_expiring", deepLink: "movera-driver://documents/license" };
    expect(await sender.send({ token: "tok-a", platform: "android", title: "T", body: "B", data })).toBe("sent");
    const send = google.calls.find((c) => c.url === "https://fcm.example/v1/projects/movera-test/messages:send")!;
    expect(send.headers.authorization).toBe("Bearer access-1");
    expect(JSON.parse(send.body!).message).toMatchObject({ token: "tok-a", notification: { title: "T", body: "B" }, data: { ...data, title: "T", body: "B" } });
    expect(FcmSender.body({ token: "w", platform: "web", title: "T", body: "B", data }).message).not.toHaveProperty("notification");
  });

  it("v0.18.156: a phone message carries the apns block an iPhone needs (alert, priority 10, thread by kind, no badge)", () => {
    const data = { notificationId: "ntf_1", kind: "driver_found", deepLink: "movera://trips/t1" };
    const plain = FcmSender.body({ token: "i", platform: "ios", title: "T", body: "B", data }).message as unknown as { apns: { headers: Record<string, string>; payload: { aps: Record<string, unknown> } }; data: Record<string, string> };
    expect(plain.apns.headers).toEqual({ "apns-push-type": "alert", "apns-priority": "10" });
    expect(plain.apns.payload.aps).toEqual({ alert: { title: "T", body: "B" }, "thread-id": "driver_found", sound: "default" });
    expect(plain.data).toEqual({ ...data, title: "T", body: "B" });
    const offer = { notificationId: "off_1", kind: "new_offer", deepLink: "movera-driver://offers/off_1" };
    const loud = FcmSender.body({ token: "i", platform: "ios", title: "New ride", body: "2 min", data: offer, sound: "offer", ttlSeconds: 20 }).message as unknown as typeof plain;
    expect(loud.apns.headers["apns-priority"]).toBe("10");
    expect(loud.apns.headers["apns-push-type"]).toBe("alert");
    expect(Number(loud.apns.headers["apns-expiration"])).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(loud.apns.payload.aps).toEqual({ alert: { title: "New ride", body: "2 min" }, "thread-id": "new_offer", sound: "movera_offer.caf", "interruption-level": "time-sensitive" });
    const quiet = FcmSender.body({ token: "i", platform: "ios", title: "Radar", body: "x", data: offer, sound: "none" }).message as unknown as typeof plain;
    expect(quiet.apns.payload.aps).toEqual({ alert: { title: "Radar", body: "x" }, "thread-id": "new_offer" });
    for (const m of [plain, loud, quiet]) {
      expect(m.apns.payload.aps).not.toHaveProperty("badge");
      expect(m.apns.payload.aps).not.toHaveProperty("content-available");
    }
  });

  it("v0.18.156: a 401 for an iOS device logs one clear line about the APNs key (Android: no line)", async () => {
    const google = fakeGoogle(() => ({ status: 401, body: { error: { status: "UNAUTHENTICATED", details: [{ errorCode: "THIRD_PARTY_AUTH_ERROR" }] } } }));
    const account = parseServiceAccount(ACCOUNT_JSON).account!;
    const lines: string[] = [];
    const sender = new FcmSender(account, new GoogleAccessTokens(account, google.fetch, () => clock.now), google.fetch, undefined, (m) => lines.push(m));
    expect(await sender.send({ token: "a", platform: "android", title: "T", body: "B", data: {} })).toBe("retry");
    expect(lines).toEqual([]);
    expect(await sender.send({ token: "i", platform: "ios", title: "T", body: "B", data: {} })).toBe("retry");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("THIRD_PARTY_AUTH_ERROR");
    expect(lines[0]).toContain("APNs auth key");
    // Review of #337: the line names the app when the dispatcher knows it.
    expect(await sender.send({ token: "j", platform: "ios", app: "rider", title: "T", body: "B", data: {} })).toBe("retry");
    expect(lines[1]).toContain("of the rider app");
  });

  it("review of #340: PushMessage.app (log only) never reaches the FCM request body", () => {
    const base = { token: "t", title: "T", body: "B", data: { kind: "trip_message" }, app: "driver" as const };
    for (const message of [
      { ...base, platform: "web" as const },
      { ...base, platform: "android" as const, sound: "offer" as const, ttlSeconds: 30 },
      { ...base, platform: "ios" as const, sound: "none" as const },
      { ...base, platform: "ios" as const },
      { ...base, platform: "android" as const },
    ]) {
      expect(JSON.stringify(FcmSender.body(message))).not.toContain('"app":');
    }
  });

  it("classifies FCM errors: unregistered / invalid token = remove, 429 / 5xx / 401 = retry, others = failed", () => {
    expect(classifyFcmError(404, JSON.stringify({ error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } }))).toBe("dead_token");
    expect(classifyFcmError(400, JSON.stringify({ error: { status: "INVALID_ARGUMENT", message: "The registration token is not a valid FCM registration token" } }))).toBe("dead_token");
    expect(classifyFcmError(400, JSON.stringify({ error: { status: "INVALID_ARGUMENT", message: "Invalid JSON payload" } }))).toBe("failed");
    let refreshed = false;
    expect(classifyFcmError(401, "", () => (refreshed = true))).toBe("retry");
    expect(refreshed).toBe(true);
    expect(classifyFcmError(429, "")).toBe("retry");
    expect(classifyFcmError(503, "not json")).toBe("retry");
    expect(classifyFcmError(403, "{}")).toBe("failed");
  });
});

describe("push dispatcher (database)", () => {
  let database: TestDatabase;
  class FakeSender implements PushSender {
    sent: PushMessage[] = [];
    script = new Map<string, SendResult[]>();
    async send(message: PushMessage): Promise<SendResult> {
      this.sent.push(message);
      return this.script.get(message.token)?.shift() ?? "sent";
    }
  }
  let sender: FakeSender;
  let pusher: PushDispatcher;
  const device = (token: string, actor: "rider" | "driver", subjectId: string, platform: "web" | "android" = "web", provider: "fcm" | "apns" = "fcm") =>
    database.db.insertInto("push_devices").values({ token, actor, subject_id: subjectId, session_id: null, provider, platform, app_version: null, locale: null, updated_at: clock.now }).execute();

  beforeAll(async () => {
    database = await freshDatabase();
  });
  afterAll(async () => {
    await database.drop();
  });
  beforeEach(async () => {
    clock.now = new Date(clock.now.getTime() + 3600_000);
    await database.db.deleteFrom("push_devices").execute();
    await database.db.updateTable("notifications").set({ pushed_at: clock.now }).where("pushed_at", "is", null).execute();
    sender = new FakeSender();
    pusher = new PushDispatcher(database.db, sender, { clock: () => clock.now, sleep: async () => {} });
  });

  it("sends a committed notice to every fcm device of its subject with notificationId, kind and deepLink; once only", async () => {
    await device("drv-web", "driver", "drv_a");
    await device("drv-phone", "driver", "drv_a", "android");
    await device("drv-apns", "driver", "drv_a", "android", "apns");
    await device("other", "driver", "drv_b");
    const id = await notify(database.db, { audience: "driver", subjectId: "drv_a", kind: "document_expiring", title: "Körkort går ut", body: "Om 7 dagar", deepLink: "movera-driver://documents/driving_license" }, clock.now);
    expect(await pusher.sweep()).toBe(1);
    expect(sender.sent.map((m) => m.token).sort()).toEqual(["drv-phone", "drv-web"]);
    expect(sender.sent[0]).toMatchObject({ title: "Körkort går ut", body: "Om 7 dagar", data: { notificationId: id, kind: "document_expiring", deepLink: "movera-driver://documents/driving_license" } });
    expect(await pusher.sweep()).toBe(0);
    expect(sender.sent).toHaveLength(2);
  });

  it("never sends inside the command's transaction, and never a rolled-back notice", async () => {
    await device("tx-web", "driver", "drv_tx");
    let duringTransaction = -1;
    await database.db.transaction().execute(async (trx) => {
      await notify(trx, { audience: "driver", subjectId: "drv_tx", kind: "trip_message", title: "t", body: "b" }, clock.now);
      duringTransaction = await pusher.sweep();
    });
    expect(duringTransaction).toBe(0);
    await database.db
      .transaction()
      .execute(async (trx) => {
        await notify(trx, { audience: "driver", subjectId: "drv_tx", kind: "trip_message", title: "rolled", body: "back" }, clock.now);
        throw new Error("rollback");
      })
      .catch(() => {});
    expect(await pusher.sweep()).toBe(1);
    expect(sender.sent.map((m) => m.title)).toEqual(["t"]);
  });

  it("removes a token FCM calls dead, retries once on a passing error, and keeps going on a failure", async () => {
    await device("dead", "driver", "drv_c");
    await device("flaky", "driver", "drv_c");
    await device("broken", "driver", "drv_c");
    sender.script.set("dead", ["dead_token"]);
    sender.script.set("flaky", ["retry", "sent"]);
    sender.script.set("broken", ["retry", "retry"]);
    await notify(database.db, { audience: "driver", subjectId: "drv_c", kind: "vehicle_approved", title: "t", body: "b" }, clock.now);
    await pusher.sweep();
    expect(sender.sent.filter((m) => m.token === "flaky")).toHaveLength(2);
    expect(sender.sent.filter((m) => m.token === "broken")).toHaveLength(2);
    expect(sender.sent.filter((m) => m.token === "dead")).toHaveLength(1);
    const left = await database.db.selectFrom("push_devices").select("token").where("subject_id", "=", "drv_c").execute();
    expect(left.map((r) => r.token).sort()).toEqual(["broken", "flaky"]);
  });

  it("follow-up 2026-11-26: a failed push logs the app and a hash of the id, never the token or the raw id", async () => {
    const lines: { data: Record<string, unknown>; message: string }[] = [];
    pusher = new PushDispatcher(database.db, sender, { clock: () => clock.now, sleep: async () => {}, logger: { warn: (data, message) => lines.push({ data: data as Record<string, unknown>, message }) } });
    await device("secret-token-xyz", "rider", "rid_log");
    sender.script.set("secret-token-xyz", ["failed"]);
    await notify(database.db, { audience: "rider", subjectId: "rid_log", kind: "driver_arrived", title: "t", body: "b" }, clock.now);
    await pusher.sweep();
    expect(lines).toHaveLength(1);
    expect(lines[0]!.data).toMatchObject({ app: "rider", subjectHash: subjectHash("rider", "rid_log"), result: "failed" });
    expect(subjectHash("rider", "rid_log")).toMatch(/^[0-9a-f]{16}$/);
    expect(subjectHash("driver", "rid_log")).not.toBe(subjectHash("rider", "rid_log"));
    const text = JSON.stringify(lines);
    expect(text).not.toContain("secret-token-xyz");
    expect(text).not.toContain("rid_log");
  });

  it("review of #337: with PUSH_LOG_HASH_KEY the id hash is an HMAC; a sweep failure line is scrubbed", async () => {
    const lines: { data: Record<string, unknown>; message: string }[] = [];
    const logger = { warn: (data: object, message: string) => lines.push({ data: data as Record<string, unknown>, message }) };
    pusher = new PushDispatcher(database.db, sender, { clock: () => clock.now, sleep: async () => {}, logger, hashKey: "k".repeat(32) });
    await device("tok-hmac", "driver", "drv_hmac");
    sender.script.set("tok-hmac", ["failed"]);
    await notify(database.db, { audience: "driver", subjectId: "drv_hmac", kind: "vehicle_approved", title: "t", body: "b" }, clock.now);
    await pusher.sweep();
    expect(lines[0]!.data).toMatchObject({ app: "driver", subjectHash: subjectHash("driver", "drv_hmac", "k".repeat(32)) });
    expect(subjectHash("driver", "drv_hmac", "k".repeat(32))).not.toBe(subjectHash("driver", "drv_hmac"));
    expect(sender.sent.at(-1)).toMatchObject({ app: "driver" });
    const broken = new PushDispatcher(database.db, { send: async () => "sent" }, { logger, sweepMs: 60_000 });
    (broken as unknown as { sweep: () => Promise<number> }).sweep = async () => {
      throw new Error("invalid input for +46701234567 at someone@example.com");
    };
    await (broken as unknown as { sweepSafely: () => Promise<void> }).sweepSafely();
    const sweepLine = JSON.stringify(lines.at(-1));
    expect(lines.at(-1)!.message).toBe("push sweep failed");
    expect(sweepLine).not.toContain("+46701234567");
    expect(sweepLine).not.toContain("someone@example.com");
  });

  it("respects the rider's consents.rideUpdates false (the bell notice is still there)", async () => {
    await database.db.insertInto("riders").values({ rider_id: "rdr_quiet", phone: "+46700000901", first_name: "Q", email: null, language: null, consents: JSON.stringify({ rideUpdates: false }) }).execute();
    await database.db.insertInto("riders").values({ rider_id: "rdr_loud", phone: "+46700000902", first_name: "L", email: null, language: null }).execute();
    await device("quiet", "rider", "rdr_quiet");
    await device("loud", "rider", "rdr_loud");
    await notify(database.db, { audience: "rider", subjectId: "rdr_quiet", kind: "trip_message", title: "t", body: "b" }, clock.now);
    await notify(database.db, { audience: "rider", subjectId: "rdr_loud", kind: "trip_message", title: "t", body: "b" }, clock.now);
    expect(await pusher.sweep()).toBe(2);
    expect(sender.sent.map((m) => m.token)).toEqual(["loud"]);
  });

  // v0.18.53 §75 (owner Q36-Q39, contract.json#riderTripPush.consent): the switch stops only the optional moments.
  it("rideUpdates false: driver_arrived, support_reply and reservation_no_driver are still pushed; driver_found and unknown kinds are not", async () => {
    await database.db.insertInto("riders").values({ rider_id: "rdr_quiet2", phone: "+46700000903", first_name: "Q", email: null, language: null, consents: JSON.stringify({ rideUpdates: false }) }).execute();
    await device("quiet2", "rider", "rdr_quiet2");
    const rider = { audience: "rider" as const, subjectId: "rdr_quiet2", title: "t", body: "b" };
    await notify(database.db, { ...rider, kind: "trip_update", data: { tripId: "trp_1", moment: "driver_arrived" } }, clock.now);
    await notify(database.db, { ...rider, kind: "trip_update", data: { tripId: "trp_1", moment: "driver_found" } }, clock.now);
    await notify(database.db, { ...rider, kind: "support_reply", data: { ticketId: "tkt_1" } }, clock.now);
    await notify(database.db, { ...rider, kind: "reservation_no_driver", data: { tripId: "trp_2" } }, clock.now);
    await notify(database.db, { ...rider, kind: "trip_message" }, clock.now);
    expect(await pusher.sweep()).toBe(5);
    expect(sender.sent.map((m) => m.data["kind"]).sort()).toEqual(["reservation_no_driver", "support_reply", "trip_update"]);
    expect(sender.sent.find((m) => m.data["kind"] === "trip_update")!.data["notificationId"]).toBe((await database.db.selectFrom("notifications").select("notification_id").where("subject_id", "=", "rdr_quiet2").where(sql<boolean>`data->>'moment' = 'driver_arrived'`).executeTakeFirstOrThrow()).notification_id);
  });

  it("does not send notices older than an hour (push was off), but marks them taken", async () => {
    await device("late", "driver", "drv_d");
    await notify(database.db, { audience: "driver", subjectId: "drv_d", kind: "trip_message", title: "old", body: "b" }, new Date(clock.now.getTime() - 2 * 3600_000));
    expect(await pusher.sweep()).toBe(1);
    expect(sender.sent).toEqual([]);
    expect(await pusher.sweep()).toBe(0);
  });

  it("notify() kicks the dispatcher without waiting for it", async () => {
    let kicks = 0;
    const off = onNotify(() => {
      kicks++;
      throw new Error("a broken listener never breaks notify");
    });
    await notify(database.db, { audience: "driver", subjectId: "drv_e", kind: "trip_message", title: "t", body: "b" }, clock.now);
    off();
    await notify(database.db, { audience: "driver", subjectId: "drv_e", kind: "trip_message", title: "t", body: "b" }, clock.now);
    expect(kicks).toBe(1);
  });
});

describe("GET /push/config and disabled mode", () => {
  let database: TestDatabase;
  let off: FastifyInstance;
  let on: FastifyInstance;
  let google: ReturnType<typeof fakeGoogle>;

  beforeAll(async () => {
    database = await freshDatabase();
    google = fakeGoogle();
    const env = { MOVERA_ENV: "staging", DATABASE_URL: database.url, JWT_SECRET: SECRET };
    off = await buildApp({ env: readEnv(env), logger: false, db: database.db, clock: () => clock.now });
    on = await buildApp({ env: readEnv(env), logger: false, db: database.db, clock: () => clock.now, push: pushServicesFrom({ FIREBASE_SERVICE_ACCOUNT: ACCOUNT_JSON }, { fetch: google.fetch, clock: () => clock.now }) });
  });
  afterAll(async () => {
    await off.close();
    await on.close();
    await database.drop();
  });

  it("without FIREBASE_SERVICE_ACCOUNT: push is off, nothing crashes, the config says enabled false", async () => {
    expect(pushServicesFrom({}).status).toBe("off");
    expect(pushServicesFrom({}).sender).toBeUndefined();
    const bad = pushServicesFrom({ FIREBASE_SERVICE_ACCOUNT: "not json at all" });
    expect(bad).toMatchObject({ status: "invalid", problem: "not_json" });
    expect(bad.sender).toBeUndefined();
    const res = await off.inject({ method: "GET", url: "/api/v1/push/config?app=driver" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ provider: "fcm", enabled: false });
    // S06 F13: a route's own cache header wins over the API's no-store.
    expect(res.headers["cache-control"]).toBe("public, max-age=300");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    const withBad = await buildApp({ env: readEnv({ MOVERA_ENV: "development", FIREBASE_SERVICE_ACCOUNT: "{broken" }), logger: false });
    expect((await withBad.inject({ method: "GET", url: "/api/v1/push/config?app=rider" })).json()).toEqual({ provider: "fcm", enabled: false });
    await withBad.close();
  });

  it("with the service account: the web app's public config by display name, no token needed, read once", async () => {
    const res = await on.inject({ method: "GET", url: "/api/v1/push/config?app=driver" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      provider: "fcm",
      enabled: true,
      projectId: "movera-test",
      webConfig: { apiKey: "public-web-key", appId: "1:42:web:driver", messagingSenderId: "42", projectId: "movera-test", authDomain: "movera-test.firebaseapp.com" },
    });
    await on.inject({ method: "GET", url: "/api/v1/push/config?app=driver" });
    expect(google.calls.filter((c) => c.url.includes("/webApps?"))).toHaveLength(1);
    expect(google.calls.find((c) => c.url.includes("/webApps?"))!.url).toBe("https://firebase.googleapis.com/v1beta1/projects/movera-test/webApps?pageSize=100");
  });

  it("a web app Firebase cannot give is enabled false (tried again later); a wrong app is 400", async () => {
    const rider = await on.inject({ method: "GET", url: "/api/v1/push/config?app=rider" });
    expect(rider.json()).toEqual({ provider: "fcm", enabled: false });
    expect((await on.inject({ method: "GET", url: "/api/v1/push/config?app=admin" })).statusCode).toBe(400);
    expect((await on.inject({ method: "GET", url: "/api/v1/push/config" })).statusCode).toBe(400);
  });

  it("v0.18.105 BQ-V43: platform=android gives the Android app's public settings by package name, read once", async () => {
    const res = await on.inject({ method: "GET", url: "/api/v1/push/config?app=driver&platform=android" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      provider: "fcm",
      enabled: true,
      projectId: "movera-test",
      androidConfig: { apiKey: "public-android-key", appId: "1:42:android:driver", messagingSenderId: "42", projectId: "movera-test" },
    });
    expect(res.headers["cache-control"]).toBe("public, max-age=300");
    await on.inject({ method: "GET", url: "/api/v1/push/config?app=driver&platform=android" });
    expect(google.calls.filter((c) => c.url.includes("/androidApps?"))).toHaveLength(1);
    expect(google.calls.find((c) => c.url.includes("/androidApps?"))!.url).toBe("https://firebase.googleapis.com/v1beta1/projects/movera-test/androidApps?pageSize=100");
    // The deleted app is never used; the web answer stays the v0.18.3 one (no androidConfig).
    expect(google.calls.some((c) => c.url.includes("android%3Aold"))).toBe(false);
    const web = (await on.inject({ method: "GET", url: "/api/v1/push/config?app=driver&platform=web" })).json();
    expect(web).not.toHaveProperty("androidConfig");
    expect(web.webConfig.appId).toBe("1:42:web:driver");
  });

  it("v0.18.105 BQ-V43: an Android app Firebase cannot give, no service account: enabled false", async () => {
    expect((await on.inject({ method: "GET", url: "/api/v1/push/config?app=rider&platform=android" })).json()).toEqual({ provider: "fcm", enabled: false });
    expect((await off.inject({ method: "GET", url: "/api/v1/push/config?app=driver&platform=ios" })).json()).toEqual({ provider: "fcm", enabled: false });
    expect((await off.inject({ method: "GET", url: "/api/v1/push/config?app=driver&platform=android" })).json()).toEqual({ provider: "fcm", enabled: false });
    expect((await on.inject({ method: "GET", url: "/api/v1/push/config?app=driver&platform=windows" })).statusCode).toBe(400);
  });

  it("v0.18.156: platform=ios gives the iOS app's public settings by bundle id (from its plist), read once", async () => {
    const res = await on.inject({ method: "GET", url: "/api/v1/push/config?app=driver&platform=ios" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      provider: "fcm",
      enabled: true,
      projectId: "movera-test",
      iosConfig: { apiKey: "public-ios-key", appId: "1:42:ios:driver", messagingSenderId: "42", projectId: "movera-test", iosBundleId: "se.movera.driver" },
    });
    expect(res.headers["cache-control"]).toBe("public, max-age=300");
    await on.inject({ method: "GET", url: "/api/v1/push/config?app=driver&platform=ios" });
    expect(google.calls.filter((c) => c.url.includes("/iosApps?"))).toHaveLength(1);
    expect(google.calls.find((c) => c.url.includes("/iosApps?"))!.url).toBe("https://firebase.googleapis.com/v1beta1/projects/movera-test/iosApps?pageSize=100");
    expect(google.calls.some((c) => c.url.includes("ios%3Aold"))).toBe(false);
    // The other platforms' answers are unchanged.
    const android = (await on.inject({ method: "GET", url: "/api/v1/push/config?app=driver&platform=android" })).json();
    expect(android).not.toHaveProperty("iosConfig");
    expect(android.androidConfig.appId).toBe("1:42:android:driver");
  });

  it("v0.18.156: an iOS config whose app id is not an iOS one is never served (it would abort the iPhone app)", async () => {
    expect((await on.inject({ method: "GET", url: "/api/v1/push/config?app=rider&platform=ios" })).json()).toEqual({ provider: "fcm", enabled: false });
  });
});
