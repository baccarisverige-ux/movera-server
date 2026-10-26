import { randomBytes } from "node:crypto";

/**
 * Server-made ids (contract §1: opaque, ^[A-Za-z0-9_-]{1,64}$; clients never invent a tripId). A short prefix
 * names the kind (trp_, ofr_, rdr_, drv_, evt_, …) and a ULID-style body sorts by creation time:
 * 10 chars of milliseconds + 16 random chars, Crockford base32.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeTime(ms: number): string {
  let out = "";
  let value = ms;
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[value % 32]! + out;
    value = Math.floor(value / 32);
  }
  return out;
}

function encodeRandom(chars: number): string {
  const bytes = randomBytes(chars);
  let out = "";
  for (let i = 0; i < chars; i++) out += ALPHABET[bytes[i]! % 32]!;
  return out;
}

export type IdPrefix = "trp" | "ofr" | "rdr" | "drv" | "veh" | "doc" | "flt" | "evt" | "qte" | "otp" | "adm" | "apr" | "aud" | "pay" | "grp" | "sid" | "fam" | "ern" | "rfd" | "wlt" | "inv" | "ntf" | "sms" | "msg";

export function newId(prefix: IdPrefix, now: number = Date.now()): string {
  return `${prefix}_${encodeTime(now)}${encodeRandom(16)}`;
}

export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
