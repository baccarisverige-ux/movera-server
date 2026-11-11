import { createHash, randomBytes } from "node:crypto";
import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2";
import type { Db, Executor, Trx } from "../db/db.js";
import { ApiError, badRequest } from "../http/errors.js";
import { newId } from "../ids.js";
import { signAccessToken } from "../auth/jwt.js";
import { ACCESS_TTL_SECONDS, endAdminSessions, rotateRefresh, startSession, type ClientInfo } from "../auth/service.js";
import { audit } from "./audit.js";
import { isAdminRole, permissionsOf, type AdminRole } from "./permissions.js";

/** Admin sign-in (contract v0.5.1 §9; owner decisions 9 and 14): e-mail + password, one-time setup links. */

export const ADMIN = {
  passwordMinLength: 10,
  setupLinkMs: 72 * 60 * 60 * 1000,
  refreshTtlMs: 12 * 60 * 60 * 1000,
  /** Failed sign-ins in this window, per e-mail and per address, before a lock. */
  failureWindowMs: 15 * 60 * 1000,
  failuresPerEmail: 5,
  failuresPerIp: 20,
} as const;

export type AdminDeps = { db: Db; jwtSecret: string; panelUrl: string; clock?: () => Date };

export type AdminMe = {
  adminId: string;
  email: string;
  name: string;
  /** v0.18.18: the first name set in Team (absent until set). */
  firstName?: string;
  role: AdminRole;
  permissions: string[];
  scope: { zones: "all" | string[]; countries?: string[]; fleetPartnerId?: string };
  language?: string;
  idleTimeoutSeconds: number;
  approvalExempt: boolean;
};

export type AdminSession = { accessToken: string; refreshToken: string; expiresIn: number; actor: "admin"; admin: AdminMe };

type AdminRow = {
  admin_id: string;
  email: string;
  name: string;
  first_name?: string | null;
  role: string;
  zone_ids: string[] | null;
  countries: string[] | null;
  fleet_partner_id: string | null;
  language: string | null;
  active: boolean;
  password_hash: string | null;
  idle_timeout_seconds: number;
};

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const normalizeEmail = (email: string) => email.trim().toLowerCase();
const invalidCredentials = () => new ApiError("unauthenticated", "Wrong e-mail or password.", { reason: "invalid_credentials" });
// Verifying against this when the account does not exist keeps a wrong e-mail as slow as a wrong password.
const DUMMY_HASH = await argonHash("movera-no-such-admin-placeholder");

function roleOf(row: AdminRow): AdminRole {
  if (!isAdminRole(row.role)) throw new Error(`Admin ${row.admin_id} has an unknown role ${row.role}`);
  return row.role;
}

export function adminMe(row: AdminRow): AdminMe {
  const role = roleOf(row);
  return {
    adminId: row.admin_id,
    email: row.email,
    name: row.name,
    ...(row.first_name ? { firstName: row.first_name } : {}),
    role,
    permissions: permissionsOf(role),
    scope: {
      zones: row.zone_ids === null ? "all" : row.zone_ids,
      ...(row.countries ? { countries: row.countries } : {}),
      ...(row.fleet_partner_id ? { fleetPartnerId: row.fleet_partner_id } : {}),
    },
    ...(row.language ? { language: row.language } : {}),
    idleTimeoutSeconds: row.idle_timeout_seconds,
    // v0.7.2 (owner 2026-10-28): one admin is enough everywhere.
    approvalExempt: true,
  };
}

const subjectOf = (row: AdminRow) => {
  const me = adminMe(row);
  return { actor: "admin" as const, subjectId: row.admin_id, zones: me.scope.zones === "all" ? ["*"] : me.scope.zones, role: me.role, perms: me.permissions };
};

async function openSession(trx: Trx, deps: AdminDeps, row: AdminRow, client: ClientInfo, now: Date): Promise<AdminSession> {
  const { accessToken, refreshToken, expiresIn } = await startSession(trx, deps, subjectOf(row), client, now, ADMIN.refreshTtlMs);
  return { accessToken, refreshToken, expiresIn, actor: "admin", admin: adminMe(row) };
}

/* ---------------------------------------------------------------- sign-in */

export async function adminSignIn(deps: AdminDeps, input: { email: string; password: string }, client: ClientInfo): Promise<AdminSession> {
  const now = deps.clock?.() ?? new Date();
  const email = normalizeEmail(input.email);
  const since = new Date(now.getTime() - ADMIN.failureWindowMs);

  await assertNotLocked(deps.db, email, client.ip, since, now);
  const row = (await deps.db.selectFrom("admins").selectAll().where("email", "=", email).executeTakeFirst()) as AdminRow | undefined;
  const ok = await argonVerify(row?.password_hash ?? DUMMY_HASH, input.password).catch(() => false);
  if (row === undefined || row.password_hash === null || !row.active || !ok) {
    await deps.db.insertInto("admin_sign_in_failures").values({ email, ip: client.ip ?? null, at: now }).execute();
    throw invalidCredentials();
  }
  return deps.db.transaction().execute(async (trx) => {
    await trx.deleteFrom("admin_sign_in_failures").where("email", "=", email).execute();
    return openSession(trx, deps, row, client, now);
  });
}

async function assertNotLocked(ex: Executor, email: string, ip: string | undefined, since: Date, now: Date): Promise<void> {
  const failures = await ex.selectFrom("admin_sign_in_failures").select("at").where("email", "=", email).where("at", ">", since).orderBy("at").execute();
  if (failures.length >= ADMIN.failuresPerEmail) {
    const unlock = failures[failures.length - ADMIN.failuresPerEmail]!.at.getTime() + ADMIN.failureWindowMs;
    throw new ApiError("rate_limited", "Too many wrong passwords. Try again later.", { reason: "sign_in_locked", retryAfterSeconds: Math.max(1, Math.ceil((unlock - now.getTime()) / 1000)) });
  }
  if (ip !== undefined) {
    const fromIp = await ex.selectFrom("admin_sign_in_failures").select((eb) => eb.fn.countAll<string>().as("n")).where("ip", "=", ip).where("at", ">", since).executeTakeFirstOrThrow();
    if (Number(fromIp.n) >= ADMIN.failuresPerIp) {
      throw new ApiError("rate_limited", "Too many wrong passwords. Try again later.", { reason: "sign_in_locked", retryAfterSeconds: Math.ceil(ADMIN.failureWindowMs / 1000) });
    }
  }
}

/* ---------------------------------------------------------------- setup links */

export async function createSetupLink(deps: AdminDeps, adminId: string, createdBy: string | null, options: { audit?: boolean } = {}): Promise<{ url: string; expiresAt: string }> {
  const now = deps.clock?.() ?? new Date();
  const admin = await deps.db.selectFrom("admins").select(["admin_id", "active"]).where("admin_id", "=", adminId).executeTakeFirst();
  if (admin === undefined) throw new ApiError("not_found", "No such admin.", { reason: "admin_not_found" });
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + ADMIN.setupLinkMs);
  await deps.db.transaction().execute(async (trx) => {
    // A new link replaces any earlier unused one.
    await trx.updateTable("admin_setup_links").set({ used_at: now }).where("admin_id", "=", adminId).where("used_at", "is", null).execute();
    await trx.insertInto("admin_setup_links").values({ token_sha256: sha256(token), admin_id: adminId, expires_at: expiresAt, used_at: null, created_by: createdBy, created_at: now }).execute();
    // S06 F15: an admin making a link for another admin is audited like every admin change (never the token or its hash).
    if (options.audit === true) await audit(trx, { adminId: createdBy, action: "admin.setup_link", targetType: "admin", targetId: adminId, detail: { expiresAt: expiresAt.toISOString() }, at: now });
  });
  // Relative to the panel's own path, so a panel under a sub-path (GitHub Pages: /<repo>/live/) keeps it.
  const url = new URL("setup-password", deps.panelUrl.endsWith("/") ? deps.panelUrl : `${deps.panelUrl}/`);
  // The token travels in the fragment, so it never reaches a web server's logs.
  url.hash = `token=${token}`;
  return { url: url.toString(), expiresAt: expiresAt.toISOString() };
}

type LinkState = { ok: true; row: AdminRow; tokenHash: string } | { ok: false; error: ApiError };

async function readLink(ex: Executor, token: string, now: Date, lock: boolean): Promise<LinkState> {
  const tokenHash = sha256(token);
  let query = ex.selectFrom("admin_setup_links").selectAll().where("token_sha256", "=", tokenHash);
  if (lock) query = query.forUpdate();
  const link = await query.executeTakeFirst();
  if (link === undefined) return { ok: false, error: badRequest("This link is not valid.", "invalid_setup_token") };
  if (link.used_at !== null) return { ok: false, error: new ApiError("otp_expired", "This link was already used. Ask for a new one.", { reason: "setup_link_used" }) };
  if (link.expires_at.getTime() <= now.getTime()) return { ok: false, error: new ApiError("otp_expired", "This link expired. Ask for a new one.", { reason: "setup_link_expired" }) };
  const row = (await ex.selectFrom("admins").selectAll().where("admin_id", "=", link.admin_id).executeTakeFirstOrThrow()) as AdminRow;
  if (!row.active) return { ok: false, error: badRequest("This link is not valid.", "invalid_setup_token") };
  return { ok: true, row, tokenHash };
}

export async function checkSetupLink(deps: AdminDeps, token: string): Promise<{ email: string; name: string; expiresAt: string }> {
  const now = deps.clock?.() ?? new Date();
  const state = await readLink(deps.db, token, now, false);
  if (!state.ok) throw state.error;
  const link = await deps.db.selectFrom("admin_setup_links").select("expires_at").where("token_sha256", "=", state.tokenHash).executeTakeFirstOrThrow();
  return { email: state.row.email, name: state.row.name, expiresAt: link.expires_at.toISOString() };
}

export async function setupPassword(deps: AdminDeps, input: { setupToken: string; password: string }, client: ClientInfo): Promise<AdminSession> {
  const now = deps.clock?.() ?? new Date();
  if (input.password.length < ADMIN.passwordMinLength) {
    throw badRequest(`Choose a password of at least ${ADMIN.passwordMinLength} characters.`, "weak_password");
  }
  const passwordHash = await argonHash(input.password);
  return deps.db.transaction().execute(async (trx) => {
    const state = await readLink(trx, input.setupToken, now, true);
    if (!state.ok) throw state.error;
    await trx.updateTable("admin_setup_links").set({ used_at: now }).where("token_sha256", "=", state.tokenHash).execute();
    await trx.updateTable("admins").set({ password_hash: passwordHash, updated_at: now, version: (eb) => eb("version", "+", 1) }).where("admin_id", "=", state.row.admin_id).execute();
    // A new password ends every other session of this admin.
    await trx.updateTable("auth_sessions").set({ revoked_at: now, revoked_reason: "password_set" }).where("actor", "=", "admin").where("subject_id", "=", state.row.admin_id).where("revoked_at", "is", null).execute();
    await trx.deleteFrom("admin_sign_in_failures").where("email", "=", state.row.email).execute();
    return openSession(trx, deps, { ...state.row, password_hash: passwordHash }, client, now);
  });
}

/* ---------------------------------------------------------------- refresh and me */

type Outcome = { ok: true; session: AdminSession } | { ok: false; error: ApiError };

export async function adminRefresh(deps: AdminDeps, refreshToken: string): Promise<AdminSession> {
  const now = deps.clock?.() ?? new Date();
  const outcome = await deps.db.transaction().execute(async (trx): Promise<Outcome> => {
    const rotated = await rotateRefresh(trx, refreshToken, now, { actors: ["admin"], ttlMs: ADMIN.refreshTtlMs });
    if (!rotated.ok) return rotated;
    const row = (await trx.selectFrom("admins").selectAll().where("admin_id", "=", rotated.subjectId).executeTakeFirst()) as AdminRow | undefined;
    if (row === undefined || !row.active) {
      await trx.updateTable("auth_sessions").set({ revoked_at: now, revoked_reason: "admin_deactivated" }).where("session_id", "=", rotated.sessionId).execute();
      return { ok: false, error: new ApiError("unauthenticated", "Please sign in again.", { reason: "session_ended" }) };
    }
    const subject = subjectOf(row);
    return {
      ok: true,
      session: {
        accessToken: signAccessToken({ sub: subject.subjectId, actor: "admin", sid: rotated.sessionId, zones: subject.zones, role: subject.role, perms: subject.perms }, deps.jwtSecret, ACCESS_TTL_SECONDS, now),
        refreshToken: rotated.refreshToken,
        expiresIn: ACCESS_TTL_SECONDS,
        actor: "admin",
        admin: adminMe(row),
      },
    };
  });
  if (!outcome.ok) throw outcome.error;
  return outcome.session;
}

export async function loadAdminMe(ex: Executor, adminId: string): Promise<AdminMe> {
  const row = (await ex.selectFrom("admins").selectAll().where("admin_id", "=", adminId).executeTakeFirst()) as AdminRow | undefined;
  if (row === undefined || !row.active) throw new ApiError("unauthenticated", "Please sign in again.", { reason: "session_ended" });
  return adminMe(row);
}

/* ---------------------------------------------------------------- accounts (CLI / seed) */

export async function createAdmin(
  ex: Executor,
  input: { email: string; name: string; role: AdminRole; zoneIds?: string[] | null; language?: string | null },
  now: Date = new Date(),
): Promise<{ adminId: string; created: boolean }> {
  const email = normalizeEmail(input.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`Not an e-mail address: ${input.email}`);
  const existing = await ex.selectFrom("admins").select("admin_id").where("email", "=", email).executeTakeFirst();
  if (existing !== undefined) return { adminId: existing.admin_id, created: false };
  const adminId = newId("adm", now.getTime());
  await ex
    .insertInto("admins")
    .values({ admin_id: adminId, email, name: input.name, role: input.role, zone_ids: input.zoneIds ?? null, countries: null, fleet_partner_id: null, language: input.language ?? null, password_hash: null, created_at: now, updated_at: now })
    .execute();
  return { adminId, created: true };
}

/**
 * Step 38 (owner Q42): a role change and the end of every open session of that admin in ONE transaction, so the old
 * rights stop at once; the admin signs in again with the new role. Audited admin.role when `byAdminId` is given.
 */
export async function changeAdminRole(db: Db, adminId: string, role: AdminRole, now: Date = new Date(), byAdminId: string | null = null): Promise<{ from: AdminRole; ended: number }> {
  return db.transaction().execute(async (trx) => {
    const row = await trx.selectFrom("admins").select("role").where("admin_id", "=", adminId).forUpdate().executeTakeFirst();
    if (row === undefined) throw new ApiError("not_found", "No such admin.", { reason: "admin_not_found" });
    const from = isAdminRole(row.role) ? row.role : "viewer";
    if (from === role) return { from, ended: 0 };
    await trx.updateTable("admins").set({ role, updated_at: now }).where("admin_id", "=", adminId).execute();
    const ended = await endAdminSessions(trx, adminId, now, "role_changed");
    if (byAdminId !== null) await audit(trx, { adminId: byAdminId, action: "admin.role", targetType: "admin", targetId: adminId, detail: { from, to: role, sessionsEnded: ended }, at: now });
    return { from, ended };
  });
}
