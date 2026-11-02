import type { Executor, Trx } from "../db/db.js";
import { ApiError, badRequest, notFound } from "../http/errors.js";
import { newId } from "../ids.js";
import { audit } from "../admin/audit.js";
import { notify } from "../notifications/service.js";
import { sendSms, type SmsDeps } from "../sms/sms.js";
import { loadFleet, ownedFleet, coversFleet, type Admin, type FleetRow } from "./fleets.js";
import { ONBOARDING, normalizeFleetCode, sameEmail, sameName } from "./onboardingRules.js";
import { driverView, loadDriver, type DriverRow } from "./service.js";
import { DRIVER_ASSIGNED } from "../rules/transitions.js";

/**
 * Joining a fleet is a two-sided invitation (contract v0.5.3 §14, contract.json#driverOnboarding.fleetInvitations;
 * owner decision of 2026-10-25): the driver asks with the code, the owner's name and e-mail (driver_request), or the
 * owner invites a phone number (owner_invite); the other side accepts or declines, either side cancels its own, an
 * admin may accept or cancel. Nothing links a driver to a fleet without both sides. The other side is told in the
 * app (a `fleet_invitation` notification) and by one SMS; an invitation lives `expiresDays` days.
 */

type FleetInvitations = { expiresDays: number; smsText: Record<string, string>; smsTextRequest: Record<string, string> };
export const INVITATIONS = (ONBOARDING as unknown as { fleetInvitations: FleetInvitations }).fleetInvitations;

export type InviteDeps = { sms: SmsDeps; appLink?: string | undefined };

type InvitationRow = {
  invitation_id: string;
  fleet_id: string;
  direction: "driver_request" | "owner_invite";
  driver_id: string | null;
  phone: string | null;
  status: "pending" | "accepted" | "declined" | "cancelled" | "expired";
  decided_at: Date | null;
  decided_by: string | null;
  expires_at: Date;
  version: number;
  created_at: Date;
};

const KIND = "fleet_invitation";
const PHONE = /^\+[1-9][0-9]{6,14}$/;

/* ---------------------------------------------------------------- words */

const LANG_OF_COUNTRY: Record<string, string> = { SE: "sv", FR: "fr", TN: "fr" };
const language = (row: { language: string | null; country: string | null } | undefined, fallback?: string) =>
  row?.language ?? (row?.country ? LANG_OF_COUNTRY[row.country] : undefined) ?? fallback ?? "en";

const TEXT: Record<string, Record<string, (a: string, b?: string) => string>> = {
  invited_title: { sv: () => "Inbjudan till åkeri", fr: () => "Invitation d’une flotte", en: () => "Fleet invitation" },
  invited_body: { sv: (f) => `${f} bjuder in dig till sitt åkeri. Svara i Mitt åkeri.`, fr: (f) => `${f} vous invite dans sa flotte. Répondez dans Ma flotte.`, en: (f) => `${f} invites you to its fleet. Answer in My fleet.` },
  request_title: { sv: () => "Förare vill gå med", fr: () => "Un chauffeur veut rejoindre", en: () => "Driver wants to join" },
  request_body: { sv: (d, f) => `${d} vill gå med i ${f}. Svara i Mitt åkeri.`, fr: (d, f) => `${d} veut rejoindre ${f}. Répondez dans Ma flotte.`, en: (d, f) => `${d} wants to join ${f}. Answer in My fleet.` },
  accepted_title: { sv: () => "Du är med i åkeriet", fr: () => "Vous êtes dans la flotte", en: () => "You are in the fleet" },
  accepted_body: { sv: (f) => `${f} har tagit emot dig. Välj en bil och gå online.`, fr: (f) => `${f} vous a accepté. Choisissez une voiture et passez en ligne.`, en: (f) => `${f} accepted you. Pick a car and go online.` },
  joined_title: { sv: () => "Ny förare i åkeriet", fr: () => "Nouveau chauffeur", en: () => "New driver in the fleet" },
  joined_body: { sv: (d) => `${d} är nu med i ditt åkeri.`, fr: (d) => `${d} fait maintenant partie de votre flotte.`, en: (d) => `${d} is now in your fleet.` },
  declined_title: { sv: () => "Inbjudan avböjd", fr: () => "Invitation refusée", en: () => "Invitation declined" },
  declined_body_driver: { sv: (f) => `${f} tackade nej till din förfrågan.`, fr: (f) => `${f} a refusé votre demande.`, en: (f) => `${f} declined your request.` },
  declined_body_owner: { sv: (d) => `${d} tackade nej till inbjudan.`, fr: (d) => `${d} a refusé l’invitation.`, en: (d) => `${d} declined the invitation.` },
  cancelled_title: { sv: () => "Inbjudan återkallad", fr: () => "Invitation annulée", en: () => "Invitation withdrawn" },
  cancelled_body_driver: { sv: (f) => `Inbjudan från ${f} gäller inte längre.`, fr: (f) => `L’invitation de ${f} n’est plus valable.`, en: (f) => `The invitation from ${f} is withdrawn.` },
  cancelled_body_owner: { sv: (d) => `${d} tog tillbaka sin förfrågan.`, fr: (d) => `${d} a retiré sa demande.`, en: (d) => `${d} withdrew the request.` },
};
const words = (key: string, lang: string, a: string, b?: string) => (TEXT[key]![lang] ?? TEXT[key]!.en!)(a, b);
const fill = (template: string, values: Record<string, string>) => template.replace(/\{(\w+)\}/g, (_, k: string) => values[k] ?? "");

const fullName = (d: { first_name: string; last_name: string }) => `${d.first_name} ${d.last_name}`.trim() || "A driver";

/* ---------------------------------------------------------------- views */

export function invitationView(row: InvitationRow, fleetName: string, driver: { first_name: string; last_name: string } | undefined, viewer: "driver" | "owner" | "admin", now: Date) {
  const status = row.status === "pending" && row.expires_at.getTime() <= now.getTime() ? "expired" : row.status;
  // v0.18.5 (G2-D5.5, fleetInvitations.privacy): the owner sees only the invited number until the driver accepts.
  const hidden = viewer === "owner" && row.direction === "owner_invite" && status !== "accepted";
  return {
    invitationId: row.invitation_id,
    fleetId: row.fleet_id,
    fleetName,
    direction: row.direction,
    ...(row.driver_id && !hidden ? { driverId: row.driver_id } : {}),
    ...(driver && !hidden ? { driverName: fullName(driver) } : {}),
    ...(row.phone && viewer !== "driver" ? { phone: row.phone } : {}),
    status,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    ...(row.decided_at ? { decidedAt: row.decided_at.toISOString() } : {}),
    version: row.version,
  };
}

async function viewOf(ex: Executor, row: InvitationRow, viewer: "driver" | "owner" | "admin", now: Date) {
  const fleet = await ex.selectFrom("fleets").select("name").where("fleet_id", "=", row.fleet_id).executeTakeFirstOrThrow();
  const driver = row.driver_id ? await ex.selectFrom("drivers").select(["first_name", "last_name"]).where("driver_id", "=", row.driver_id).executeTakeFirst() : undefined;
  return invitationView(row, fleet.name, driver, viewer, now);
}

/** The fleet's open invitations and requests, for FleetView (owner and admins). */
export async function fleetInvitationViews(ex: Executor, fleet: FleetRow, viewer: "owner" | "admin", now: Date) {
  const rows = (await ex.selectFrom("fleet_invitations").selectAll().where("fleet_id", "=", fleet.fleet_id).where("status", "=", "pending").where("expires_at", ">", now).orderBy("created_at").execute()) as unknown as InvitationRow[];
  const views = [];
  for (const row of rows) views.push(await viewOf(ex, row, viewer, now));
  return views;
}

/** GET /driver/fleet/invitations: a driver's incoming invites and own request; an owner's fleet's open ones. */
export async function listInvitations(ex: Executor, driverId: string, now: Date) {
  const row = await loadDriver(ex, driverId);
  if (row.account_type === "fleet") {
    const fleet = await ownedFleet(ex, driverId);
    return { items: await fleetInvitationViews(ex, fleet, "owner", now) };
  }
  const rows = (await ex.selectFrom("fleet_invitations").selectAll().where("driver_id", "=", driverId).where("status", "=", "pending").where("expires_at", ">", now).orderBy("created_at").execute()) as unknown as InvitationRow[];
  const items = [];
  for (const r of rows) items.push(await viewOf(ex, r, "driver", now));
  return { items };
}

/* ---------------------------------------------------------------- the driver asks */

const MISMATCH = () => badRequest("The code, the owner's name and the e-mail do not match a fleet.", "fleet_join_mismatch");

/** The three must match one approved fleet; a failed try counts towards the hourly limit (routes: recordJoinTry). */
export async function matchFleet(trx: Trx, driverId: string, join: { code: string; ownerName: string; ownerEmail: string }, now: Date): Promise<FleetRow> {
  const since = new Date(now.getTime() - 3600_000);
  const tries = await trx
    .selectFrom("fleet_join_attempts")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("driver_id", "=", driverId)
    .where("at", ">", since)
    .executeTakeFirstOrThrow();
  if (Number(tries.n) >= ONBOARDING.fleetCode.joinAttemptsPerHour) throw new ApiError("rate_limited", "Too many tries; wait an hour.", { reason: "fleet_join_limit", retryAfterSeconds: 3600 });
  const fleet = await trx.selectFrom("fleets").selectAll().where("code", "=", normalizeFleetCode(join.code)).where("status", "=", "approved").executeTakeFirst();
  if (fleet === undefined) throw MISMATCH();
  const owner = await trx.selectFrom("drivers").select(["first_name", "last_name", "email"]).where("driver_id", "=", fleet.owner_driver_id).executeTakeFirstOrThrow();
  if (!sameName(join.ownerName, owner.first_name, owner.last_name) || owner.email === null || !sameEmail(join.ownerEmail, owner.email)) throw MISMATCH();
  return fleet as unknown as FleetRow;
}

async function pendingOf(trx: Trx, where: { driverId?: string; fleetId?: string; phone?: string; direction: "driver_request" | "owner_invite" }, now: Date): Promise<InvitationRow | undefined> {
  let q = trx.selectFrom("fleet_invitations").selectAll().where("status", "=", "pending").where("expires_at", ">", now).where("direction", "=", where.direction);
  if (where.driverId) q = q.where("driver_id", "=", where.driverId);
  if (where.fleetId) q = q.where("fleet_id", "=", where.fleetId);
  if (where.phone) q = q.where("phone", "=", where.phone);
  return (await q.orderBy("created_at").forUpdate().executeTakeFirst()) as unknown as InvitationRow | undefined;
}

async function insertInvitation(trx: Trx, values: { fleetId: string; direction: "driver_request" | "owner_invite"; driverId: string | null; phone: string | null }, now: Date): Promise<InvitationRow> {
  const invitationId = newId("inv", now.getTime());
  const expiresAt = new Date(now.getTime() + INVITATIONS.expiresDays * 24 * 3600_000);
  await trx
    .insertInto("fleet_invitations")
    .values({ invitation_id: invitationId, fleet_id: values.fleetId, direction: values.direction, driver_id: values.driverId, phone: values.phone, expires_at: expiresAt, created_at: now, updated_at: now })
    .execute();
  return (await trx.selectFrom("fleet_invitations").selectAll().where("invitation_id", "=", invitationId).executeTakeFirstOrThrow()) as unknown as InvitationRow;
}

/**
 * POST /driver/fleet/join (and `fleetJoin` on onboarding): a driver_request the owner must accept. If the owner
 * already invited this driver's number, both sides agree and the driver is linked at once.
 */
export async function requestJoin(trx: Trx, deps: InviteDeps, driverId: string, body: { code: string; ownerName: string; ownerEmail: string }, now: Date, options: { quietIfPending?: boolean } = {}) {
  const row = await loadDriver(trx, driverId, true);
  const refuse = async (message: string, reason: string) => new ApiError("invalid_transition", message, { reason, projection: await driverView(trx, row, "driver", now) });
  if (row.account_type === "fleet") throw await refuse("A fleet account has its own fleet.", "fleet_account");
  if (row.fleet_id !== null) throw await refuse("You are already in a fleet; leave it first.", "already_in_fleet");
  const fleet = await matchFleet(trx, driverId, body, now);
  const open = await pendingOf(trx, { driverId, direction: "driver_request" }, now);
  if (open !== undefined) {
    if (options.quietIfPending) return viewOf(trx, open, "driver", now);
    throw new ApiError("conflict", "You already asked a fleet; wait for its answer or cancel that request.", { reason: "request_pending", projection: await viewOf(trx, open, "driver", now) });
  }
  const invite = await pendingOf(trx, { driverId, fleetId: fleet.fleet_id, direction: "owner_invite" }, now);
  if (invite !== undefined) {
    // The owner asked first: this request is the driver's acceptance.
    await link(trx, deps, invite, row, fleet, driverId, now);
    return viewOf(trx, await load(trx, invite.invitation_id), "driver", now);
  }
  const created = await insertInvitation(trx, { fleetId: fleet.fleet_id, direction: "driver_request", driverId, phone: null }, now);
  await trx.updateTable("drivers").set({ version: row.version + 1, updated_at: now }).where("driver_id", "=", driverId).execute();
  const owner = await loadDriver(trx, fleet.owner_driver_id);
  const lang = language(owner);
  await notify(trx, { audience: "driver", subjectId: owner.driver_id, kind: KIND, title: words("request_title", lang, ""), body: words("request_body", lang, fullName(row), fleet.name), deepLink: "movera-driver://fleet/invitations", data: { invitationId: created.invitation_id, direction: "driver_request" } }, now);
  await sendSms(trx, deps.sms, { phone: owner.phone, text: fill(INVITATIONS.smsTextRequest[lang] ?? INVITATIONS.smsTextRequest.en!, { driver: fullName(row), fleet: fleet.name }), kind: KIND }, now);
  return viewOf(trx, created, "driver", now);
}

/* ---------------------------------------------------------------- the owner invites */

/** POST /driver/fleet/invite { phone }: an owner_invite the driver must accept; a number without an account waits. */
export async function inviteByPhone(trx: Trx, deps: InviteDeps, ownerId: string, body: { phone: string }, now: Date) {
  if (!PHONE.test(body.phone)) throw badRequest("Send the phone number in international form, e.g. +46701234567.", "invalid_phone");
  const owner = await loadDriver(trx, ownerId, true);
  const fleet = await ownedFleet(trx, ownerId, true);
  if (fleet.status !== "approved") throw new ApiError("invalid_transition", "Your fleet is not approved yet.", { reason: "fleet_not_approved" });
  if (body.phone === owner.phone) throw badRequest("That is your own number.", "own_phone");
  const driver = (await trx.selectFrom("drivers").selectAll().where("phone", "=", body.phone).forUpdate().executeTakeFirst()) as unknown as DriverRow | undefined;
  if (driver !== undefined) {
    if (driver.account_type === "fleet") throw badRequest("That number belongs to a fleet account.", "fleet_account");
    if (driver.fleet_id !== null) throw new ApiError("conflict", driver.fleet_id === fleet.fleet_id ? "That driver is already in your fleet." : "That driver is in another fleet.", { reason: "already_in_fleet" });
    const request = await pendingOf(trx, { driverId: driver.driver_id, fleetId: fleet.fleet_id, direction: "driver_request" }, now);
    if (request !== undefined) {
      // The driver asked first: this invite is the owner's acceptance.
      await link(trx, deps, request, driver, fleet, ownerId, now);
      return viewOf(trx, await load(trx, request.invitation_id), "owner", now);
    }
  }
  const open = await pendingOf(trx, { fleetId: fleet.fleet_id, phone: body.phone, direction: "owner_invite" }, now);
  if (open !== undefined) throw new ApiError("conflict", "You already invited that number.", { reason: "invite_pending", projection: await viewOf(trx, open, "owner", now) });
  const created = await insertInvitation(trx, { fleetId: fleet.fleet_id, direction: "owner_invite", driverId: driver?.driver_id ?? null, phone: body.phone }, now);
  if (driver !== undefined) {
    const lang = language(driver);
    await notify(trx, { audience: "driver", subjectId: driver.driver_id, kind: KIND, title: words("invited_title", lang, ""), body: words("invited_body", lang, fleet.name), deepLink: "movera-driver://fleet/invitations", data: { invitationId: created.invitation_id, direction: "owner_invite" } }, now);
    await sendSms(trx, deps.sms, { phone: body.phone, text: fill(INVITATIONS.smsText[lang] ?? INVITATIONS.smsText.en!, { fleet: fleet.name }), kind: KIND }, now);
  } else {
    const lang = LANG_OF_COUNTRY[fleet.country] ?? "en";
    const text = fill(INVITATIONS.smsText[lang] ?? INVITATIONS.smsText.en!, { fleet: fleet.name }) + (deps.appLink ? ` ${deps.appLink}` : "");
    await sendSms(trx, deps.sms, { phone: body.phone, text, kind: KIND }, now);
  }
  return viewOf(trx, created, "owner", now);
}

/** A number that was invited before it had an account: the invites become the new driver's the moment he signs up. */
export async function attachInvitesToNewDriver(trx: Trx, driverId: string, phone: string, now: Date): Promise<void> {
  const rows = (await trx.selectFrom("fleet_invitations").selectAll().where("phone", "=", phone).where("driver_id", "is", null).where("status", "=", "pending").where("expires_at", ">", now).execute()) as unknown as InvitationRow[];
  for (const row of rows) {
    await trx.updateTable("fleet_invitations").set({ driver_id: driverId, updated_at: now }).where("invitation_id", "=", row.invitation_id).execute();
    const fleet = await trx.selectFrom("fleets").select(["name", "country"]).where("fleet_id", "=", row.fleet_id).executeTakeFirstOrThrow();
    const lang = LANG_OF_COUNTRY[fleet.country] ?? "en";
    await notify(trx, { audience: "driver", subjectId: driverId, kind: KIND, title: words("invited_title", lang, ""), body: words("invited_body", lang, fleet.name), deepLink: "movera-driver://fleet/invitations", data: { invitationId: row.invitation_id, direction: "owner_invite" } }, now);
  }
}

/* ---------------------------------------------------------------- answering */

async function load(trx: Trx, invitationId: string): Promise<InvitationRow> {
  const row = await trx.selectFrom("fleet_invitations").selectAll().where("invitation_id", "=", invitationId).forUpdate().executeTakeFirst();
  if (row === undefined) throw notFound("No such invitation.", "invitation_not_found");
  return row as unknown as InvitationRow;
}

async function mustBePending(trx: Trx, row: InvitationRow, now: Date): Promise<void> {
  if (row.status === "pending" && row.expires_at.getTime() <= now.getTime()) {
    await trx.updateTable("fleet_invitations").set({ status: "expired", decided_at: row.expires_at, decided_by: "system", version: row.version + 1, updated_at: now }).where("invitation_id", "=", row.invitation_id).execute();
    throw new ApiError("invalid_transition", "This invitation has expired.", { reason: "invitation_expired", projection: await viewOf(trx, await load(trx, row.invitation_id), "admin", now) });
  }
  if (row.status !== "pending") throw new ApiError("invalid_transition", `This invitation is already ${row.status}.`, { reason: "invitation_closed", projection: await viewOf(trx, row, "admin", now) });
}

async function decide(trx: Trx, row: InvitationRow, status: "accepted" | "declined" | "cancelled", by: string, now: Date): Promise<void> {
  await trx.updateTable("fleet_invitations").set({ status, decided_at: now, decided_by: by, version: row.version + 1, updated_at: now }).where("invitation_id", "=", row.invitation_id).execute();
}

/** Links the driver to the fleet: the invitation is accepted and every other pending one of his is closed. */
async function link(trx: Trx, deps: InviteDeps, row: InvitationRow, driver: DriverRow, fleet: FleetRow, by: string, now: Date): Promise<void> {
  void deps;
  if (driver.fleet_id !== null) throw new ApiError("conflict", "The driver is already in a fleet.", { reason: "already_in_fleet" });
  if (driver.account_type === "fleet") throw new ApiError("conflict", "A fleet account cannot join another fleet.", { reason: "fleet_account" });
  if (fleet.status !== "approved") throw new ApiError("invalid_transition", "The fleet is not approved.", { reason: "fleet_not_approved" });
  const active = await trx.selectFrom("trips").select("trip_id").where("driver_id", "=", driver.driver_id).where("status", "in", [...DRIVER_ASSIGNED]).executeTakeFirst();
  if (active) throw new ApiError("invalid_transition", "The driver is on a trip; try after it.", { reason: "on_trip" });
  await decide(trx, row, "accepted", by, now);
  await trx
    .updateTable("fleet_invitations")
    .set({ status: "cancelled", decided_at: now, decided_by: "system", updated_at: now })
    .where("driver_id", "=", driver.driver_id)
    .where("status", "=", "pending")
    .where("invitation_id", "<>", row.invitation_id)
    .execute();
  await trx.updateTable("drivers").set({ fleet_id: fleet.fleet_id, fleet_linked_at: now, version: driver.version + 1, updated_at: now }).where("driver_id", "=", driver.driver_id).execute();
  const owner = await loadDriver(trx, fleet.owner_driver_id);
  await notify(trx, { audience: "driver", subjectId: driver.driver_id, kind: KIND, title: words("accepted_title", language(driver), ""), body: words("accepted_body", language(driver), fleet.name), deepLink: "movera-driver://fleet", data: { invitationId: row.invitation_id, status: "accepted" } }, now);
  await notify(trx, { audience: "driver", subjectId: owner.driver_id, kind: KIND, title: words("joined_title", language(owner), ""), body: words("joined_body", language(owner), fullName(driver)), deepLink: "movera-driver://fleet", data: { invitationId: row.invitation_id, status: "accepted" } }, now);
}

/** Who may answer: an owner_invite is answered by the driver, a driver_request by the fleet's owner. */
async function receiver(trx: Trx, row: InvitationRow, actorId: string, now: Date): Promise<{ driver: DriverRow; fleet: FleetRow }> {
  const fleet = await loadFleet(trx, row.fleet_id, true);
  const expected = row.direction === "owner_invite" ? row.driver_id : fleet.owner_driver_id;
  if (expected !== actorId) throw new ApiError("forbidden", "This invitation is not yours to answer.", { reason: "not_receiver", projection: await viewOf(trx, row, "driver", now) });
  if (row.driver_id === null) throw new ApiError("invalid_transition", "That number has no account yet.", { reason: "driver_not_signed_up" });
  return { driver: await loadDriver(trx, row.driver_id, true), fleet };
}

export async function acceptInvitation(trx: Trx, deps: InviteDeps, actorId: string, invitationId: string, now: Date) {
  const row = await load(trx, invitationId);
  await mustBePending(trx, row, now);
  const { driver, fleet } = await receiver(trx, row, actorId, now);
  await link(trx, deps, row, driver, fleet, actorId, now);
  return viewOf(trx, await load(trx, invitationId), row.direction === "owner_invite" ? "driver" : "owner", now);
}

export async function declineInvitation(trx: Trx, _deps: InviteDeps, actorId: string, invitationId: string, now: Date) {
  const row = await load(trx, invitationId);
  await mustBePending(trx, row, now);
  const { driver, fleet } = await receiver(trx, row, actorId, now);
  await decide(trx, row, "declined", actorId, now);
  if (row.direction === "driver_request") {
    await notify(trx, { audience: "driver", subjectId: driver.driver_id, kind: KIND, title: words("declined_title", language(driver), ""), body: words("declined_body_driver", language(driver), fleet.name), data: { invitationId, status: "declined" } }, now);
  } else {
    const owner = await loadDriver(trx, fleet.owner_driver_id);
    // v0.18.5 (G2-D5.5): the owner never learns the name of a driver who declined; only the number he invited.
    await notify(trx, { audience: "driver", subjectId: owner.driver_id, kind: KIND, title: words("declined_title", language(owner), ""), body: words("declined_body_owner", language(owner), row.phone ?? fullName(driver)), data: { invitationId, status: "declined" } }, now);
  }
  return viewOf(trx, await load(trx, invitationId), row.direction === "owner_invite" ? "driver" : "owner", now);
}

/** Only the side that created it: the driver his request, the owner his invite. */
export async function cancelInvitation(trx: Trx, _deps: InviteDeps, actorId: string, invitationId: string, now: Date) {
  const row = await load(trx, invitationId);
  await mustBePending(trx, row, now);
  const fleet = await loadFleet(trx, row.fleet_id);
  const creator = row.direction === "driver_request" ? row.driver_id : fleet.owner_driver_id;
  if (creator !== actorId) throw new ApiError("forbidden", "Only the side that sent it can cancel it.", { reason: "not_sender" });
  await decide(trx, row, "cancelled", actorId, now);
  if (row.direction === "driver_request") {
    const owner = await loadDriver(trx, fleet.owner_driver_id);
    const driver = await loadDriver(trx, row.driver_id!);
    await notify(trx, { audience: "driver", subjectId: owner.driver_id, kind: KIND, title: words("cancelled_title", language(owner), ""), body: words("cancelled_body_owner", language(owner), fullName(driver)), data: { invitationId, status: "cancelled" } }, now);
  } else if (row.driver_id) {
    const driver = await loadDriver(trx, row.driver_id);
    await notify(trx, { audience: "driver", subjectId: driver.driver_id, kind: KIND, title: words("cancelled_title", language(driver), ""), body: words("cancelled_body_driver", language(driver), fleet.name), data: { invitationId, status: "cancelled" } }, now);
  }
  return viewOf(trx, await load(trx, invitationId), row.direction === "driver_request" ? "driver" : "owner", now);
}

/* ---------------------------------------------------------------- admin */

/** POST /admin/fleets/{id}/invitations/{invitationId}/accept|cancel. */
export async function adminDecideInvitation(trx: Trx, deps: InviteDeps, who: Admin, fleetId: string, invitationId: string, action: "accept" | "cancel", now: Date) {
  const fleet = await loadFleet(trx, fleetId, true);
  coversFleet(who, fleet);
  const row = await load(trx, invitationId);
  if (row.fleet_id !== fleetId) throw notFound("No such invitation in this fleet.", "invitation_not_found");
  await mustBePending(trx, row, now);
  if (action === "accept") {
    if (row.driver_id === null) throw new ApiError("invalid_transition", "That number has no account yet.", { reason: "driver_not_signed_up" });
    await link(trx, deps, row, await loadDriver(trx, row.driver_id, true), fleet, who.subjectId, now);
  } else {
    await decide(trx, row, "cancelled", who.subjectId, now);
    if (row.driver_id) {
      const driver = await loadDriver(trx, row.driver_id);
      await notify(trx, { audience: "driver", subjectId: driver.driver_id, kind: KIND, title: words("cancelled_title", language(driver), ""), body: words("cancelled_body_driver", language(driver), fleet.name), data: { invitationId, status: "cancelled" } }, now);
    }
    const owner = await loadDriver(trx, fleet.owner_driver_id);
    const named = row.driver_id ? fullName(await loadDriver(trx, row.driver_id)) : (row.phone ?? "");
    await notify(trx, { audience: "driver", subjectId: owner.driver_id, kind: KIND, title: words("cancelled_title", language(owner), ""), body: words("cancelled_body_owner", language(owner), named), data: { invitationId, status: "cancelled" } }, now);
  }
  await audit(trx, { adminId: who.subjectId, action: `fleet.invitation.${action}`, targetType: "fleet", targetId: fleetId, zoneId: fleet.zone_id, detail: { invitationId, direction: row.direction, driverId: row.driver_id }, at: now });
  return viewOf(trx, await load(trx, invitationId), "admin", now);
}

/** A rejected or blocked fleet keeps no open invitations. */
export async function cancelFleetInvitations(trx: Trx, fleetId: string, by: string, now: Date): Promise<void> {
  await trx.updateTable("fleet_invitations").set({ status: "cancelled", decided_at: now, decided_by: by, updated_at: now }).where("fleet_id", "=", fleetId).where("status", "=", "pending").execute();
}
