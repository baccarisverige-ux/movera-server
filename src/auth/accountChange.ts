import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { sql } from "kysely";
import type { Db, Executor, Trx } from "../db/db.js";
import type { EmailSender } from "../email/resend.js";
import { emailTakenByOther } from "./emailTaken.js";
import { ApiError, badRequest } from "../http/errors.js";
import { newId } from "../ids.js";
import { notify } from "../notifications/service.js";
import { noticeLanguage } from "../notifications/noticeLanguage.js";
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
 * G30 + G30b (contract v0.18.76, contract.json#emailVerified; owner 2026-11-12 Q1–Q6, S1; supervisor round 3):
 * - the verify saves the address lower-cased with email_verified_at = now and answers { email, emailVerifiedAt };
 * - the account's own current address may be verified: no 10-minute rule, no change notice, no session ends;
 * - only an address VERIFIED on another account of the SAME app gets the silent answer (an unchecked copy never blocks;
 *   the same person may use it on his rider and his driver account); the first of two verifies wins;
 * - the code goes out through the e-mail service; delivery is 'sent' only when it accepted the e-mail, and only such a
 *   start counts toward the 3 per hour (a refused or failed send is 'pending_provider' and is not counted).
 * - owner answer F3: besides, at most EMAIL_TRIES_PER_HOUR (10) starts per hour, counting every start.
 * G30 fix round (supervisor F2, F4): the silent answer stores a never-sent challenge and takes as long as the last real
 * send, so neither a wrong-code answer nor the answer time tells that another account has the address. F5: parallel starts
 * of one account queue on a per-account lock while counted and stored, and a running send holds its accepted place.
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

async function recentSignIn(ex: Executor, who: Who, now: Date): Promise<void> {
  const session = await ex.selectFrom("auth_sessions").select("created_at").where("session_id", "=", who.sessionId).executeTakeFirst();
  if (!session || now.getTime() - session.created_at.getTime() > RECENT_SIGN_IN_MS) {
    throw new ApiError("forbidden", "Sign in again on this phone, then change it within 10 minutes.", { reason: "reauth_required" });
  }
}
/**
 * The e-mail start limits per account and hour, both 429 change_too_many. acceptedPerHour: starts whose code e-mail the
 * service accepted (rows in account_change_starts) plus starts whose send is still running (email_changes.delivery
 * 'sending', a reserved place). allTriesPerHour (supervisor G30 F3, owner 2026-11-12: "at most 10 per hour, counting every
 * start"; contract v0.18.77 emailVerified.delivery): every start, sent, refused / failed send or the silent answer (each
 * stores an email_changes row); null = no such cap. For e-mail both are counted under the per-account start lock
 * (startEmailChange, supervisor G30 F5), so parallel starts cannot pass them.
 */
export const EMAIL_TRIES_PER_HOUR = 10;
export const EMAIL_LIMITS: { acceptedPerHour: number; allTriesPerHour: number | null } = { acceptedPerHour: STARTS_PER_HOUR, allTriesPerHour: EMAIL_TRIES_PER_HOUR };
const tooMany = () => new ApiError("rate_limited", "Too many changes. Try again later.", { reason: "change_too_many", retryAfterSeconds: 3600 });
async function startsLeft(ex: Executor, who: Who, kind: "phone" | "email", now: Date): Promise<void> {
  const starts = await ex.selectFrom("account_change_starts").select((eb) => eb.fn.countAll<string>().as("n")).where("actor", "=", who.actor).where("subject_id", "=", who.subjectId).where("kind", "=", kind).where("at", ">", hourAgo(now)).executeTakeFirstOrThrow();
  const sending = kind === "email" ? await ex.selectFrom("email_changes").select((eb) => eb.fn.countAll<string>().as("n")).where("actor", "=", who.actor).where("subject_id", "=", who.subjectId).where("delivery", "=", "sending").where("created_at", ">", hourAgo(now)).executeTakeFirstOrThrow() : { n: "0" };
  if (Number(starts.n) + Number(sending.n) >= (kind === "email" ? EMAIL_LIMITS.acceptedPerHour : STARTS_PER_HOUR)) throw tooMany();
  const cap = kind === "email" ? EMAIL_LIMITS.allTriesPerHour : null;
  if (cap === null) return;
  const tries = await ex.selectFrom("email_changes").select((eb) => eb.fn.countAll<string>().as("n")).where("actor", "=", who.actor).where("subject_id", "=", who.subjectId).where("created_at", ">", hourAgo(now)).executeTakeFirstOrThrow();
  if (Number(tries.n) >= cap) throw tooMany();
}
async function recordStart(ex: Executor, who: Who, kind: "phone" | "email", now: Date): Promise<void> {
  await ex.insertInto("account_change_starts").values({ actor: who.actor, subject_id: who.subjectId, kind, at: now }).execute();
}
async function checkStart(ex: Executor, who: Who, kind: "phone" | "email", now: Date): Promise<void> {
  await recentSignIn(ex, who, now);
  await startsLeft(ex, who, kind, now);
  await recordStart(ex, who, kind, now);
}

async function phoneHasAccount(ex: Executor, phone: string): Promise<boolean> {
  const r = await ex.selectFrom("riders").select("rider_id").where("phone", "=", phone).executeTakeFirst();
  const d = await ex.selectFrom("drivers").select("driver_id").where("phone", "=", phone).executeTakeFirst();
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

type EmailStartOptions = { sender?: EmailSender | undefined; log?: ((code: string) => void) | undefined };
/**
 * G30b: whether the e-mail service took the last real code e-mail, and how long that send took. The silent answer (an
 * address verified on another account) copies the first, so 'sent' vs 'pending_provider' never tells whether someone else
 * uses the address — also while the service refuses every address but the Resend owner's (no own domain yet) — and waits
 * the second (supervisor G30 F2), so the answer time does not tell it either. Before any real send: SILENT_WAIT_DEFAULT_MS;
 * never longer than SILENT_WAIT_MAX_MS (the sender's own time-out default).
 */
const lastSend = new WeakMap<EmailSender, { accepted: boolean; ms: number }>();
export const SILENT_WAIT_DEFAULT_MS = 400;
export const SILENT_WAIT_MAX_MS = 5000;
const CODE_TEXT = {
  subject: { sv: "Din Movera-kod", fr: "Votre code Movera", en: "Your Movera code" },
  text: {
    sv: (code: string, minutes: number) => `Din Movera-kod är ${code}. Den gäller i ${minutes} minuter.\n\nBad du inte om den? Då kan du strunta i det här mejlet.`,
    fr: (code: string, minutes: number) => `Votre code Movera est ${code}. Il est valable ${minutes} minutes.\n\nVous ne l’avez pas demandé ? Ignorez cet e-mail.`,
    en: (code: string, minutes: number) => `Your Movera code is ${code}. It is valid for ${minutes} minutes.\n\nDid not ask for it? Ignore this e-mail.`,
  },
} as const;

export async function startEmailChange(db: Db, who: Who, email: string, now: Date, options: EmailStartOptions = {}) {
  const value = email.trim().toLowerCase();
  if (!EMAIL.test(value) || value.length > 200) throw badRequest("The e-mail is not valid.", "invalid_email");
  const account = await db.selectFrom(table(who.actor) as "drivers").select(["email", "language"]).where(idCol(who.actor) as "driver_id", "=", who.subjectId).executeTakeFirst();
  // emailVerified.verifyCurrent: checking the address the account already has changes nothing, so no 10-minute rule.
  const own = account?.email != null && account.email.trim().toLowerCase() === value;
  if (!own) await recentSignIn(db, who, now);
  const challengeId = newId("emc", now.getTime());
  const expiresAt = new Date(now.getTime() + OTP.expiresSeconds * 1000);
  const answer = (delivery: "sent" | "pending_provider") => ({ challengeId, expiresAt: expiresAt.toISOString(), delivery });
  const taken = await emailTakenByOther(db, who.actor, who.subjectId, value);
  // Supervisor G30 F4: the silent answer stores a challenge too (a random code that is never sent), so a wrong code answers
  // invalid_otp_code either way, and it closes the open challenge like a real start. Its right code is never known; even
  // then the verify refuses the taken address (invalid_email_challenge).
  const code = String(randomInt(0, 10 ** OTP.codeLength)).padStart(OTP.codeLength, "0");
  // Supervisor G30 F5: the count, closing the open challenge and the new row are one transaction under a per-account lock,
  // so parallel starts queue here and the 10 tries per hour are strict (Rule 33: also across server copies). The new row
  // is 'sending': it holds one of the 3 accepted places until the send ends, so parallel starts cannot pass the 3 either.
  // The lock ends with this transaction, before any e-mail is sent.
  await db.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`email_start:${who.actor}:${who.subjectId}`}))`.execute(trx);
    await startsLeft(trx, who, "email", now);
    // Wrong tries of the last hour carry over to the new challenge (a restart never resets them).
    const earlier = await trx.selectFrom("email_changes").select((eb) => eb.fn.coalesce(eb.fn.max("attempts"), eb.val(0)).as("n")).where("actor", "=", who.actor).where("subject_id", "=", who.subjectId).where("created_at", ">", hourAgo(now)).executeTakeFirstOrThrow();
    await trx.updateTable("email_changes").set({ expires_at: now }).where("actor", "=", who.actor).where("subject_id", "=", who.subjectId).where("expires_at", ">", now).execute();
    await trx.insertInto("email_changes").values({ challenge_id: challengeId, actor: who.actor, subject_id: who.subjectId, email: value, code_sha256: sha(`${challengeId}:${code}`), attempts: Number(earlier.n), expires_at: expiresAt, created_at: now, delivery: "sending" }).execute();
  });
  let delivery: "sent" | "pending_provider" = "pending_provider";
  try {
    if (taken) {
      // The same answer as a real start (no e-mail): nobody learns that another account has this address.
      if (options.sender !== undefined) {
        const last = lastSend.get(options.sender);
        await new Promise((resolve) => setTimeout(resolve, Math.min(SILENT_WAIT_MAX_MS, last?.ms ?? SILENT_WAIT_DEFAULT_MS)));
        if (last?.accepted === true) delivery = "sent";
      }
    } else {
      options.log?.(code);
      if (options.sender !== undefined) {
        const lang = await noticeLanguage(db, { actor: who.actor, id: who.subjectId, language: account?.language ?? null });
        const started = performance.now();
        // A sender that throws counts as a failed send (never a server error, never 'sent').
        const outcome = await options.sender.send({ to: value, subject: CODE_TEXT.subject[lang], text: CODE_TEXT.text[lang](code, Math.ceil(OTP.expiresSeconds / 60)) }).catch(() => ({ accepted: false }));
        lastSend.set(options.sender, { accepted: outcome.accepted, ms: performance.now() - started });
        if (outcome.accepted) delivery = "sent";
      }
    }
  } finally {
    // Supervisor round 3 (R2-3): only a start whose e-mail the service accepted counts toward the 3 per hour; a refused or
    // failed send gives its reserved place back (the row still counts toward the 10). One transaction: the place is never
    // counted twice nor dropped between the two writes.
    const final = delivery;
    await db.transaction().execute(async (trx) => {
      await trx.updateTable("email_changes").set({ delivery: final }).where("challenge_id", "=", challengeId).execute();
      if (final === "sent") await recordStart(trx, who, "email", now);
    });
  }
  return answer(delivery);
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
    // emailVerified.unique: two accounts of one app verifying the same address queue here; the first wins.
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`email_verified:${who.actor}:${c.email}`}))`.execute(trx);
    if (await emailTakenByOther(trx, who.actor, who.subjectId, c.email)) return badRequest("This code is not active. Ask for a new one.", "invalid_email_challenge");
    const before = await trx.selectFrom(table(who.actor) as "drivers").select("email").where(idCol(who.actor) as "driver_id", "=", who.subjectId).forUpdate().executeTakeFirstOrThrow();
    await trx.updateTable(table(who.actor) as "drivers").set({ email: c.email, email_verified_at: now }).where(idCol(who.actor) as "driver_id", "=", who.subjectId).execute();
    // emailVerified.verifyCurrent: the address did not change → no notice to it, no email_changed, no session ends.
    if ((before.email ?? "").trim().toLowerCase() !== c.email) await afterChange(trx, who, "email", before.email, now);
    return { email: c.email, emailVerifiedAt: now.toISOString() };
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
  // v0.18.66 §87: the bell + push follow the one notice-language rule (own → country → en); the SMS / e-mail to the OLD
  // address keeps its own language rule above (supervisor answer 13, owner to review).
  const n = await noticeLanguage(trx, { actor: who.actor, id: who.subjectId, language: row?.language ?? null });
  await notify(trx, { audience: who.actor, subjectId: who.subjectId, kind: `${what}_changed`, title: TEXT[what][n], body: TEXT.body[n], data: { texts: { title: TEXT[what], body: TEXT.body } } }, now);
  await trx.updateTable("auth_sessions").set({ revoked_at: now, revoked_reason: "account_changed" }).where("actor", "=", who.actor).where("subject_id", "=", who.subjectId).where("session_id", "!=", who.sessionId).where("revoked_at", "is", null).execute();
}
