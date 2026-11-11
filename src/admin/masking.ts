import type { Principal } from "../auth/guard.js";

/**
 * contract v0.18.54 §76 (owner 2026-11-09 Q40 "Yes, now", contract.json#adminMasking): in every ADMIN answer a rider's
 * or driver's phone, e-mail and date of birth, and a fleet's owner e-mail, are masked unless the admin has the matching
 * right (riders.viewSensitive / drivers.viewSensitive). A masked object carries sensitiveMasked: true so the admin
 * panel shows Reveal (revealRoutes.ts). Own profiles (GET /rider/profile, /driver/profile, /driver/fleet) never pass
 * through here.
 */

const DOT = "•";
/** The zone countries' codes come first; another number takes the longest 1–3 digit match after "+". */
const ZONE_CODES = ["+46", "+33", "+216"];

/** `+46•••••••12` for +46701234512: the country code, one • per hidden digit, the last two digits; never fewer than one •. */
export function maskPhone(phone: string): string {
  const code = ZONE_CODES.find((c) => phone.startsWith(c)) ?? /^\+\d{1,3}/.exec(phone)?.[0] ?? "";
  const rest = phone.slice(code.length);
  const tail = rest.slice(-2);
  const hidden = Math.max(1, rest.length - tail.length);
  return `${code}${DOT.repeat(hidden)}${tail}`;
}

/** `a•••@example.com`: the first character, •••@ and the domain. */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  const domain = at >= 0 ? email.slice(at + 1) : "";
  return `${email.slice(0, 1)}${DOT}${DOT}${DOT}@${domain}`;
}

/** `1990` for 1990-05-17: the year only. */
export function maskDateOfBirth(dateOfBirth: string): string {
  return dateOfBirth.slice(0, 4);
}

type Perms = Pick<Principal, "perms"> | undefined;

const has = (who: Perms, right: string) => (who?.perms ?? []).includes(right);

/** Masked for riders: the admin lacks riders.viewSensitive (an unknown caller is masked). */
export const adminMasksRiders = (who: Perms): boolean => !has(who, "riders.viewSensitive");
/** Masked for drivers and fleets: the admin lacks drivers.viewSensitive. */
export const adminMasksDrivers = (who: Perms): boolean => !has(who, "drivers.viewSensitive");

type View = Record<string, unknown>;

function maskFields(view: View, fields: Array<[key: string, mask: (value: string) => string]>): View {
  let masked = false;
  const out: View = { ...view };
  for (const [key, mask] of fields) {
    const value = view[key];
    if (typeof value !== "string") continue;
    out[key] = mask(value);
    masked = true;
  }
  return masked ? { ...out, sensitiveMasked: true } : view;
}

/** Rider / RiderPage row for an admin: phone and email masked without riders.viewSensitive; the same object otherwise. */
export function maskRiderView<T extends View>(view: T, who: Perms): T {
  if (!adminMasksRiders(who)) return view;
  return maskFields(view, [["phone", maskPhone], ["email", maskEmail]]) as T;
}

/** Driver for an admin: phone (when present), email and dateOfBirth masked without drivers.viewSensitive. */
export function maskDriverView<T extends View>(view: T, who: Perms): T {
  if (!adminMasksDrivers(who)) return view;
  return maskFields(view, [["phone", maskPhone], ["email", maskEmail], ["dateOfBirth", maskDateOfBirth]]) as T;
}

/** Fleet for an admin: ownerEmail masked without drivers.viewSensitive. */
export function maskFleetView<T extends View>(view: T, who: Perms): T {
  if (!adminMasksDrivers(who)) return view;
  return maskFields(view, [["ownerEmail", maskEmail]]) as T;
}

/** FleetInvitation for an admin (FleetView.invitations, the admin accept/cancel answer): phone masked without drivers.viewSensitive. */
export function maskInvitationView<T extends View>(view: T, who: Perms): T {
  if (!adminMasksDrivers(who)) return view;
  return maskFields(view, [["phone", maskPhone]]) as T;
}
