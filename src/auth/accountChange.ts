import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import type { Db, Executor, Trx } from "../db/db.js";
import { ApiError, badRequest } from "../http/errors.js";
import { newId } from "../ids.js";
import { notify } from "../notifications/service.js";
import { OTP, PHONE, requestOtp, type AuthDeps, type ClientInfo } from "./service.js";

/**
 * v0.18.14 (owner 2026-11-02, decisions/driver-g1.md "Phone number change" / "E-mail change"): a driver or rider changes
 * his phone number or e-mail himself. New value → a code is sent to it → the code saves it; the account, documents and
 * history stay. Checker round (MED 3–6):
 * - only within RECENT_SIGN_IN_MS of signing in on this phone (403 reauth_required: sign in again first);
 * - at most STARTS_PER_HOUR starts per account and kind (429 rate_limited reason change_too_many);
 * - a number / address that already has an account (rider or driver) gets the same "code sent" answer and no code, so the
 *   answer never tells whether someone uses it; the verify then fails like a wrong session;
 * - wrong-code attempts count over the hour, a restart never resets them;
 * - after the change: a notice to the OLD number / OLD address (recorded as pending until an SMS / e-mail provider is
 *   connected), an in-app notice, and every other session of the account ends.
 */

type Who = { actor: "rider" | "driver"; subjectId: string; sessionId: string };
export const RECENT_SIGN_IN_MS = 10 * 60_000;
export const STARTS_PER_HOUR = 3;
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const table = (actor: Who["actor"]) => (actor === "rider" ? "riders" : "drivers");
const idCol = (actor: Who["actor"]) => (actor === "rider" ? "rider_id" : "driver_id");
const hourAgo = (now: Date) => new Date(now.getTime() - 3_600_000);

async function checkStart(ex: Executor, who: Who, kind: "phone" | "email", now: Date): Promise<void> {
  const session = await ex.selectFrom("auth_sessions").select("created_at").where("session_id", "=", who.sessionId).executeTakeFirst();
  if (!session || now.getTime() - session.created_at.getTime() > RECENT_SIGN_IN_MS) {
    throw new ApiError("forbidden", "Sign in again on this phone, then change it within 10 minutes.", { reason: "reauth_required" });
  }
  const starts = await ex.selectFrom("account_change_starts").select((eb) => eb.fn.countAll<string>().as("n")).where("actor", "=", who.actor).where("subject_id", "=", who.subjectId).where("kind", "=", kind).where("at", ">", hourAgo(now)).executeTakeFirstOrThrow();
  if (Number(starts.n) >= STARTS_PER_HOUR) throw new ApiError("rate_limited", "Too many changes. Try again later.", { reason: "change_too_many", retryAfterSeconds: 3600 });
  await ex.insertInto("account_change_starts").values({ actor: who.actor, subject_id: who.subjectId, kind, at: now }).execute();
}

async function phoneHasAccount(ex: Executor, phone: string): Promise<boolean> {
  const r = await ex.selectFrom("riders").select("rider_id").where("phone", "=", phone).executeTakeFirst();
  const d = await ex.selectFrom("drivers").select("driver_id").where("phone", "=", phone).executeTakeFirst();
  return r !== undefined || d !== undefined;
}
async function emailHasAccount(ex: Executor, email: string): Promise<boolean> {
  const r = await ex.selectFrom("riders").select("rider_id").where("email", "=", email).executeTakeFirst();
  const d = await ex.selectFrom("drivers").select("driver_id").where("email", "=", email).executeTakeFirst();
  return r !== undefined || d !== undefined;
}

export async function startPhoneChange(deps: AuthDeps, who: Who, phone: string, client: ClientInfo, now: Date) {
  if (!PHONE.test(phone)) throw badRequest("Send the phone number in international form, e.g. +46701234567.", "invalid_phone");
  await checkStart(deps.db, who, "phone", now);
  if (await phoneHasAccount(deps.db, phone)) {
    // The same answer as a sent code (no code is sent): nobody learns that this number has an account.
    return { requestId: newId("otp"), sessionId: newId("otp", now.getTime()), expiresAt: new Date(now.getTime() + OTP.expiresSeconds * 1000).toISOString(), retryAfterSeconds: OTP.retryAfterSeconds };
  }
  return requestOtp(deps, { phone, app: who.actor, requestId: newId("otp") }, client);
}

export async function verifyPhoneChange(deps: AuthDeps, who: Who, input: { phone: string; sessionId: string; code: string }, now: Date) {
  if (!new RegExp(`^[0-9]{${OTP.codeLength}}$`).test(input.code)) throw badRequest(`The code is ${OTP.codeLength} digits.`, "invalid_otp_code");
  const outcome = await deps.db.transaction().execute(async (trx) => {
    const s = await trx.selectFrom("otp_sessions").selectAll().where("session_id", "=", input.sessionId).forUpdate().executeTakeFirst();
    if (!s || s.phone !== input.phone || s.app !== who.actor || s.consumed_at !== null) return badRequest("This code is not active. Ask for a new one.", "invalid_otp_session");
    if (s.expires_at.getTime() <= now.getTime()) return new ApiError("otp_expired", "The code expired. Ask for a new one.");
    if (s.attempts >= s.max_attempts) return new ApiError("rate_limited", "Too many wrong codes. Ask for a new code.", { reason: "otp_too_many_attempts", retryAfterSeconds: OTP.retryAfterSeconds });
    if (!same(s.code_sha256, sha(`${s.session_id}:${input.code}`))) {
      await trx.updateTable("otp_sessions").set({ attempts: s.attempts + 1 }).where("session_id", "=", s.session_id).execute();
      return badRequest("That code is not right.", "invalid_otp_code");
    }
    await trx.updateTable("otp_sessions").set({ consumed_at: now, attempts: s.attempts + 1, verified: true }).where("session_id", "=", s.session_id).execute();
    if (await phoneHasAccount(trx, input.phone)) return badRequest("This code is not active. Ask for a new one.", "invalid_otp_session");
    const before = await trx.selectFrom(table(who.actor) as "drivers").select("phone").where(idCol(who.actor) as "driver_id", "=", who.subjectId).executeTakeFirstOrThrow();
    await trx.updateTable(table(who.actor) as "drivers").set({ phone: input.phone }).where(idCol(who.actor) as "driver_id", "=", who.subjectId).execute();
    await afterChange(trx, who, "phone", before.phone, now);
    return null;
  });
  if (outcome) throw outcome;
  return { phone: input.phone };
}

export async function startEmailChange(db: Db, who: Who, email: string, now: Date, log?: (code: string) => void) {
  const value = email.trim().toLowerCase();
  if (!EMAIL.test(value) || value.length > 200) throw badRequest("The e-mail is not valid.", "invalid_email");
  await checkStart(db, who, "email", now);
  const challengeId = newId("emc", now.getTime());
  const expiresAt = new Date(now.getTime() + OTP.expiresSeconds * 1000);
  const answer = { challengeId, expiresAt: expiresAt.toISOString(), delivery: "pending_provider" as const };
  if (await emailHasAccount(db, value)) return answer;
  const code = String(randomInt(0, 10 ** OTP.codeLength)).padStart(OTP.codeLength, "0");
  // Wrong tries of the last hour carry over to the new challenge (a restart never resets them).
  const earlier = await db.selectFrom("email_changes").select((eb) => eb.fn.coalesce(eb.fn.max("attempts"), eb.val(0)).as("n")).where("actor", "=", who.actor).where("subject_id", "=", who.subjectId).where("created_at", ">", hourAgo(now)).executeTakeFirstOrThrow();
  await db.updateTable("email_changes").set({ expires_at: now }).where("actor", "=", who.actor).where("subject_id", "=", who.subjectId).where("expires_at", ">", now).execute();
  await db.insertInto("email_changes").values({ challenge_id: challengeId, actor: who.actor, subject_id: who.subjectId, email: value, code_sha256: sha(`${challengeId}:${code}`), attempts: Number(earlier.n), expires_at: expiresAt, created_at: now }).execute();
  log?.(code);
  return answer;
}

export async function verifyEmailChange(db: Db, who: Who, input: { challengeId: string; code: string }, now: Date) {
  const outcome = await db.transaction().execute(async (trx) => {
    const c = await trx.selectFrom("email_changes").selectAll().where("challenge_id", "=", input.challengeId).forUpdate().executeTakeFirst();
    if (!c || c.actor !== who.actor || c.subject_id !== who.subjectId) return badRequest("This code is not active. Ask for a new one.", "invalid_email_challenge");
    if (c.expires_at.getTime() <= now.getTime()) return new ApiError("otp_expired", "The code expired. Ask for a new one.");
    if (c.attempts >= OTP.maxAttempts) return new ApiError("rate_limited", "Too many wrong codes. Ask for a new code.", { reason: "otp_too_many_attempts", retryAfterSeconds: OTP.retryAfterSeconds });
    if (!same(c.code_sha256, sha(`${c.challenge_id}:${input.code}`))) {
      await trx.updateTable("email_changes").set({ attempts: c.attempts + 1 }).where("challenge_id", "=", c.challenge_id).execute();
      return badRequest("That code is not right.", "invalid_otp_code");
    }
    await trx.updateTable("email_changes").set({ expires_at: now }).where("challenge_id", "=", c.challenge_id).execute();
    if (await emailHasAccount(trx, c.email)) return badRequest("This code is not active. Ask for a new one.", "invalid_email_challenge");
    const before = await trx.selectFrom(table(who.actor) as "drivers").select("email").where(idCol(who.actor) as "driver_id", "=", who.subjectId).executeTakeFirstOrThrow();
    await trx.updateTable(table(who.actor) as "drivers").set({ email: c.email }).where(idCol(who.actor) as "driver_id", "=", who.subjectId).execute();
    await afterChange(trx, who, "email", before.email, now);
    return { email: c.email };
  });
  if (outcome instanceof ApiError) throw outcome;
  return outcome;
}

const TEXT = {
  phone: { sv: "Ditt telefonnummer ändrades", fr: "Votre numéro de téléphone a été modifié", en: "Your phone number was changed" },
  email: { sv: "Din e-postadress ändrades", fr: "Votre adresse e-mail a été modifiée", en: "Your e-mail address was changed" },
  body: { sv: "Var det inte du? Kontakta Movera support.", fr: "Ce n’était pas vous ? Contactez l’assistance Movera.", en: "Not you? Contact Movera support." },
} as const;

/** The notice to the OLD number / address (pending until a provider sends it), the in-app notice, other sessions end. */
async function afterChange(trx: Trx, who: Who, what: "phone" | "email", old: string | null, now: Date) {
  const row = await trx.selectFrom(table(who.actor) as "drivers").select("language").where(idCol(who.actor) as "driver_id", "=", who.subjectId).executeTakeFirst();
  const l = row?.language === "sv" || row?.language === "fr" ? row.language : "en";
  if (old) await trx.insertInto("outbound_notices").values({ channel: what === "phone" ? "sms" : "email", to_address: old, kind: `${what}_changed`, language: l, status: "pending_provider", created_at: now }).execute();
  await notify(trx, { audience: who.actor, subjectId: who.subjectId, kind: `${what}_changed`, title: TEXT[what][l], body: TEXT.body[l], data: { texts: { title: TEXT[what], body: TEXT.body } } }, now);
  await trx.updateTable("auth_sessions").set({ revoked_at: now, revoked_reason: "account_changed" }).where("actor", "=", who.actor).where("subject_id", "=", who.subjectId).where("session_id", "!=", who.sessionId).where("revoked_at", "is", null).execute();
}
