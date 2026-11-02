import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import type { Db, Trx } from "../db/db.js";
import { ApiError, badRequest } from "../http/errors.js";
import { newId } from "../ids.js";
import { notify } from "../notifications/service.js";
import { OTP, PHONE, requestOtp, type AuthDeps, type ClientInfo } from "./service.js";

/**
 * v0.18.14 (owner 2026-11-02, decisions/driver-g1.md "Phone number change" / "E-mail change"): a driver or rider changes
 * his phone number or e-mail himself. New value → a code is sent to it → the code saves it; the account, documents
 * and history stay; a notice goes to the account. Phone: the normal sign-in code (same limits, same test-week rule).
 * E-mail: a 6-digit code to the new address (delivery needs an e-mail provider; until one is connected the server
 * keeps the code and, outside production, logs it).
 */

type Who = { actor: "rider" | "driver"; subjectId: string };
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const table = (actor: Who["actor"]) => (actor === "rider" ? "riders" : "drivers");
const idCol = (actor: Who["actor"]) => (actor === "rider" ? "rider_id" : "driver_id");

export async function startPhoneChange(deps: AuthDeps, who: Who, phone: string, client: ClientInfo) {
  if (!PHONE.test(phone)) throw badRequest("Send the phone number in international form, e.g. +46701234567.", "invalid_phone");
  const taken = await deps.db.selectFrom(table(who.actor)).select("phone").where("phone", "=", phone).executeTakeFirst();
  if (taken) throw new ApiError("conflict", "This number already has an account.", { reason: "phone_taken" });
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
    const taken = await trx.selectFrom(table(who.actor)).select("phone").where("phone", "=", input.phone).executeTakeFirst();
    if (taken) return new ApiError("conflict", "This number already has an account.", { reason: "phone_taken" });
    await trx.updateTable(table(who.actor) as "drivers").set({ phone: input.phone }).where(idCol(who.actor) as "driver_id", "=", who.subjectId).execute();
    await notice(trx, who, "phone", input.phone, now);
    return null;
  });
  if (outcome) throw outcome;
  return { phone: input.phone };
}

export async function startEmailChange(db: Db, who: Who, email: string, now: Date, log?: (code: string) => void) {
  const value = email.trim().toLowerCase();
  if (!EMAIL.test(value) || value.length > 200) throw badRequest("The e-mail is not valid.", "invalid_email");
  const challengeId = newId("emc", now.getTime());
  const code = String(randomInt(0, 10 ** OTP.codeLength)).padStart(OTP.codeLength, "0");
  const expiresAt = new Date(now.getTime() + OTP.expiresSeconds * 1000);
  await db.deleteFrom("email_changes").where("actor", "=", who.actor).where("subject_id", "=", who.subjectId).execute();
  await db.insertInto("email_changes").values({ challenge_id: challengeId, actor: who.actor, subject_id: who.subjectId, email: value, code_sha256: sha(`${challengeId}:${code}`), attempts: 0, expires_at: expiresAt, created_at: now }).execute();
  log?.(code);
  return { challengeId, expiresAt: expiresAt.toISOString(), delivery: "pending_provider" as const };
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
    await trx.deleteFrom("email_changes").where("challenge_id", "=", c.challenge_id).execute();
    await trx.updateTable(table(who.actor) as "drivers").set({ email: c.email }).where(idCol(who.actor) as "driver_id", "=", who.subjectId).execute();
    await notice(trx, who, "email", c.email, now);
    return { email: c.email };
  });
  if (outcome instanceof ApiError) throw outcome;
  return outcome;
}

const TEXT = {
  phone: { sv: "Ditt telefonnummer ändrades", fr: "Votre numéro de téléphone a été modifié", en: "Your phone number was changed" },
  email: { sv: "Din e-postadress ändrades", fr: "Votre adresse e-mail a été modifiée", en: "Your e-mail address was changed" },
  body: { sv: "Var det inte du? Kontakta Movera support.", fr: "Ce n’était pas vous ? Contactez le support Movera.", en: "Not you? Contact Movera support." },
} as const;
async function notice(trx: Trx, who: Who, what: "phone" | "email", _value: string, now: Date) {
  const row = await trx.selectFrom(table(who.actor) as "drivers").select("language").where(idCol(who.actor) as "driver_id", "=", who.subjectId).executeTakeFirst();
  const l = row?.language === "sv" || row?.language === "fr" ? row.language : "en";
  await notify(trx, { audience: who.actor, subjectId: who.subjectId, kind: `${what}_changed`, title: TEXT[what][l], body: TEXT.body[l], data: { texts: { title: TEXT[what], body: TEXT.body } } }, now);
}
