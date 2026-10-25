import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { createAdmin, createSetupLink } from "../../src/admin/auth.js";
import { ADMIN_PERMISSIONS, permissionsOf } from "../../src/admin/permissions.js";
import { readEnv } from "../../src/env.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";

let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-10-24T10:00:00Z") };
const advance = (seconds: number) => (clock.now = new Date(clock.now.getTime() + seconds * 1000));
const SECRET = "admin-test-secret".padEnd(48, "y");
const PANEL = "https://admin.example.test";
const deps = () => ({ db: database.db, jwtSecret: SECRET, panelUrl: PANEL, clock: () => clock.now });
const PASSWORD = "correct horse battery";

beforeAll(async () => {
  database = await freshDatabase();
  app = await buildApp({ env: readEnv({ MOVERA_ENV: "staging", DATABASE_URL: database.url, JWT_SECRET: SECRET, ADMIN_PANEL_URL: PANEL }), logger: false, db: database.db, clock: () => clock.now });
});
afterAll(async () => {
  await app.close();
  await database.drop();
});
beforeEach(() => {
  advance(3600);
});

let n = 0;
const post = (url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url: `/api/v1${url}`, headers: { "content-type": "application/json", ...headers }, ...(payload === undefined ? { body: "" } : { payload: payload as object }) });
const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: "GET", url: `/api/v1${url}`, headers });
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const tokenOf = (url: string) => new URL(url).hash.replace("#token=", "");

async function newAdmin(role: "super" | "viewer" | "ops" = "super", email = `admin${++n}@movera.test`) {
  const { adminId } = await createAdmin(database.db, { email, name: `Admin ${n}`, role }, clock.now);
  const link = await createSetupLink(deps(), adminId, "test");
  const set = await post("/admin/auth/setup-password", { setupToken: tokenOf(link.url), password: PASSWORD });
  expect(set.statusCode).toBe(200);
  return { adminId, email, session: set.json() };
}

describe("roles", () => {
  it("super has all 34 contract permissions; viewer only reads", () => {
    expect(ADMIN_PERMISSIONS).toHaveLength(34);
    expect(permissionsOf("super")).toEqual([...ADMIN_PERMISSIONS]);
    expect(permissionsOf("viewer")).toEqual(["overview.read", "trips.read", "riders.read", "drivers.read", "zones.read"]);
  });
});

describe("setup link and first password", () => {
  it("the link is checked, sets the password once and signs in with the contract's AdminSession", async () => {
    const { adminId } = await createAdmin(database.db, { email: "Owner@Movera.TEST ", name: "Owner", role: "super" }, clock.now);
    // (Each new link replaces the last, so these come first.) A panel under a sub-path (GitHub Pages) keeps it, with or without the closing slash.
    for (const panelUrl of ["https://owner.github.io/Admin-panel/live/", "https://owner.github.io/Admin-panel/live"]) {
      const sub = await createSetupLink({ ...deps(), panelUrl }, adminId, "cli");
      expect(sub.url.startsWith("https://owner.github.io/Admin-panel/live/setup-password#token=")).toBe(true);
    }
    const link = await createSetupLink(deps(), adminId, "cli");
    expect(link.url.startsWith(`${PANEL}/setup-password#token=`)).toBe(true);
    expect(link.expiresAt).toBe(new Date(clock.now.getTime() + 72 * 3600_000).toISOString());
    const token = tokenOf(link.url);
    const check = await post("/admin/auth/setup-password/check", { setupToken: token });
    expect(check.json()).toEqual({ email: "owner@movera.test", name: "Owner", expiresAt: link.expiresAt });

    const weak = await post("/admin/auth/setup-password", { setupToken: token, password: "short" });
    expect(weak.statusCode).toBe(400);
    expect(weak.json()).toMatchObject({ code: "invalid_request", reason: "weak_password" });

    const set = await post("/admin/auth/setup-password", { setupToken: token, password: PASSWORD });
    expect(set.statusCode).toBe(200);
    const session = set.json();
    expect(Object.keys(session).sort()).toEqual(["accessToken", "actor", "admin", "expiresIn", "refreshToken"]);
    expect(session).toMatchObject({ actor: "admin", expiresIn: 900 });
    expect(session.admin).toEqual({
      adminId,
      email: "owner@movera.test",
      name: "Owner",
      role: "super",
      permissions: [...ADMIN_PERMISSIONS],
      scope: { zones: "all" },
      idleTimeoutSeconds: 900,
      approvalExempt: true,
    });

    const again = await post("/admin/auth/setup-password", { setupToken: token, password: PASSWORD });
    expect(again.statusCode).toBe(410);
    expect(again.json()).toMatchObject({ code: "otp_expired", reason: "setup_link_used" });
    const stored = await database.db.selectFrom("admins").select("password_hash").where("admin_id", "=", adminId).executeTakeFirstOrThrow();
    expect(stored.password_hash).toMatch(/^\$argon2id\$/);
  });

  it("an unknown link is 400 invalid_setup_token; an expired one 410 setup_link_expired", async () => {
    expect((await post("/admin/auth/setup-password/check", { setupToken: "x".repeat(40) })).json()).toMatchObject({ reason: "invalid_setup_token" });
    const { adminId } = await createAdmin(database.db, { email: "late@movera.test", name: "Late", role: "viewer" }, clock.now);
    const link = await createSetupLink(deps(), adminId, "cli");
    advance(72 * 3600 + 1);
    const res = await post("/admin/auth/setup-password", { setupToken: tokenOf(link.url), password: PASSWORD });
    expect(res.statusCode).toBe(410);
    expect(res.json()).toMatchObject({ reason: "setup_link_expired" });
  });

  it("a new link replaces the old unused one", async () => {
    const { adminId } = await createAdmin(database.db, { email: "twice@movera.test", name: "Twice", role: "viewer" }, clock.now);
    const first = await createSetupLink(deps(), adminId, "cli");
    await createSetupLink(deps(), adminId, "cli");
    expect((await post("/admin/auth/setup-password", { setupToken: tokenOf(first.url), password: PASSWORD })).json()).toMatchObject({ reason: "setup_link_used" });
  });
});

describe("sign-in", () => {
  it("signs in with e-mail (any case) and password", async () => {
    const { email, adminId } = await newAdmin("ops");
    const res = await post("/admin/auth/sign-in", { email: email.toUpperCase(), password: PASSWORD });
    expect(res.statusCode).toBe(200);
    expect(res.json().admin).toMatchObject({ adminId, role: "ops", approvalExempt: false });
  });

  it("unknown e-mail, wrong password and deactivated account get the same 401 invalid_credentials", async () => {
    const { email, adminId } = await newAdmin("viewer");
    const wrong = await post("/admin/auth/sign-in", { email, password: "not the password" });
    const unknown = await post("/admin/auth/sign-in", { email: "nobody@movera.test", password: PASSWORD });
    await database.db.updateTable("admins").set({ active: false }).where("admin_id", "=", adminId).execute();
    const inactive = await post("/admin/auth/sign-in", { email, password: PASSWORD });
    for (const res of [wrong, unknown, inactive]) {
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ code: "unauthenticated", reason: "invalid_credentials", message: "Wrong e-mail or password." });
    }
  });

  it("5 wrong passwords lock the e-mail for 15 minutes (429 with Retry-After), even with the right one", async () => {
    const { email } = await newAdmin("viewer");
    for (let i = 0; i < 5; i++) {
      expect((await post("/admin/auth/sign-in", { email, password: `wrong-${i}-password` })).statusCode).toBe(401);
      advance(10);
    }
    const locked = await post("/admin/auth/sign-in", { email, password: PASSWORD });
    expect(locked.statusCode).toBe(429);
    expect(locked.json()).toMatchObject({ code: "rate_limited", reason: "sign_in_locked" });
    expect(Number(locked.headers["retry-after"])).toBeGreaterThan(800);
    advance(15 * 60);
    expect((await post("/admin/auth/sign-in", { email, password: PASSWORD })).statusCode).toBe(200);
  });
});

describe("session", () => {
  it("me, refresh (rotated, 12 h at most) and sign-out", async () => {
    const { session, adminId } = await newAdmin("super");
    const me = await get("/admin/auth/me", bearer(session.accessToken));
    expect(me.json()).toMatchObject({ adminId, role: "super" });

    const refreshed = await post("/admin/auth/refresh", { refreshToken: session.refreshToken });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json()).toMatchObject({ actor: "admin", admin: { adminId } });
    advance(13 * 3600);
    expect((await post("/admin/auth/refresh", { refreshToken: refreshed.json().refreshToken })).json()).toMatchObject({ reason: "session_expired" });

    const fresh = (await post("/admin/auth/sign-in", { email: (await database.db.selectFrom("admins").select("email").where("admin_id", "=", adminId).executeTakeFirstOrThrow()).email, password: PASSWORD })).json();
    expect((await post("/admin/auth/sign-out", undefined, bearer(fresh.accessToken))).statusCode).toBe(204);
    expect((await post("/admin/auth/sign-out", undefined, bearer(fresh.accessToken))).statusCode).toBe(204);
    expect((await get("/admin/auth/me", bearer(fresh.accessToken))).json()).toMatchObject({ reason: "session_ended" });
  });

  it("app and admin tokens do not mix", async () => {
    const { session } = await newAdmin("super");
    const viaApp = await post("/auth/refresh", { refreshToken: session.refreshToken });
    expect(viaApp.json()).toMatchObject({ code: "unauthenticated", reason: "refresh_token_unknown" });
    const pushAsAdmin = await post("/push/devices", { token: "t", provider: "fcm", platform: "web" }, { ...bearer(session.accessToken), "idempotency-key": "k".repeat(20) });
    expect(pushAsAdmin.json()).toMatchObject({ code: "forbidden", reason: "wrong_actor" });
  });

  it("deactivating an admin ends their session at the next refresh", async () => {
    const { session, adminId } = await newAdmin("viewer");
    await database.db.updateTable("admins").set({ active: false }).where("admin_id", "=", adminId).execute();
    expect((await post("/admin/auth/refresh", { refreshToken: session.refreshToken })).json()).toMatchObject({ reason: "session_ended" });
  });
});

describe("setup links from the panel", () => {
  it("needs team.edit and an Idempotency-Key", async () => {
    const boss = await newAdmin("super");
    const viewer = await newAdmin("viewer");
    const denied = await post(`/admin/agents/${viewer.adminId}/setup-link`, undefined, { ...bearer(viewer.session.accessToken), "idempotency-key": "k".repeat(20) });
    expect(denied.json()).toMatchObject({ code: "forbidden", reason: "missing_permission" });
    const noKey = await post(`/admin/agents/${viewer.adminId}/setup-link`, undefined, bearer(boss.session.accessToken));
    expect(noKey.json()).toMatchObject({ reason: "idempotency_key_missing" });
    const ok = await post(`/admin/agents/${viewer.adminId}/setup-link`, undefined, { ...bearer(boss.session.accessToken), "idempotency-key": "k".repeat(20) });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().url).toContain("/setup-password#token=");
    const unknown = await post(`/admin/agents/adm_nope/setup-link`, undefined, { ...bearer(boss.session.accessToken), "idempotency-key": "k".repeat(21) });
    expect(unknown.statusCode).toBe(404);
  });

  it("a new password ends the admin's other sessions", async () => {
    const admin = await newAdmin("ops");
    const link = await createSetupLink(deps(), admin.adminId, "test");
    await post("/admin/auth/setup-password", { setupToken: tokenOf(link.url), password: "another long password" });
    expect((await get("/admin/auth/me", bearer(admin.session.accessToken))).json()).toMatchObject({ reason: "session_ended" });
  });
});
