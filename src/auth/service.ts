import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { sql } from "kysely";
import { contract } from "../contract/contract.js";
import type { Db, Executor, Trx } from "../db/db.js";
import { ApiError, badRequest } from "../http/errors.js";
import { newId } from "../ids.js";
import { signAccessToken, type Actor } from "./jwt.js";

/**
 * Phone sign-in for the rider and driver apps (contract v0.5.0 §8, contract.json#auth).
 *
 * Test week: only test numbers can sign in (owner decision 2); they get no SMS and the fixed code works, and
 * only outside production. Any other number is 403 forbidden, reason sign_in_restricted, until an SMS
 * provider is connected.
 */

type AuthContract = {
  otp: { codeLength: number; expiresSeconds: number; retryAfterSeconds: number; maxAttempts: number };
  tokens: { accessExpiresSeconds: number; refreshExpiresDays: number };
  testSignIn: { code: string };
};
const AUTH = (contract as unknown as { auth: AuthContract }).auth;

export const OTP = {
  codeLength: AUTH.otp.codeLength,
  expiresSeconds: AUTH.otp.expiresSeconds,
  retryAfterSeconds: AUTH.otp.retryAfterSeconds,
  maxAttempts: AUTH.otp.maxAttempts,
  /** Codes started per phone and app in one hour, and per client address in one hour. */
  perPhonePerHour: 10,
  perIpPerHour: 60,
} as const;
export const ACCESS_TTL_SECONDS = AUTH.tokens.accessExpiresSeconds;
export const REFRESH_TTL_MS = AUTH.tokens.refreshExpiresDays * 24 * 60 * 60 * 1000;
export const TEST_CODE = AUTH.testSignIn.code;
/**
 * A refresh answer lost on a bad connection makes the app send the same refresh token again. Within this
 * window that is a retry, not theft: the unused replacement is dropped and a new pair is issued.
 */
export const REFRESH_RETRY_WINDOW_MS = 60_000;

export type App = "rider" | "driver";

export type AuthDeps = {
  db: Db;
  jwtSecret: string;
  /** Test numbers work only when this is true (never on production). */
  testSignInEnabled: boolean;
  clock?: () => Date;
};

export type ClientInfo = { ip?: string | undefined; userAgent?: string | undefined };

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const codeHash = (sessionId: string, code: string) => sha256(`${sessionId}:${code}`);

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

function rateLimited(message: string, retryAfterSeconds: number, reason: string): ApiError {
  return new ApiError("rate_limited", message, { reason, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterSeconds)) });
}

export const PHONE = /^\+[1-9][0-9]{6,14}$/;

/* ---------------------------------------------------------------- request a code */

export type OtpChallenge = { requestId: string; sessionId: string; expiresAt: string; retryAfterSeconds: number };

export async function requestOtp(
  deps: AuthDeps,
  input: { phone: string; app: App; locale?: string | undefined; requestId: string },
  client: ClientInfo,
): Promise<OtpChallenge> {
  const now = deps.clock?.() ?? new Date();
  if (!PHONE.test(input.phone)) throw badRequest("Send the phone number in international form, e.g. +46701234567.", "invalid_phone");

  return deps.db.transaction().execute(async (trx) => {
    // One sign-in start at a time per phone and app, so the resend and hourly limits cannot be raced.
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`otp:${input.app}:${input.phone}`}))`.execute(trx);

    const isTest = deps.testSignInEnabled && (await isTestPhone(trx, input.phone, input.app));
    if (!isTest) {
      throw new ApiError("forbidden", "Sign-in is not open for this number yet.", { reason: "sign_in_restricted" });
    }

    const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const recent = await trx
      .selectFrom("otp_sessions")
      .select(["created_at"])
      .where("phone", "=", input.phone)
      .where("app", "=", input.app)
      .where("created_at", ">", hourAgo)
      .orderBy("created_at", "desc")
      .execute();
    const last = recent[0];
    if (last !== undefined) {
      const waited = (now.getTime() - last.created_at.getTime()) / 1000;
      if (waited < OTP.retryAfterSeconds) {
        throw rateLimited("Wait a moment before asking for a new code.", OTP.retryAfterSeconds - waited, "otp_resend_too_soon");
      }
    }
    if (recent.length >= OTP.perPhonePerHour) {
      const oldest = recent[recent.length - 1]!;
      throw rateLimited("Too many codes for this number. Try again later.", (oldest.created_at.getTime() + 3_600_000 - now.getTime()) / 1000, "otp_too_many");
    }
    if (client.ip !== undefined) {
      const fromIp = await trx
        .selectFrom("otp_sessions")
        .select((eb) => eb.fn.countAll<string>().as("n"))
        .where("ip", "=", client.ip)
        .where("created_at", ">", hourAgo)
        .executeTakeFirstOrThrow();
      if (Number(fromIp.n) >= OTP.perIpPerHour) throw rateLimited("Too many sign-in attempts. Try again later.", 600, "otp_too_many");
    }

    const sessionId = newId("otp", now.getTime());
    // A test number's code is the fixed one; any other number would get a random code by SMS.
    const code = isTest ? TEST_CODE : String(randomInt(0, 10 ** OTP.codeLength)).padStart(OTP.codeLength, "0");
    const expiresAt = new Date(now.getTime() + OTP.expiresSeconds * 1000);
    // A new code replaces any earlier one for this number and app.
    await trx
      .updateTable("otp_sessions")
      .set({ consumed_at: now })
      .where("phone", "=", input.phone)
      .where("app", "=", input.app)
      .where("consumed_at", "is", null)
      .execute();
    await trx
      .insertInto("otp_sessions")
      .values({
        session_id: sessionId,
        phone: input.phone,
        app: input.app,
        code_sha256: codeHash(sessionId, code),
        is_test: isTest,
        locale: input.locale ?? null,
        ip: client.ip ?? null,
        max_attempts: OTP.maxAttempts,
        expires_at: expiresAt,
        created_at: now,
      })
      .execute();
    return { requestId: input.requestId, sessionId, expiresAt: expiresAt.toISOString(), retryAfterSeconds: OTP.retryAfterSeconds };
  });
}

async function isTestPhone(ex: Executor, phone: string, app: App): Promise<boolean> {
  const row = await ex.selectFrom("test_phones").select("phone").where("phone", "=", phone).where("app", "=", app).executeTakeFirst();
  return row !== undefined;
}

/* ---------------------------------------------------------------- verify the code */

export type AuthTokens = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  actor: App;
  isNewRider?: boolean;
  isNewDriver?: boolean;
};

type VerifyOutcome = { ok: true; tokens: AuthTokens } | { ok: false; error: ApiError };

export async function verifyOtp(
  deps: AuthDeps,
  input: { phone: string; sessionId: string; code: string },
  client: ClientInfo,
): Promise<AuthTokens> {
  const now = deps.clock?.() ?? new Date();
  if (!PHONE.test(input.phone)) throw badRequest("Send the phone number in international form, e.g. +46701234567.", "invalid_phone");
  if (!new RegExp(`^[0-9]{${OTP.codeLength}}$`).test(input.code)) throw badRequest(`The code is ${OTP.codeLength} digits.`, "invalid_otp_code");

  // A wrong code must still count as an attempt, so the transaction commits and the error is thrown after.
  const outcome: VerifyOutcome = await deps.db.transaction().execute(async (trx): Promise<VerifyOutcome> => {
    const session = await trx.selectFrom("otp_sessions").selectAll().where("session_id", "=", input.sessionId).forUpdate().executeTakeFirst();
    if (session === undefined || session.phone !== input.phone || session.consumed_at !== null) {
      return { ok: false, error: badRequest("This sign-in is not active. Ask for a new code.", "invalid_otp_session") };
    }
    if (session.expires_at.getTime() <= now.getTime()) {
      return { ok: false, error: new ApiError("otp_expired", "The code expired. Ask for a new one.") };
    }
    if (session.attempts >= session.max_attempts) {
      return { ok: false, error: rateLimited("Too many wrong codes. Ask for a new code.", OTP.retryAfterSeconds, "otp_too_many_attempts") };
    }
    if (session.is_test && !deps.testSignInEnabled) {
      return { ok: false, error: badRequest("This sign-in is not active. Ask for a new code.", "invalid_otp_session") };
    }
    if (!sameHash(session.code_sha256, codeHash(session.session_id, input.code))) {
      await trx.updateTable("otp_sessions").set({ attempts: session.attempts + 1 }).where("session_id", "=", session.session_id).execute();
      return { ok: false, error: badRequest("That code is not right.", "invalid_otp_code") };
    }
    await trx.updateTable("otp_sessions").set({ consumed_at: now, attempts: session.attempts + 1 }).where("session_id", "=", session.session_id).execute();

    const account = await findOrCreateAccount(trx, session.app, session.phone, now);
    const tokens = await startSession(trx, deps, { actor: session.app, subjectId: account.id, zones: account.zones }, client, now);
    return {
      ok: true,
      tokens: {
        ...tokens,
        actor: session.app,
        ...(session.app === "rider" ? { isNewRider: account.created } : { isNewDriver: account.created }),
      },
    };
  });
  if (!outcome.ok) throw outcome.error;
  return outcome.tokens;
}

async function findOrCreateAccount(trx: Trx, app: App, phone: string, now: Date): Promise<{ id: string; created: boolean; zones: string[] }> {
  if (app === "rider") {
    const inserted = await trx
      .insertInto("riders")
      .values({ rider_id: newId("rdr", now.getTime()), phone, email: null, language: null })
      .onConflict((conflict) => conflict.column("phone").doNothing())
      .returning("rider_id")
      .executeTakeFirst();
    if (inserted !== undefined) return { id: inserted.rider_id, created: true, zones: [] };
    const rider = await trx.selectFrom("riders").select(["rider_id", "status"]).where("phone", "=", phone).executeTakeFirstOrThrow();
    if (rider.status === "suspended") throw new ApiError("forbidden", "This account is suspended.", { reason: "account_suspended" });
    return { id: rider.rider_id, created: false, zones: [] };
  }
  const inserted = await trx
    .insertInto("drivers")
    .values({ driver_id: newId("drv", now.getTime()), phone, online_since: null, vehicle_id: null, scheduled_rides: null })
    .onConflict((conflict) => conflict.column("phone").doNothing())
    .returning("driver_id")
    .executeTakeFirst();
  if (inserted !== undefined) return { id: inserted.driver_id, created: true, zones: [] };
  // A suspended driver still signs in: the driver app shows its Suspended screen (contract §6 account status).
  const driver = await trx.selectFrom("drivers").select(["driver_id", "zone_ids"]).where("phone", "=", phone).executeTakeFirstOrThrow();
  return { id: driver.driver_id, created: false, zones: driver.zone_ids };
}

/* ---------------------------------------------------------------- sessions and tokens */

type Subject = { actor: Actor; subjectId: string; zones: string[] };

function newRefreshToken(): string {
  return `rt_${randomBytes(32).toString("base64url")}`;
}

export async function startSession(
  trx: Trx,
  deps: AuthDeps,
  subject: Subject,
  client: ClientInfo,
  now: Date,
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const sessionId = newId("sid", now.getTime());
  const expiresAt = new Date(now.getTime() + REFRESH_TTL_MS);
  await trx
    .insertInto("auth_sessions")
    .values({
      session_id: sessionId,
      actor: subject.actor,
      subject_id: subject.subjectId,
      expires_at: expiresAt,
      user_agent: client.userAgent?.slice(0, 300) ?? null,
      ip: client.ip ?? null,
      created_at: now,
      revoked_at: null,
      revoked_reason: null,
      last_refresh_at: null,
    })
    .execute();
  const refreshToken = newRefreshToken();
  await trx.insertInto("refresh_tokens").values({ token_sha256: sha256(refreshToken), session_id: sessionId, expires_at: expiresAt, used_at: null, replaced_by: null, created_at: now }).execute();
  return {
    accessToken: signAccessToken({ sub: subject.subjectId, actor: subject.actor, sid: sessionId, zones: subject.zones }, deps.jwtSecret, ACCESS_TTL_SECONDS, now),
    refreshToken,
    expiresIn: ACCESS_TTL_SECONDS,
  };
}

const unauthenticated = (reason: string) => new ApiError("unauthenticated", "Please sign in again.", { reason });

type RefreshOutcome = { ok: true; tokens: AuthTokens } | { ok: false; error: ApiError };

/**
 * Rotates the refresh token. A token used before is theft unless it is a lost-answer retry (same token again
 * within REFRESH_RETRY_WINDOW_MS while its replacement was never used); theft ends the whole session.
 */
export async function refreshTokens(deps: AuthDeps, refreshToken: string): Promise<AuthTokens> {
  const now = deps.clock?.() ?? new Date();
  const hash = sha256(refreshToken);
  const outcome = await deps.db.transaction().execute(async (trx): Promise<RefreshOutcome> => {
    // Lock order: the session first, then its tokens. Every refresh of a session queues on that one row, so two
    // refreshes at once (a retry and a normal one) wait for each other instead of deadlocking.
    const owner = await trx.selectFrom("refresh_tokens").select("session_id").where("token_sha256", "=", hash).executeTakeFirst();
    if (owner === undefined) return { ok: false, error: unauthenticated("refresh_token_unknown") };
    const session = await trx.selectFrom("auth_sessions").selectAll().where("session_id", "=", owner.session_id).forUpdate().executeTakeFirstOrThrow();
    const token = await trx.selectFrom("refresh_tokens").selectAll().where("token_sha256", "=", hash).forUpdate().executeTakeFirstOrThrow();
    if (session.revoked_at !== null) return { ok: false, error: unauthenticated("session_ended") };
    if (session.expires_at.getTime() <= now.getTime() || token.expires_at.getTime() <= now.getTime()) {
      return { ok: false, error: unauthenticated("session_expired") };
    }
    if (session.actor === "admin") return { ok: false, error: unauthenticated("refresh_token_unknown") };

    if (token.used_at !== null) {
      const replacement = token.replaced_by
        ? await trx.selectFrom("refresh_tokens").selectAll().where("token_sha256", "=", token.replaced_by).forUpdate().executeTakeFirst()
        : undefined;
      const isRetry = now.getTime() - token.used_at.getTime() <= REFRESH_RETRY_WINDOW_MS && replacement !== undefined && replacement.used_at === null;
      if (!isRetry) {
        await trx.updateTable("auth_sessions").set({ revoked_at: now, revoked_reason: "refresh_token_reused" }).where("session_id", "=", session.session_id).execute();
        return { ok: false, error: unauthenticated("refresh_token_reused") };
      }
      // Drop the replacement the app never received; it can no longer be used.
      await trx.updateTable("refresh_tokens").set({ used_at: now }).where("token_sha256", "=", replacement.token_sha256).execute();
    }

    const zones = await currentZones(trx, session.actor, session.subject_id);
    const next = newRefreshToken();
    const nextHash = sha256(next);
    const expiresAt = new Date(now.getTime() + REFRESH_TTL_MS);
    await trx.insertInto("refresh_tokens").values({ token_sha256: nextHash, session_id: session.session_id, expires_at: expiresAt, used_at: null, replaced_by: null, created_at: now }).execute();
    await trx.updateTable("refresh_tokens").set({ used_at: token.used_at ?? now, replaced_by: nextHash }).where("token_sha256", "=", hash).execute();
    await trx.updateTable("auth_sessions").set({ expires_at: expiresAt, last_refresh_at: now }).where("session_id", "=", session.session_id).execute();
    const actor = session.actor as App;
    return {
      ok: true,
      tokens: {
        accessToken: signAccessToken({ sub: session.subject_id, actor, sid: session.session_id, zones }, deps.jwtSecret, ACCESS_TTL_SECONDS, now),
        refreshToken: next,
        expiresIn: ACCESS_TTL_SECONDS,
        actor,
      },
    };
  });
  if (!outcome.ok) throw outcome.error;
  return outcome.tokens;
}

async function currentZones(ex: Executor, actor: Actor, subjectId: string): Promise<string[]> {
  if (actor !== "driver") return [];
  const driver = await ex.selectFrom("drivers").select("zone_ids").where("driver_id", "=", subjectId).executeTakeFirst();
  return driver?.zone_ids ?? [];
}

/** Ends the session and forgets its push devices. Repeating it is fine. */
export async function signOut(db: Db, sessionId: string, now: Date = new Date()): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable("auth_sessions")
      .set({ revoked_at: now, revoked_reason: "signed_out" })
      .where("session_id", "=", sessionId)
      .where("revoked_at", "is", null)
      .execute();
    await trx.deleteFrom("push_devices").where("session_id", "=", sessionId).execute();
  });
}

/** True while the session behind an access token is neither signed out nor expired. */
export async function sessionIsActive(ex: Executor, sessionId: string, now: Date = new Date()): Promise<boolean> {
  const row = await ex.selectFrom("auth_sessions").select(["revoked_at", "expires_at"]).where("session_id", "=", sessionId).executeTakeFirst();
  return row !== undefined && row.revoked_at === null && row.expires_at.getTime() > now.getTime();
}
