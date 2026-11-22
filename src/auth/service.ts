import { sessionsRevoked } from "./sessionCache.js";
import type { EmailSender } from "../email/resend.js";
import { emailTakenByOther } from "./emailTaken.js";
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { sql } from "kysely";
import { contract } from "../contract/contract.js";
import type { Db, Executor, Trx } from "../db/db.js";
import { ApiError, badRequest } from "../http/errors.js";
import { riderBlocked, suspendedError } from "../riders/moderation.js";
import { closedError, isClosed } from "../accounts/deletion.js";
import { newId } from "../ids.js";
import { signAccessToken, type Actor } from "./jwt.js";
import { splitName, type Provider, type ProviderIdentity, type ProviderVerifier } from "./provider.js";
import { attachInvitesToNewDriver } from "../drivers/invitations.js";
import { notify } from "../notifications/service.js";
import { audit } from "../admin/audit.js";
import { countryLimitsFor, countryOfPhone } from "../config/countryLimits.js";
import { NOT_HELD } from "../reservations/view.js";
import { DRIVER_ASSIGNED } from "../rules/transitions.js";
import { noticeLanguage, pickNoticeLanguage } from "../notifications/noticeLanguage.js";
import type { CodeSmsSender } from "../sms/elks.js";
import { pokeAlerts } from "../alerts/detector.js";
import { DAY_MS, SIGN_IN_SMS_KIND, SMS_CODE_LENGTH, SMS_NO_ANSWER, maskPhone, nearCap, signInSmsLastDay, signInSmsText, smsCountryOf, smsLanguage, smsSignInFor, storedSmsText } from "./smsSignIn.js";

/**
 * Phone sign-in for the rider and driver apps (contract v0.5.0 §8, contract.json#auth).
 *
 * Test week: only test numbers can sign in (owner decision 2); they get no SMS and the fixed code works, and
 * only outside production. Any other number is 403 forbidden, reason sign_in_restricted, until an SMS
 * provider is connected.
 *
 * Contract v0.18.133 (contract.json#smsSignIn, owner 2026-11-19 "Yes, build it now (Rec.)"): with an SMS sender
 * (AuthDeps.signInSms: the 46elks keys are set) AND the country's admin switch on (CountryRules.smsSignIn.enabled,
 * default off), any other number of a served country gets a random code by SMS. Without either, nothing changes.
 *
 * Apple / Google (contract §8, v0.5.3): POST /auth/provider signs in an identity already linked to an account, or
 * answers PHONE_REQUIRED with a link token; the app then verifies a phone with that token (the first time only) and
 * the account is created or found by the phone and linked, with the provider's names and e-mail kept for the
 * details screen. A provider without client ids answers 503 provider_not_configured.
 */

type AuthContract = {
  otp: { codeLength: number; expiresSeconds: number; retryAfterSeconds: number; maxAttempts: number };
  tokens: { accessExpiresSeconds: number; refreshExpiresDays: number; refreshRetryWindowSeconds: number };
  testSignIn: { code: string };
};
const AUTH = (contract as unknown as { auth: AuthContract }).auth;

export const OTP = {
  codeLength: AUTH.otp.codeLength,
  expiresSeconds: AUTH.otp.expiresSeconds,
  retryAfterSeconds: AUTH.otp.retryAfterSeconds,
  maxAttempts: AUTH.otp.maxAttempts,
} as const;

/**
 * Wrong codes for this number from this client address in the last 24 h (both apps, codes not lifted by an admin), and
 * when the oldest of them leaves the window. Checker MED 3: this lock is per number AND source, so a stranger guessing
 * from one wifi does not lock the owner out on his own network. It is not the only lock: S7 W2 Q118 (owner 2026-11-16
 * "Lock at 60 for 24 h") adds the number's ceiling below (all addresses, PHONE_WRONG_CODES_CEILING_FACTOR ×
 * wrongCodesPerDay), so a stranger with several networks CAN lock the number for every address, for up to 24 h; an admin
 * unlock (unlockSignIn) lifts both at once, and phones already signed in keep working. (codesPerPhonePerHour could
 * already block new codes for a number for one hour.)
 */
async function wrongCodesToday(ex: Executor, phone: string, ip: string | undefined, now: Date): Promise<{ wrong: number; oldest: Date | null }> {
  const dayAgo = new Date(now.getTime() - 24 * 3_600_000);
  const row = await ex
    .selectFrom("otp_sessions")
    .select([sql<string>`coalesce(sum(attempts - (CASE WHEN verified THEN 1 ELSE 0 END)), 0)`.as("wrong"), sql<Date | null>`min(created_at) FILTER (WHERE attempts > (CASE WHEN verified THEN 1 ELSE 0 END))`.as("oldest")])
    .where("phone", "=", phone)
    .where((eb) => (ip === undefined ? eb("ip", "is", null) : eb("ip", "=", ip)))
    .where("unlocked_at", "is", null)
    .where("created_at", ">", dayAgo)
    .executeTakeFirstOrThrow();
  return { wrong: Number(row.wrong), oldest: row.oldest ? new Date(row.oldest) : null };
}

/**
 * S7 W2 Q118 (owner 2026-11-15 "Yes, phone + address ... phone alone only as a high ceiling"): the lock above is per
 * number AND address, so guessing one number's code from many addresses was never stopped by it. The number alone has
 * a ceiling of this many times wrongCodesPerDay in 24 h (all addresses, both apps, not lifted by an admin); at it the
 * number is locked for every address (otp_locked_today) until the oldest wrong code leaves the window or an admin
 * unlocks it. Owner 2026-11-16 (OQ-1 "Lock at 60 for 24 h", OQ-2 "Keep fixed in server"): 4 × the default 15 = 60,
 * for up to 24 h, a server constant (not an admin setting).
 */
export const PHONE_WRONG_CODES_CEILING_FACTOR = 4;

async function wrongCodesTodayAllAddresses(ex: Executor, phone: string, now: Date): Promise<{ wrong: number; oldest: Date | null }> {
  const dayAgo = new Date(now.getTime() - 24 * 3_600_000);
  const row = await ex
    .selectFrom("otp_sessions")
    .select([sql<string>`coalesce(sum(attempts - (CASE WHEN verified THEN 1 ELSE 0 END)), 0)`.as("wrong"), sql<Date | null>`min(created_at) FILTER (WHERE attempts > (CASE WHEN verified THEN 1 ELSE 0 END))`.as("oldest")])
    .where("phone", "=", phone)
    .where("unlocked_at", "is", null)
    .where("created_at", ">", dayAgo)
    .executeTakeFirstOrThrow();
  return { wrong: Number(row.wrong), oldest: row.oldest ? new Date(row.oldest) : null };
}

function lockedToday(oldest: Date | null, now: Date): ApiError {
  const wait = oldest ? (oldest.getTime() + 24 * 3_600_000 - now.getTime()) / 1000 : 3600;
  return rateLimited("Too many wrong codes for this number today. Try again later.", wait, "otp_locked_today");
}
export const ACCESS_TTL_SECONDS = AUTH.tokens.accessExpiresSeconds;
export const REFRESH_TTL_MS = AUTH.tokens.refreshExpiresDays * 24 * 60 * 60 * 1000;
export const TEST_CODE = AUTH.testSignIn.code;
/**
 * A refresh answer lost on a bad connection makes the app send the same refresh token again. Within this
 * window that is a retry, not theft: the unused replacement is dropped and a new pair is issued. v0.18.49 §71
 * (owner Q6): later than the window, still while the replacement was never used, it is accepted ONCE more
 * (contract.json#auth.tokens.lostAnswer); the window then runs again from that answer.
 */
export const REFRESH_RETRY_WINDOW_MS = AUTH.tokens.refreshRetryWindowSeconds * 1000; // v0.18.5 (G1-B6): 60 s, contract.json#auth.tokens.refreshRetry

export type App = "rider" | "driver";

export type AuthDeps = {
  db: Db;
  jwtSecret: string;
  /** Test numbers work only when this is true (never on production). */
  testSignInEnabled: boolean;
  /**
   * Owner 2026-11-04 (load test): on STAGING only, a test number (no real SMS) skips the resend wait and the hourly
   * code limits (per number, per address); a safety cap of TEST_CODES_PER_MINUTE per number stays. app.ts sets it
   * only when MOVERA_ENV is staging, and requestOtp also ignores it unless testSignInEnabled, so production never has it.
   */
  fastTestSignIn?: boolean;
  /** Apple / Google token verifiers, one per provider with client ids set. */
  providers?: Partial<Record<Provider, ProviderVerifier>> | undefined;
  /** G30b (owner Q1): the e-mail service for the e-mail change codes (Resend); none = delivery pending_provider. */
  email?: EmailSender | undefined;
  /** B1.27 rule: the e-mail change code is written to the log only on a developer's laptop (MOVERA_ENV development). */
  logCodes?: boolean;
  /**
   * v0.18.133 (contract.json#smsSignIn): the sender of the sign-in code SMS (46elks when both keys are set; tests
   * inject a fake). None: every number that is not a test number is sign_in_restricted, as before.
   */
  signInSms?: CodeSmsSender | undefined;
  /** For the SMS flow's warnings; never given the code or a full phone number. */
  warn?: ((data: Record<string, unknown>, message: string) => void) | undefined;
  clock?: () => Date;
};

export const LINK_TOKEN_TTL_MS = 15 * 60_000;

export type ClientInfo = { ip?: string | undefined; userAgent?: string | undefined };

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const codeHash = (sessionId: string, code: string) => sha256(`${sessionId}:${code}`);
/**
 * v0.18.133: a real (SMS) code is kept as a keyed hash (HMAC with the server's secret), so the 1 000 000 possible codes
 * cannot be tried against a copy of the table alone. A test number's code keeps the plain hash (the code is public).
 */
const smsCodeHash = (secret: string, sessionId: string, code: string) => createHmac("sha256", secret).update(`otp-sms:${sessionId}:${code}`).digest("hex");

/** Whether `code` is this session's code; the compare takes the same time for a right and a wrong code. */
export function otpCodeMatches(deps: Pick<AuthDeps, "jwtSecret">, session: { session_id: string; code_sha256: string; is_test: boolean }, code: string): boolean {
  return sameHash(session.code_sha256, session.is_test ? codeHash(session.session_id, code) : smsCodeHash(deps.jwtSecret, session.session_id, code));
}

/**
 * A random code for a real number: SMS_CODE_LENGTH digits (6; contract.json#smsSignIn.codeLength, owner 2026-11-19
 * "6 digits (Rec.)") from the cryptographic source, every value equally likely, and never the public test code.
 */
function randomCode(): string {
  for (;;) {
    const code = String(randomInt(0, 10 ** SMS_CODE_LENGTH)).padStart(SMS_CODE_LENGTH, "0");
    if (code !== TEST_CODE) return code;
  }
}

/**
 * The shapes a code can have: the test code's length (auth.otp.codeLength, 4) or an SMS code's (6). Anything else is
 * refused before the session is read (400 invalid_otp_code, not counted, as before). A code of the other length than
 * the session's goes on to the compare: it never matches (the hash holds the whole code), so it is a counted wrong code.
 */
const CODE_LENGTHS = [...new Set([OTP.codeLength, SMS_CODE_LENGTH])].sort((a, b) => a - b);
const CODE_SHAPE = new RegExp(`^(?:${CODE_LENGTHS.map((n) => `[0-9]{${n}}`).join("|")})$`);
/** Throws 400 invalid_otp_code unless `code` is 4 or 6 digits (contract.json#smsSignIn.codeLengthNote). */
export function checkCodeShape(code: string): void {
  if (!CODE_SHAPE.test(code)) throw badRequest(`The code is ${CODE_LENGTHS.join(" or ")} digits.`, "invalid_otp_code");
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

function rateLimited(message: string, retryAfterSeconds: number, reason: string): ApiError {
  return new ApiError("rate_limited", message, { reason, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterSeconds)) });
}

/** Safety cap for fastTestSignIn: codes per test number per minute. */
export const TEST_CODES_PER_MINUTE = 30;

export const PHONE = /^\+[1-9][0-9]{6,14}$/;

/* ---------------------------------------------------------------- request a code */

/** codeLength (v0.18.133): how many digits THIS code has, so the apps show that many boxes: 4 test code, 6 SMS code. */
export type OtpChallenge = { requestId: string; sessionId: string; expiresAt: string; retryAfterSeconds: number; codeLength: number };

export async function requestOtp(
  deps: AuthDeps,
  input: { phone: string; app: App; locale?: string | undefined; linkToken?: string | undefined; requestId: string },
  client: ClientInfo,
): Promise<OtpChallenge> {
  const now = deps.clock?.() ?? new Date();
  if (!PHONE.test(input.phone)) throw badRequest("Send the phone number in international form, e.g. +46701234567.", "invalid_phone");
  if (input.linkToken !== undefined) await loadLinkToken(deps.db, input.linkToken, input.app, now);

  let capHit = false;
  const started = await deps.db.transaction().execute(async (trx): Promise<{ challenge: OtpChallenge; sms?: PendingSms }> => {
    // One sign-in start at a time per phone and app, so the resend and hourly limits cannot be raced.
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`otp:${input.app}:${input.phone}`}))`.execute(trx);

    const isTest = deps.testSignInEnabled && (await isTestPhone(trx, input.phone, input.app));
    // v0.18.133 (contract.json#smsSignIn.active): a real number only with an SMS sender, a served country's MOBILE
    // number and that country's switch on; otherwise the same answer as ever.
    const country = isTest ? null : smsCountryOf(input.phone);
    const setting = !isTest && deps.signInSms !== undefined && country !== null ? await smsSignInFor(trx, country) : undefined;
    if (!isTest && (country === null || setting === undefined || !setting.enabled)) {
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
    const fast = isTest && deps.testSignInEnabled && deps.fastTestSignIn === true;
    if (fast) {
      const minuteAgo = now.getTime() - 60_000;
      const lastMinute = recent.filter((row) => row.created_at.getTime() > minuteAgo);
      if (lastMinute.length >= TEST_CODES_PER_MINUTE) {
        const oldest = lastMinute[lastMinute.length - 1]!;
        throw rateLimited("Too many codes for this number. Try again later.", (oldest.created_at.getTime() + 60_000 - now.getTime()) / 1000, "otp_too_many");
      }
    }
    const last = fast ? undefined : recent[0];
    if (last !== undefined) {
      const waited = (now.getTime() - last.created_at.getTime()) / 1000;
      if (waited < OTP.retryAfterSeconds) {
        throw rateLimited("Wait a moment before asking for a new code.", OTP.retryAfterSeconds - waited, "otp_resend_too_soon");
      }
    }
    const limits = await countryLimitsFor(trx, countryOfPhone(input.phone));
    if (!fast && recent.length >= limits.codesPerPhonePerHour) {
      const oldest = recent[recent.length - 1]!;
      throw rateLimited("Too many codes for this number. Try again later.", (oldest.created_at.getTime() + 3_600_000 - now.getTime()) / 1000, "otp_too_many");
    }
    const today = await wrongCodesToday(trx, input.phone, client.ip, now);
    if (today.wrong >= limits.wrongCodesPerDay) throw lockedToday(today.oldest, now);
    const everywhere = await wrongCodesTodayAllAddresses(trx, input.phone, now);
    if (everywhere.wrong >= limits.wrongCodesPerDay * PHONE_WRONG_CODES_CEILING_FACTOR) throw lockedToday(everywhere.oldest, now);
    if (client.ip !== undefined && !fast) {
      const fromIp = await trx
        .selectFrom("otp_sessions")
        .select((eb) => [eb.fn.countAll<string>().as("n"), eb.fn.min("created_at").as("oldest")])
        .where("ip", "=", client.ip)
        .where("created_at", ">", hourAgo)
        .executeTakeFirstOrThrow();
      if (Number(fromIp.n) >= limits.codesPerAddressPerHour) {
        // The real wait: until the oldest code from this address leaves the hour window.
        const oldest = new Date(fromIp.oldest as Date | string).getTime();
        throw rateLimited("Too many sign-in attempts. Try again later.", (oldest + 3_600_000 - now.getTime()) / 1000, "otp_too_many");
      }
    }

    // v0.18.133 (contract.json#smsSignIn.dailyCap): the cost guard, after every other limit and right before the
    // SMS is booked. One at a time per country, so parallel requests cannot pass the limit together. Fail closed.
    let smsCount = 0;
    if (!isTest && country !== null && setting !== undefined) {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`sms-cap:${country}`}))`.execute(trx);
      const day = await signInSmsLastDay(trx, country, now);
      if (day.count >= setting.dailyCap) {
        capHit = true;
        const wait = day.oldest ? (day.oldest.getTime() + DAY_MS - now.getTime()) / 1000 : DAY_MS / 1000;
        throw new ApiError("unavailable", "We cannot send more SMS codes right now. Try again later.", { reason: "sms_daily_limit", retryAfterSeconds: Math.min(DAY_MS / 1000, Math.max(1, Math.ceil(wait))) });
      }
      smsCount = day.count + 1;
    }

    const sessionId = newId("otp", now.getTime());
    // A test number's code is the fixed one; any other number gets a random code by SMS.
    const code = isTest ? TEST_CODE : randomCode();
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
        code_sha256: isTest ? codeHash(sessionId, code) : smsCodeHash(deps.jwtSecret, sessionId, code),
        is_test: isTest,
        locale: input.locale ?? null,
        ip: client.ip ?? null,
        max_attempts: OTP.maxAttempts,
        expires_at: expiresAt,
        created_at: now,
      })
      .execute();
    const challenge = { requestId: input.requestId, sessionId, expiresAt: expiresAt.toISOString(), retryAfterSeconds: fast ? 0 : OTP.retryAfterSeconds, codeLength: code.length };
    if (isTest || country === null || setting === undefined) return { challenge };
    // The SMS is booked with the code (same transaction) and handed to the SMS company after the commit, so no
    // database connection or lock waits on the company. The stored text has dots in place of the code.
    const lang = smsLanguage(input.locale, country);
    const smsId = newId("sms", now.getTime());
    await trx.insertInto("sms_outbox").values({ sms_id: smsId, phone: input.phone, text: storedSmsText(lang), kind: SIGN_IN_SMS_KIND, status: "queued", provider: deps.signInSms!.name, created_at: now }).execute();
    return { challenge, sms: { smsId, sessionId, to: input.phone, text: signInSmsText(lang, code), atAlertLine: smsCount === nearCap(setting.dailyCap) || smsCount === setting.dailyCap } };
  }).catch(async (error: unknown) => {
    // The refusal rolled its transaction back; the admin alert is asked for on its own (smsSignIn.alert).
    if (capHit) await pokeAlerts(deps.db, now).catch(() => undefined);
    throw error;
  });
  if (started.sms !== undefined) await deliverSignInSms(deps, started.sms, now);
  return started.challenge;
}

/** How long the last real hand-over to the SMS company took, per sender (for {@link silentSmsWait}). */
const lastSmsSendMs = new WeakMap<CodeSmsSender, number>();
export const SILENT_SMS_WAIT_DEFAULT_MS = 300;
export const SILENT_SMS_WAIT_MAX_MS = 8000;

/**
 * For a caller that answers "code sent" WITHOUT sending one (the phone change to a number that already has an account,
 * accountChange.ts): when a real SMS would have gone to this number, wait about as long as a real send takes, so the
 * answer time does not tell that the number has an account. No sender, not a served mobile number, or the country's
 * switch off: no wait (the real path would not have sent either).
 *
 * Answers how many digits the code of a real answer for this number would have (OtpChallenge.codeLength), so the
 * silent answer does not differ there either: 6 when an SMS would have gone out, else the test code's 4.
 */
export async function silentSmsWait(deps: AuthDeps, phone: string, app: App): Promise<number> {
  const country = deps.signInSms === undefined ? null : smsCountryOf(phone);
  if (deps.signInSms === undefined || country === null) return OTP.codeLength;
  if (deps.testSignInEnabled && (await isTestPhone(deps.db, phone, app))) return OTP.codeLength;
  if (!(await smsSignInFor(deps.db, country)).enabled) return OTP.codeLength;
  const ms = Math.min(SILENT_SMS_WAIT_MAX_MS, lastSmsSendMs.get(deps.signInSms) ?? SILENT_SMS_WAIT_DEFAULT_MS);
  await new Promise((resolve) => setTimeout(resolve, ms));
  return SMS_CODE_LENGTH;
}

type PendingSms = { smsId: string; sessionId: string; to: string; text: string; atAlertLine: boolean };

/**
 * contract.json#smsSignIn.delivery: one try. Accepted: the row is `sent`. Anything else: the row is `failed`, the code
 * is void at once, and the person is told to ask again (503 sms_not_sent, after the usual resend wait). The try still
 * counts on the hourly limits. Neither the code nor the full number reaches the log.
 */
async function deliverSignInSms(deps: AuthDeps, sms: PendingSms, now: Date): Promise<void> {
  const began = Date.now();
  const outcome = await deps.signInSms!.send({ to: sms.to, text: sms.text }).catch(() => ({ accepted: false }) as { accepted: boolean; status?: number; ref?: string });
  lastSmsSendMs.set(deps.signInSms!, Date.now() - began);
  if (outcome.accepted) {
    await deps.db.updateTable("sms_outbox").set({ status: "sent", provider_ref: outcome.ref ?? null, sent_at: now }).where("sms_id", "=", sms.smsId).execute();
    if (sms.atAlertLine) await pokeAlerts(deps.db, now).catch(() => undefined);
    return;
  }
  await deps.db.transaction().execute(async (trx) => {
    await trx.updateTable("sms_outbox").set({ status: "failed", error: outcome.status !== undefined ? `http_${outcome.status}` : SMS_NO_ANSWER }).where("sms_id", "=", sms.smsId).execute();
    await trx.updateTable("otp_sessions").set({ consumed_at: now }).where("session_id", "=", sms.sessionId).where("consumed_at", "is", null).execute();
  });
  deps.warn?.({ smsId: sms.smsId, to: maskPhone(sms.to), provider: deps.signInSms!.name, ...(outcome.status !== undefined ? { status: outcome.status } : {}) }, "sign-in SMS not sent");
  throw new ApiError("unavailable", "We could not send the SMS. Check the number and try again.", { reason: "sms_not_sent", retryAfterSeconds: OTP.retryAfterSeconds });
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
  input: { phone: string; sessionId: string; code: string; linkToken?: string | undefined },
  client: ClientInfo,
): Promise<AuthTokens> {
  const now = deps.clock?.() ?? new Date();
  if (!PHONE.test(input.phone)) throw badRequest("Send the phone number in international form, e.g. +46701234567.", "invalid_phone");
  checkCodeShape(input.code);

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
    // Deep fix 2026-11-02 (g1-g3 H2): a number with wrongCodesPerDay wrong codes in 24 h is locked, even with the right code.
    const limits = await countryLimitsFor(trx, countryOfPhone(session.phone));
    const today = await wrongCodesToday(trx, session.phone, client.ip, now);
    if (today.wrong >= limits.wrongCodesPerDay) return { ok: false, error: lockedToday(today.oldest, now) };
    const ceiling = limits.wrongCodesPerDay * PHONE_WRONG_CODES_CEILING_FACTOR;
    const everywhere = await wrongCodesTodayAllAddresses(trx, session.phone, now);
    if (everywhere.wrong >= ceiling) return { ok: false, error: lockedToday(everywhere.oldest, now) };
    if (!otpCodeMatches(deps, session, input.code)) {
      const attempts = session.attempts + 1;
      await trx.updateTable("otp_sessions").set({ attempts }).where("session_id", "=", session.session_id).execute();
      if (today.wrong + 1 >= limits.wrongCodesPerDay) return { ok: false, error: lockedToday(today.oldest ?? session.created_at, now) };
      if (everywhere.wrong + 1 >= ceiling) return { ok: false, error: lockedToday(everywhere.oldest ?? session.created_at, now) };
      // v0.18.5 (G1-B3, owner "Fix it (Recommended)"): counted before the answer, so the wrong code that reaches
      // maxAttempts (the 5th) already says "Too many wrong tries".
      if (attempts >= session.max_attempts) return { ok: false, error: rateLimited("Too many wrong codes. Ask for a new code.", OTP.retryAfterSeconds, "otp_too_many_attempts") };
      return { ok: false, error: badRequest("That code is not right.", "invalid_otp_code") };
    }
    await trx.updateTable("otp_sessions").set({ consumed_at: now, attempts: session.attempts + 1, verified: true }).where("session_id", "=", session.session_id).execute();

    const link = input.linkToken !== undefined ? await loadLinkToken(trx, input.linkToken, session.app, now) : undefined;
    const account = await findOrCreateAccount(trx, session.app, session.phone, now);
    if (link !== undefined) await linkProvider(trx, link, session.app, account, now);
    const { sessionId: _sid, ...tokens } = await startSession(trx, deps, { actor: session.app, subjectId: account.id, zones: account.zones }, client, now);
    void _sid;
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
    const rider = await trx.selectFrom("riders").select(["rider_id", "status", "moderation_level", "moderation_reason", "moderation_until", "moderation_set_at", "deletion_requested_at", "erased_at"]).where("phone", "=", phone).executeTakeFirstOrThrow();
    // v0.18.134 (contract.json#accountDeletion.closeAtOnce): a closed account cannot sign in until it is erased.
    if (isClosed(rider)) throw closedError();
    if (riderBlocked(rider, now)) throw suspendedError(rider);
    return { id: rider.rider_id, created: false, zones: [] };
  }
  const inserted = await trx
    .insertInto("drivers")
    .values({ driver_id: newId("drv", now.getTime()), phone, online_since: null, vehicle_id: null, scheduled_rides: null })
    .onConflict((conflict) => conflict.column("phone").doNothing())
    .returning("driver_id")
    .executeTakeFirst();
  if (inserted !== undefined) {
    // v0.5.3: a fleet owner may have invited this number before it had an account.
    await attachInvitesToNewDriver(trx, inserted.driver_id, phone, now);
    return { id: inserted.driver_id, created: true, zones: [] };
  }
  // A suspended driver still signs in: the driver app shows its Suspended screen (contract §6 account status).
  const driver = await trx.selectFrom("drivers").select(["driver_id", "zone_ids", "deletion_requested_at", "erased_at"]).where("phone", "=", phone).executeTakeFirstOrThrow();
  if (isClosed(driver)) throw closedError();
  return { id: driver.driver_id, created: false, zones: driver.zone_ids };
}

/* ---------------------------------------------------------------- Apple / Google */

type LinkTokenRow = { token_sha256: string; provider: Provider; provider_subject: string; app: App; first_name: string | null; last_name: string | null; email: string | null; email_verified: boolean; expires_at: Date; used_at: Date | null };

export type PhoneRequired = { code: "PHONE_REQUIRED"; linkToken: string; name?: string; firstName?: string; lastName?: string; email?: string };

/** POST /auth/provider: AuthTokens for a linked identity, PHONE_REQUIRED (with a link token) for a new one. */
export async function signInWithProvider(
  deps: AuthDeps,
  input: { provider: Provider; idToken: string; app: App; name?: string | undefined },
  client: ClientInfo,
): Promise<AuthTokens | PhoneRequired> {
  const now = deps.clock?.() ?? new Date();
  const verifier = deps.providers?.[input.provider];
  if (verifier === undefined) {
    throw new ApiError("unavailable", `Sign-in with ${input.provider === "apple" ? "Apple" : "Google"} is coming soon. Use your phone number.`, { reason: "provider_not_configured" });
  }
  const identity: ProviderIdentity = await verifier.verify(input.idToken, now);
  // Apple puts no name in its token: the app sends what Apple showed it, the first time.
  const named = splitName(input.name);
  const firstName = identity.firstName ?? named.firstName;
  const lastName = identity.lastName ?? named.lastName;
  return deps.db.transaction().execute(async (trx): Promise<AuthTokens | PhoneRequired> => {
    const link = await trx.selectFrom("auth_provider_links").selectAll().where("provider", "=", input.provider).where("provider_subject", "=", identity.subject).where("actor", "=", input.app).executeTakeFirst();
    if (link !== undefined) {
      const account = await existingAccount(trx, input.app, link.subject_id, now);
      if (account !== undefined) {
        const { sessionId: _sid, ...tokens } = await startSession(trx, deps, { actor: input.app, subjectId: account.id, zones: account.zones }, client, now);
        void _sid;
        return { ...tokens, actor: input.app, ...(input.app === "rider" ? { isNewRider: false } : { isNewDriver: false }) };
      }
      // The account went away; the link is stale.
      await trx.deleteFrom("auth_provider_links").where("provider", "=", input.provider).where("provider_subject", "=", identity.subject).where("actor", "=", input.app).execute();
    }
    const linkToken = `lt_${randomBytes(32).toString("base64url")}`;
    await trx
      .insertInto("auth_link_tokens")
      .values({
        token_sha256: sha256(linkToken),
        provider: input.provider,
        provider_subject: identity.subject,
        app: input.app,
        first_name: firstName ?? null,
        last_name: lastName ?? null,
        email: identity.email ?? null,
        // G30 (owner Q4): Apple / Google said it checked this e-mail.
        email_verified: identity.email !== undefined && identity.emailVerified === true,
        expires_at: new Date(now.getTime() + LINK_TOKEN_TTL_MS),
        created_at: now,
      })
      .execute();
    const fullName = [firstName, lastName].filter(Boolean).join(" ");
    return {
      code: "PHONE_REQUIRED",
      linkToken,
      ...(fullName ? { name: fullName } : {}),
      ...(firstName ? { firstName } : {}),
      ...(lastName ? { lastName } : {}),
      ...(identity.email ? { email: identity.email } : {}),
    };
  });
}

async function existingAccount(ex: Executor, app: App, subjectId: string, now: Date): Promise<{ id: string; zones: string[] } | undefined> {
  if (app === "rider") {
    const rider = await ex.selectFrom("riders").select(["rider_id", "status", "moderation_level", "moderation_reason", "moderation_until", "moderation_set_at", "deletion_requested_at", "erased_at"]).where("rider_id", "=", subjectId).executeTakeFirst();
    if (rider === undefined) return undefined;
    if (isClosed(rider)) throw closedError();
    if (riderBlocked(rider, now)) throw suspendedError(rider);
    return { id: rider.rider_id, zones: [] };
  }
  const driver = await ex.selectFrom("drivers").select(["driver_id", "zone_ids", "deletion_requested_at", "erased_at"]).where("driver_id", "=", subjectId).executeTakeFirst();
  if (driver !== undefined && isClosed(driver)) throw closedError();
  return driver === undefined ? undefined : { id: driver.driver_id, zones: driver.zone_ids };
}

async function loadLinkToken(ex: Executor, linkToken: string, app: App, now: Date): Promise<LinkTokenRow> {
  const row = (await ex.selectFrom("auth_link_tokens").selectAll().where("token_sha256", "=", sha256(linkToken)).executeTakeFirst()) as LinkTokenRow | undefined;
  if (row === undefined || row.app !== app || row.used_at !== null || row.expires_at.getTime() <= now.getTime()) {
    throw badRequest("This sign-in link is not valid. Start again with Apple or Google, or sign in with your phone number.", "invalid_link_token");
  }
  return row;
}

/** The verified phone's account gets the provider identity; a new account also gets the provider's names and e-mail. */
async function linkProvider(trx: Trx, link: LinkTokenRow, app: App, account: { id: string; created: boolean }, now: Date): Promise<void> {
  await trx
    .insertInto("auth_provider_links")
    .values({ provider: link.provider, provider_subject: link.provider_subject, actor: app, subject_id: account.id, email: link.email, created_at: now })
    .onConflict((c) => c.columns(["provider", "provider_subject", "actor"]).doUpdateSet({ subject_id: account.id, email: link.email, created_at: now }))
    .execute();
  await trx.updateTable("auth_link_tokens").set({ used_at: now }).where("token_sha256", "=", link.token_sha256).execute();
  if (!account.created) return;
  // G30 v0.18.76 (contract.json#emailVerified.writePaths.provider, owner Q4): the provider e-mail, lower-cased, is
  // Verified (at account creation) when the provider's token said email_verified true — unless that address is
  // already verified on another account of the same app (emailVerified.unique); else Not verified.
  const email = link.email ? link.email.trim().toLowerCase() : null;
  // The same per-address lock as the code verify (accountChange.ts verifyEmailChange): a provider sign-up and a code
  // verify of one address queue, so two accounts of one app never both end up Verified (supervisor G30 nit c).
  if (email !== null && link.email_verified) await sql`SELECT pg_advisory_xact_lock(hashtext(${`email_verified:${app}:${email}`}))`.execute(trx);
  const verified = email !== null && link.email_verified && !(await emailTakenByOther(trx, app, account.id, email));
  const mail = email !== null ? { email, email_verified_at: verified ? now : null } : {};
  if (app === "driver") {
    await trx
      .updateTable("drivers")
      .set({ ...(link.first_name ? { first_name: link.first_name } : {}), ...(link.last_name ? { last_name: link.last_name } : {}), ...mail, updated_at: now })
      .where("driver_id", "=", account.id)
      .execute();
  } else {
    await trx
      .updateTable("riders")
      .set({ ...(link.first_name ? { first_name: [link.first_name, link.last_name].filter(Boolean).join(" ") } : {}), ...mail, updated_at: now })
      .where("rider_id", "=", account.id)
      .execute();
  }
}

/* ---------------------------------------------------------------- sessions and tokens */

type Subject = { actor: Actor; subjectId: string; zones: string[]; role?: string; perms?: readonly string[] };

function newRefreshToken(): string {
  return `rt_${randomBytes(32).toString("base64url")}`;
}

export async function startSession(
  trx: Trx,
  deps: Pick<AuthDeps, "jwtSecret">,
  subject: Subject,
  client: ClientInfo,
  now: Date,
  ttlMs: number = REFRESH_TTL_MS,
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number; sessionId: string }> {
  const sessionId = newId("sid", now.getTime());
  // v0.18.14 (owner 2026-11-02 "New sign-in signs the old phone out"): a driver is signed in on one phone only. A new
  // sign-in ends his other sessions (reason signed_in_elsewhere), sets the old phone offline (a free driver goes offline) and tells him (bell + push).
  if (subject.actor === "driver") await signOutOtherPhones(trx, subject.subjectId, now);
  const expiresAt = new Date(now.getTime() + ttlMs);
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
    accessToken: signAccessToken(
      { sub: subject.subjectId, actor: subject.actor, sid: sessionId, zones: subject.zones, ...(subject.role ? { role: subject.role, perms: [...(subject.perms ?? [])] } : {}) },
      deps.jwtSecret,
      ACCESS_TTL_SECONDS,
      now,
    ),
    refreshToken,
    expiresIn: ACCESS_TTL_SECONDS,
    sessionId,
  };
}

const unauthenticated = (reason: string) => new ApiError("unauthenticated", "Please sign in again.", { reason });

type Rotated = { ok: true; sessionId: string; actor: Actor; subjectId: string; refreshToken: string } | { ok: false; error: ApiError };

/**
 * Rotates a refresh token inside `trx`. A token used before is theft unless it is a lost answer: its replacement was
 * never used and it comes back either within REFRESH_RETRY_WINDOW_MS of its last use (a retry, as often as needed) or,
 * once, later than that (v0.18.49 §71 owner Q6, refresh_tokens.late_retry_at). Theft ends the whole session.
 * `actors` keeps the app and admin token families apart; `ttlMs` is the new token's lifetime.
 */
export async function rotateRefresh(trx: Trx, refreshToken: string, now: Date, options: { actors: readonly Actor[]; ttlMs: number }): Promise<Rotated> {
  const hash = sha256(refreshToken);
  // Lock order: the session first, then its tokens. Every refresh of a session queues on that one row, so two
  // refreshes at once (a retry and a normal one) wait for each other instead of deadlocking.
  const owner = await trx.selectFrom("refresh_tokens").select("session_id").where("token_sha256", "=", hash).executeTakeFirst();
  if (owner === undefined) return { ok: false, error: unauthenticated("refresh_token_unknown") };
  const session = await trx.selectFrom("auth_sessions").selectAll().where("session_id", "=", owner.session_id).forUpdate().executeTakeFirstOrThrow();
  const token = await trx.selectFrom("refresh_tokens").selectAll().where("token_sha256", "=", hash).forUpdate().executeTakeFirstOrThrow();
  if (!options.actors.includes(session.actor)) return { ok: false, error: unauthenticated("refresh_token_unknown") };
  if (session.revoked_at !== null) return { ok: false, error: unauthenticated(endedReason(session.revoked_reason)) };
  if (session.expires_at.getTime() <= now.getTime() || token.expires_at.getTime() <= now.getTime()) {
    return { ok: false, error: unauthenticated("session_expired") };
  }

  if (token.used_at !== null) {
    const replacement = token.replaced_by
      ? await trx.selectFrom("refresh_tokens").selectAll().where("token_sha256", "=", token.replaced_by).forUpdate().executeTakeFirst()
      : undefined;
    const unusedReplacement = replacement !== undefined && replacement.used_at === null;
    // The window runs from the token's last use: its first use, or the late answer it got (owner Q6).
    const lastUse = Math.max(token.used_at.getTime(), token.late_retry_at?.getTime() ?? 0);
    const isRetry = unusedReplacement && now.getTime() - lastUse <= REFRESH_RETRY_WINDOW_MS;
    // v0.18.49 §71 (owner Q6 "Accept lost answer"): later than the window, accepted once (D9: a dead zone > 60 s).
    const isLostAnswer = unusedReplacement && !isRetry && token.late_retry_at === null;
    if (!isRetry && !isLostAnswer) {
      await trx.updateTable("auth_sessions").set({ revoked_at: now, revoked_reason: "refresh_token_reused" }).where("session_id", "=", session.session_id).execute();
      // S4c fix 3: every copy forgets it now (session check cache).
      await sessionsRevoked(trx, [session.session_id]);
      return { ok: false, error: unauthenticated("refresh_token_reused") };
    }
    // Drop the replacement the app never received; it can no longer be used.
    await trx.updateTable("refresh_tokens").set({ used_at: now }).where("token_sha256", "=", replacement!.token_sha256).execute();
    if (isLostAnswer) await trx.updateTable("refresh_tokens").set({ late_retry_at: now }).where("token_sha256", "=", hash).execute();
  }

  const next = newRefreshToken();
  const nextHash = sha256(next);
  const expiresAt = new Date(now.getTime() + options.ttlMs);
  await trx.insertInto("refresh_tokens").values({ token_sha256: nextHash, session_id: session.session_id, expires_at: expiresAt, used_at: null, replaced_by: null, created_at: now }).execute();
  await trx.updateTable("refresh_tokens").set({ used_at: token.used_at ?? now, replaced_by: nextHash }).where("token_sha256", "=", hash).execute();
  await trx.updateTable("auth_sessions").set({ expires_at: expiresAt, last_refresh_at: now }).where("session_id", "=", session.session_id).execute();
  return { ok: true, sessionId: session.session_id, actor: session.actor, subjectId: session.subject_id, refreshToken: next };
}

/** The session a refresh token belongs to (used or not), for the write limit's key (S7 W2 Q118); none: unknown token. */
export async function refreshSessionOf(ex: Executor, refreshToken: string): Promise<string | undefined> {
  const row = await ex.selectFrom("refresh_tokens").select("session_id").where("token_sha256", "=", sha256(refreshToken)).executeTakeFirst();
  return row?.session_id;
}

type RefreshOutcome = { ok: true; tokens: AuthTokens } | { ok: false; error: ApiError };

/** POST /auth/refresh for the rider and driver apps. */
export async function refreshTokens(deps: AuthDeps, refreshToken: string): Promise<AuthTokens> {
  const now = deps.clock?.() ?? new Date();
  const outcome = await deps.db.transaction().execute(async (trx): Promise<RefreshOutcome> => {
    const rotated = await rotateRefresh(trx, refreshToken, now, { actors: ["rider", "driver"], ttlMs: REFRESH_TTL_MS });
    if (!rotated.ok) return rotated;
    const actor = rotated.actor as App;
    const zones = await currentZones(trx, actor, rotated.subjectId);
    return {
      ok: true,
      tokens: {
        accessToken: signAccessToken({ sub: rotated.subjectId, actor, sid: rotated.sessionId, zones }, deps.jwtSecret, ACCESS_TTL_SECONDS, now),
        refreshToken: rotated.refreshToken,
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

type SignOutOnTrip = { status: number; reason: string; texts: { finishTripFirst: Record<string, string> } };
const SIGN_OUT_ON_TRIP = (contract as unknown as { auth: { signOutOnTrip: SignOutOnTrip } }).auth.signOutOnTrip;

/**
 * v0.18.49 §71 (owner Q8 "Server refuses too", contract.json#auth.signOutOnTrip): a driver whose session is still
 * active cannot sign out while he has a current trip (the trip GET /driver/profile names as activeTripId: a
 * driverAssigned status, not a held booked ride, not a queued next trip). 409 conflict sign_out_on_trip, the text in
 * his language (else his country's, else English). Inside the sign-out transaction, with the driver row locked.
 */
async function refuseDriverSignOutOnTrip(trx: Trx, sessionId: string, driverId: string, now: Date): Promise<void> {
  const session = await trx.selectFrom("auth_sessions").select(["revoked_at", "expires_at"]).where("session_id", "=", sessionId).executeTakeFirst();
  if (session === undefined || session.revoked_at !== null || session.expires_at.getTime() <= now.getTime()) return;
  const driver = await trx.selectFrom("drivers").select(["language", "country"]).where("driver_id", "=", driverId).forUpdate().executeTakeFirst();
  if (driver === undefined) return;
  const trip = await trx.selectFrom("trips").select("trip_id").where("driver_id", "=", driverId).where("status", "in", [...DRIVER_ASSIGNED]).where(NOT_HELD).executeTakeFirst();
  if (trip === undefined) return;
  const texts = SIGN_OUT_ON_TRIP.texts.finishTripFirst;
  // v0.18.66 §87: the one language rule (his language, else his country's, TN fr, else en).
  const lang = pickNoticeLanguage(driver.language, driver.country);
  throw new ApiError("conflict", texts[lang]!, { reason: SIGN_OUT_ON_TRIP.reason });
}

/**
 * Ends the session and forgets its push devices. Repeating it is fine. A driver with a current trip is refused first
 * (v0.18.49 §71, owner Q8) when `driverId` is given (POST /auth/sign-out); nothing is ended then.
 */
export async function signOut(db: Db, sessionId: string, now: Date = new Date(), driverId?: string): Promise<void> {
  await db.transaction().execute(async (trx) => {
    if (driverId !== undefined) await refuseDriverSignOutOnTrip(trx, sessionId, driverId, now);
    await trx
      .updateTable("auth_sessions")
      .set({ revoked_at: now, revoked_reason: "signed_out" })
      .where("session_id", "=", sessionId)
      .where("revoked_at", "is", null)
      .execute();
    // S4c fix 3: refused at once on every copy (session check cache), also when it was ended before.
    await sessionsRevoked(trx, [sessionId]);
    await trx.deleteFrom("push_devices").where("session_id", "=", sessionId).execute();
  });
}

/**
 * Global plan step 38 (owner Q42, 2026-11-09 "Yes, at once"): an admin's rights live in the 15-minute access token, so a
 * role change or a deactivation ends EVERY open session of that admin now (reason role_changed / admin_deactivated);
 * the next admin call gets 401 session_ended, the refresh tokens are refused, and the admin signs in again.
 */
export async function endAdminSessions(ex: Executor, adminId: string, now: Date, reason: "role_changed" | "admin_deactivated"): Promise<number> {
  const ended = await ex.updateTable("auth_sessions").set({ revoked_at: now, revoked_reason: reason }).where("actor", "=", "admin").where("subject_id", "=", adminId).where("revoked_at", "is", null).returning("session_id").execute();
  return ended.length;
}

/**
 * The 401 reason for an ended session (contract.json#auth.signedOut.reasons): the other phone (v0.18.14), an admin
 * sign-out (v0.18.149, owner G12 Q6: "You were signed out by Movera"), else session_ended.
 */
export function endedReason(revokedReason: string | null | undefined): "signed_in_elsewhere" | "signed_out_by_movera" | "session_ended" {
  return revokedReason === "signed_in_elsewhere" || revokedReason === "signed_out_by_movera" ? revokedReason : "session_ended";
}

/** True while the session behind an access token is neither signed out nor expired. */
export async function sessionIsActive(ex: Executor, sessionId: string, now: Date = new Date()): Promise<boolean> {
  const row = await ex.selectFrom("auth_sessions").select(["revoked_at", "expires_at"]).where("session_id", "=", sessionId).executeTakeFirst();
  return row !== undefined && row.revoked_at === null && row.expires_at.getTime() > now.getTime();
}

const ELSEWHERE = { sv: { title: "Inloggad på en annan telefon", body: "Ditt konto loggades in på en annan telefon. Den här telefonen loggades ut." }, fr: { title: "Connecté sur un autre téléphone", body: "Votre compte s’est connecté sur un autre téléphone. Ce téléphone a été déconnecté." }, en: { title: "Signed in on another phone", body: "Your account signed in on another phone. This phone was signed out." } } as const;

async function signOutOtherPhones(trx: Trx, driverId: string, now: Date): Promise<void> {
  const ended = await trx.updateTable("auth_sessions").set({ revoked_at: now, revoked_reason: "signed_in_elsewhere" }).where("actor", "=", "driver").where("subject_id", "=", driverId).where("revoked_at", "is", null).where("expires_at", ">", now).returning("session_id").execute();
  if (ended.length === 0) return;
  // S4c fix 3: the old phone is refused at once on every copy (session check cache).
  await sessionsRevoked(trx, ended.map((r) => r.session_id));
  // Decision (driver-g1.md): the OLD phone goes offline — a free driver is set offline (offers withdrawn) and goes
  // online again from the new phone; one on a trip keeps it (the new phone carries on with it).
  const driver = await trx.selectFrom("drivers").select(["language", "online_status", "version"]).where("driver_id", "=", driverId).executeTakeFirst();
  if (driver?.online_status === "online") {
    await trx.updateTable("drivers").set({ online_status: "offline", online_since: null, version: driver.version + 1, updated_at: now }).where("driver_id", "=", driverId).execute();
    await trx.insertInto("timers").values({ kind: "withdraw_driver_offers", ref_id: driverId, due_at: now, payload: JSON.stringify({}) }).onConflict((c) => c.columns(["kind", "ref_id"]).doUpdateSet({ due_at: now })).execute();
  }
  // v0.18.66 §87: the one notice-language rule (his language, else his zone's country, TN fr, else en).
  const lang = await noticeLanguage(trx, { actor: "driver", id: driverId, language: driver?.language ?? null });
  await notify(trx, { audience: "driver", subjectId: driverId, kind: "signed_in_elsewhere", title: ELSEWHERE[lang].title, body: ELSEWHERE[lang].body, data: { texts: { title: { sv: ELSEWHERE.sv.title, fr: ELSEWHERE.fr.title, en: ELSEWHERE.en.title }, body: { sv: ELSEWHERE.sv.body, fr: ELSEWHERE.fr.body, en: ELSEWHERE.en.body } } } }, now);
}

/** POST /admin/auth/sign-in-locks/unlock { phone }: lifts every wrong-code lock of the number (all addresses), audited. */
export async function unlockSignIn(trx: Trx, adminId: string, phone: string, now: Date): Promise<{ phone: string; lifted: number }> {
  if (!PHONE.test(phone)) throw badRequest("Send the phone number in international form, e.g. +46701234567.", "invalid_phone");
  const rows = await trx.updateTable("otp_sessions").set({ unlocked_at: now }).where("phone", "=", phone).where("unlocked_at", "is", null).where("created_at", ">", new Date(now.getTime() - 24 * 3_600_000)).returning("session_id").execute();
  await audit(trx, { adminId, action: "auth.sign_in_unlock", targetType: "phone", targetId: phone.slice(0, -4) + "••••", detail: { lifted: rows.length }, at: now });
  return { phone, lifted: rows.length };
}
