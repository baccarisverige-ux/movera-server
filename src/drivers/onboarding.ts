import { randomInt } from "node:crypto";
import { sql } from "kysely";
import type { Executor, Trx } from "../db/db.js";
import { ApiError, badRequest, notFound } from "../http/errors.js";
import { newId } from "../ids.js";
import { scheduleTimer } from "../jobs/timers.js";
import { schemaProblem } from "../contract/schemas.js";
import { DRIVER_ASSIGNED } from "../rules/transitions.js";
import { recordAcceptance } from "../documents/service.js";
import { audit } from "../admin/audit.js";
import { ONBOARDING, COUNTRY_CURRENCY, COUNTRY_TIME_ZONE, ageAt, cityOf, makeFleetCode, normalizeFleetCode } from "./onboardingRules.js";
import { driverView, loadDriver, releaseCar, vehicleFullView, type DriverRow } from "./service.js";
import { coversFleet, loadFleet, ownedFleet, type Admin, type FleetRow } from "./fleets.js";
import { cancelFleetInvitations, fleetInvitationViews, requestJoin, type InviteDeps } from "./invitations.js";

export { loadFleet, ownedFleet } from "./fleets.js";

/**
 * The details screen and fleets (contract v0.5.3 §14): the driver's sign-up details sent once, fleet accounts
 * with their company, the join code that works together with the owner's name and e-mail, joining, leaving and
 * removing drivers, the fleet view and the owner's earnings overview; the admin's fleet review and new code.
 */

/** Fleet as the contract shows it; the code and the owner's e-mail only to the owner and admins. */
export async function fleetView(ex: Executor, row: FleetRow, viewer: "owner" | "member" | "admin") {
  const owner = await ex.selectFrom("drivers").select(["first_name", "last_name", "email"]).where("driver_id", "=", row.owner_driver_id).executeTakeFirstOrThrow();
  const counts = await ex
    .selectFrom("drivers")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("fleet_id", "=", row.fleet_id)
    .executeTakeFirstOrThrow();
  const cars = await ex
    .selectFrom("vehicles")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("fleet_id", "=", row.fleet_id)
    .executeTakeFirstOrThrow();
  const privileged = viewer !== "member";
  return {
    fleetId: row.fleet_id,
    name: row.name,
    orgNumber: row.org_number,
    ...(row.address ? { address: row.address } : {}),
    country: row.country,
    cityId: row.city_id,
    ownerDriverId: row.owner_driver_id,
    ownerName: `${owner.first_name} ${owner.last_name}`.trim(),
    ...(privileged && owner.email ? { ownerEmail: owner.email } : {}),
    status: row.status,
    ...(privileged && row.code && row.status === "approved" ? { code: row.code } : {}),
    driverCount: Number(counts.n),
    vehicleCount: Number(cars.n),
    createdAt: row.created_at.toISOString(),
    version: row.version,
  };
}

/** FleetView: the company, the drivers (owner and admins) and the cars (a member sees the approved ones). */
export async function fleetFullView(ex: Executor, row: FleetRow, viewer: "owner" | "member" | "admin", now: Date = new Date(), asking?: string) {
  const drivers =
    viewer === "member"
      ? []
      : await ex.selectFrom("drivers").select(["driver_id", "first_name", "last_name", "account_status", "online_status", "vehicle_id", "fleet_linked_at"]).where("fleet_id", "=", row.fleet_id).orderBy("fleet_linked_at").execute();
  // v0.18.0 (owner decision 19): a member sees every car, without its documents, with whether he can pick it.
  const cars = await ex.selectFrom("vehicles").selectAll().where("fleet_id", "=", row.fleet_id).orderBy("created_at").execute();
  const vehicles = [];
  for (const car of cars) vehicles.push(await vehicleFullView(ex, car as never, viewer === "admin" ? undefined : { driverId: asking ?? row.owner_driver_id, owner: viewer === "owner" }));
  return {
    fleet: await fleetView(ex, row, viewer),
    drivers: drivers.map((d) => ({
      driverId: d.driver_id,
      firstName: d.first_name,
      ...(d.last_name ? { lastName: d.last_name } : {}),
      accountStatus: d.account_status,
      onlineStatus: d.online_status,
      ...(d.vehicle_id ? { vehicleId: d.vehicle_id } : {}),
      linkedAt: (d.fleet_linked_at ?? row.created_at).toISOString(),
    })),
    vehicles,
    // v0.5.3: the open invitations and requests (owner and admins; a member gets none).
    ...(viewer === "member" ? {} : { invitations: await fleetInvitationViews(ex, row, viewer, now) }),
  };
}

/* ---------------------------------------------------------------- the details screen */

type OnboardingBody = {
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  email: string;
  country: string;
  cityId: string;
  language: string;
  accountType: "driver" | "fleet";
  termsAccepted: boolean;
  company?: { name: string; orgNumber: string; address: string };
  fleetJoin?: { code: string; ownerName: string; ownerEmail: string };
};

/** POST /driver/onboarding: pending → on_hold; a fleet account gets its (pending) fleet; a driver may join one now. */
export async function submitOnboarding(trx: Trx, deps: InviteDeps, driverId: string, body: unknown, now: Date) {
  const problem = schemaProblem("DriverOnboardingRequest", body);
  if (problem !== null) throw badRequest(`The details are not valid: ${problem}.`, "invalid_body");
  const d = body as OnboardingBody;
  const row = await loadDriver(trx, driverId, true);
  if (row.account_status !== "pending" && row.account_status !== "on_hold") {
    throw new ApiError("invalid_transition", "Your details are already approved; ask support to change them.", { reason: "details_locked", projection: await driverView(trx, row, "driver") });
  }
  if (d.termsAccepted !== true) throw badRequest("Accept the terms to continue.", "terms_required");
  const country = ONBOARDING.countries[d.country];
  if (country === undefined || !country.open) throw badRequest(`Movera is not open in ${d.country} yet.`, "country_not_open");
  const city = cityOf(d.country, d.cityId);
  if (city === undefined) throw badRequest("Choose a city of your country.", "invalid_city");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.dateOfBirth) || Number.isNaN(new Date(d.dateOfBirth).getTime())) throw badRequest("The date of birth is not a date.", "invalid_date_of_birth");
  if (ageAt(d.dateOfBirth, now) < ONBOARDING.minAge) throw badRequest(`Drivers must be at least ${ONBOARDING.minAge}.`, "under_age");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email)) throw badRequest("The e-mail is not valid.", "invalid_email");
  if (d.accountType === "fleet" && d.company === undefined) throw badRequest("A fleet account names its company.", "company_required");
  if (row.account_type !== null && row.account_type !== d.accountType) {
    throw badRequest("The account type cannot change; ask support.", "account_type_locked");
  }

  await trx
    .updateTable("drivers")
    .set({
      first_name: d.firstName.trim(),
      last_name: d.lastName.trim(),
      date_of_birth: d.dateOfBirth,
      email: d.email.trim(),
      country: d.country,
      city_id: d.cityId,
      language: d.language,
      account_type: d.accountType,
      zone_ids: [city.zoneId],
      terms_accepted_at: row.terms_accepted_at ?? now,
      account_status: "on_hold",
      version: row.version + 1,
      updated_at: now,
    })
    .where("driver_id", "=", driverId)
    .execute();
  await recordAcceptance(trx, driverId, "terms", now);

  if (d.accountType === "fleet") {
    const company = d.company!;
    const existing = await trx.selectFrom("fleets").select(["fleet_id", "version"]).where("owner_driver_id", "=", driverId).executeTakeFirst();
    const values = { name: company.name.trim(), org_number: company.orgNumber.trim(), address: company.address.trim(), country: d.country, city_id: d.cityId, zone_id: city.zoneId, updated_at: now };
    if (existing) await trx.updateTable("fleets").set({ ...values, version: existing.version + 1 }).where("fleet_id", "=", existing.fleet_id).execute();
    else {
      const fleetId = newId("flt", now.getTime());
      await trx.insertInto("fleets").values({ fleet_id: fleetId, owner_driver_id: driverId, created_at: now, ...values }).execute();
      await trx.updateTable("drivers").set({ fleet_id: fleetId, fleet_linked_at: now }).where("driver_id", "=", driverId).execute();
    }
  } else if (d.fleetJoin !== undefined && row.fleet_id === null) {
    // A request the owner must accept (an owner's earlier invite of this number links at once).
    await requestJoin(trx, deps, driverId, d.fleetJoin, now, { quietIfPending: true });
  }
  return driverView(trx, await loadDriver(trx, driverId), "driver");
}

/* ---------------------------------------------------------------- joining and leaving */

/** A failed try, written outside the (rolled back) command transaction so it counts towards the hourly limit. */
export async function recordJoinTry(ex: Executor, driverId: string, now: Date): Promise<void> {
  await ex.insertInto("fleet_join_attempts").values({ driver_id: driverId, at: now }).execute();
}

/** Takes a driver out of his fleet: car released, offline, open offers withdrawn. Not during a trip. */
export async function unlinkFromFleet(trx: Trx, row: DriverRow, now: Date, reason: "left" | "removed_by_owner" | "removed_by_admin" | "fleet_blocked"): Promise<void> {
  const active = await trx.selectFrom("trips").select("trip_id").where("driver_id", "=", row.driver_id).where("status", "in", [...DRIVER_ASSIGNED]).executeTakeFirst();
  if (active) throw new ApiError("invalid_transition", "Finish the trip first.", { reason: "on_trip", projection: await driverView(trx, row, "driver") });
  await releaseCar(trx, row.driver_id);
  const online = ["online", "going_online"].includes(row.online_status);
  await trx
    .updateTable("drivers")
    .set({ fleet_id: reason === "fleet_blocked" ? row.fleet_id : null, fleet_linked_at: reason === "fleet_blocked" ? undefined : null, vehicle_id: null, ...(online ? { online_status: "offline", online_since: null } : {}), version: row.version + 1, updated_at: now })
    .where("driver_id", "=", row.driver_id)
    .execute();
  if (online) await scheduleTimer(trx, { kind: "withdraw_driver_offers", refId: row.driver_id, dueAt: now, payload: {} });
}

/**
 * POST /driver/fleet/start-company (contract v0.18.0, driverOnboarding.startCompany, owner item 7): a driver account
 * becomes a fleet account with a new pending company he owns, and waits on hold for Movera like a new fleet. He leaves
 * his fleet first (car released, offline). Every document he has stays: only the company's documents
 * (requiredFleetDocuments) he does not have yet and his new cars' are still needed.
 */
export async function startOwnCompany(trx: Trx, driverId: string, body: unknown, now: Date) {
  const problem = schemaProblem("StartCompanyRequest", body);
  if (problem !== null) throw badRequest(`The company is not valid: ${problem}.`, "invalid_body");
  const { expectedVersion, company } = body as { expectedVersion: number; company: { name: string; orgNumber: string; address: string } };
  let row = await loadDriver(trx, driverId, true);
  if (row.version !== expectedVersion) throw new ApiError("version_mismatch", "Your account changed since you last saw it.", { projection: await driverView(trx, row, "driver") });
  if (row.account_type !== "driver" || row.country === null || row.city_id === null) {
    throw new ApiError("invalid_transition", row.account_type === "fleet" ? "Your account is already a company." : "Send your details first.", { reason: row.account_type === "fleet" ? "already_fleet" : "details_required", projection: await driverView(trx, row, "driver") });
  }
  if (row.fleet_id !== null) {
    await unlinkFromFleet(trx, row, now, "left");
    row = await loadDriver(trx, driverId, true);
  } else {
    const active = await trx.selectFrom("trips").select("trip_id").where("driver_id", "=", driverId).where("status", "in", [...DRIVER_ASSIGNED]).executeTakeFirst();
    if (active) throw new ApiError("invalid_transition", "Finish the trip first.", { reason: "on_trip", projection: await driverView(trx, row, "driver") });
  }
  const city = cityOf(row.country!, row.city_id!);
  const fleetId = newId("flt", now.getTime());
  await trx.insertInto("fleets").values({ fleet_id: fleetId, owner_driver_id: driverId, name: company.name.trim(), org_number: company.orgNumber.trim(), address: company.address.trim(), country: row.country!, city_id: row.city_id!, zone_id: city?.zoneId ?? row.zone_ids[0]!, created_at: now, updated_at: now }).execute();
  const online = ["online", "going_online"].includes(row.online_status);
  await trx
    .updateTable("drivers")
    .set({ account_type: "fleet", account_status: row.account_status === "suspended" ? "suspended" : "on_hold", fleet_id: fleetId, fleet_linked_at: now, vehicle_id: null, ...(online ? { online_status: "offline", online_since: null } : {}), version: row.version + 1, updated_at: now })
    .where("driver_id", "=", driverId)
    .execute();
  // Requests to join other fleets are his no more.
  await trx.updateTable("fleet_invitations").set((eb) => ({ status: "cancelled", decided_at: now, decided_by: "system", updated_at: now, version: eb("version", "+", 1) })).where("driver_id", "=", driverId).where("status", "=", "pending").execute();
  return driverView(trx, await loadDriver(trx, driverId), "driver");
}

/** POST /driver/fleet/leave. */
export async function leaveFleet(trx: Trx, driverId: string, now: Date) {
  const row = await loadDriver(trx, driverId, true);
  if (row.fleet_id === null) throw new ApiError("invalid_transition", "You are not in a fleet.", { reason: "no_fleet", projection: await driverView(trx, row, "driver") });
  if (row.account_type === "fleet") throw new ApiError("invalid_transition", "The owner cannot leave his own fleet.", { reason: "fleet_owner", projection: await driverView(trx, row, "driver") });
  await unlinkFromFleet(trx, row, now, "left");
  return driverView(trx, await loadDriver(trx, driverId), "driver");
}

/** POST /driver/fleet/drivers/{driverId}/remove (the owner). */
export async function ownerRemoveDriver(trx: Trx, ownerId: string, driverId: string, now: Date): Promise<void> {
  const fleet = await ownedFleet(trx, ownerId);
  if (driverId === ownerId) throw new ApiError("invalid_transition", "The owner cannot leave his own fleet.", { reason: "fleet_owner" });
  const row = await loadDriver(trx, driverId, true);
  if (row.fleet_id !== fleet.fleet_id) throw notFound("That driver is not in your fleet.", "driver_not_in_fleet");
  await unlinkFromFleet(trx, row, now, "removed_by_owner");
}

/** GET /driver/fleet. */
export async function getDriverFleet(ex: Executor, driverId: string, now: Date) {
  const row = await loadDriver(ex, driverId);
  if (row.fleet_id === null) throw notFound("You are not in a fleet yet.", "no_fleet");
  const fleet = await loadFleet(ex, row.fleet_id);
  return fleetFullView(ex, fleet, fleet.owner_driver_id === driverId ? "owner" : "member", now, driverId);
}

/** GET /driver/fleet/earnings?from&to (the owner): every driver's net earnings in the period; default this week. */
export async function fleetEarnings(ex: Executor, ownerId: string, input: { from?: string | undefined; to?: string | undefined }, now: Date) {
  const fleet = await ownedFleet(ex, ownerId);
  const tz = COUNTRY_TIME_ZONE[fleet.country] ?? "Europe/Stockholm";
  const currency = COUNTRY_CURRENCY[fleet.country] ?? "SEK";
  const to = input.to ? new Date(input.to) : new Date(now.getTime() + 1);
  const from = input.from ? new Date(input.from) : (await sql<{ start: Date }>`SELECT (date_trunc('week', ${now}::timestamptz AT TIME ZONE ${tz}) AT TIME ZONE ${tz}) AS start`.execute(ex)).rows[0]!.start;
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) throw badRequest("from must be before to.", "invalid_range");
  const drivers = await ex.selectFrom("drivers").select(["driver_id", "first_name", "last_name"]).where("fleet_id", "=", fleet.fleet_id).orderBy("fleet_linked_at").execute();
  const ids = drivers.map((d) => d.driver_id);
  const sums = ids.length
    ? await sql<{ driver_id: string; trips: string; net: string }>`
        SELECT driver_id, count(*) FILTER (WHERE kind = 'trip') AS trips, coalesce(sum(amount_minor), 0) AS net
          FROM earnings_entries WHERE driver_id = ANY(${ids}) AND at >= ${from} AND at < ${to} GROUP BY driver_id`.execute(ex)
    : { rows: [] as { driver_id: string; trips: string; net: string }[] };
  const byDriver = new Map(sums.rows.map((r) => [r.driver_id, r]));
  let total = 0;
  const items = drivers.map((d) => {
    const s = byDriver.get(d.driver_id);
    const net = Number(s?.net ?? 0);
    total += net;
    return { driverId: d.driver_id, firstName: d.first_name, ...(d.last_name ? { lastName: d.last_name } : {}), trips: Number(s?.trips ?? 0), earnings: { amountMinor: net, currency } };
  });
  return { from: from.toISOString(), to: to.toISOString(), items, total: { amountMinor: total, currency } };
}

/* ---------------------------------------------------------------- admin */

export async function adminGetFleet(ex: Executor, who: Admin, fleetId: string, now: Date) {
  const fleet = await loadFleet(ex, fleetId);
  coversFleet(who, fleet);
  return fleetFullView(ex, fleet, "admin", now);
}

async function freshCode(trx: Trx): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const code = makeFleetCode((max) => randomInt(max));
    const taken = await trx.selectFrom("fleets").select("fleet_id").where("code", "=", code).executeTakeFirst();
    if (taken === undefined) return code;
  }
  throw new ApiError("internal", "Could not make a fleet code.", { reason: "code_space" });
}

/** POST /admin/fleets/{id}/review: approved makes the code; blocked takes every linked driver offline. */
export async function reviewFleet(trx: Trx, who: Admin, fleetId: string, body: { expectedVersion: number; decision: "approved" | "rejected" | "blocked"; note?: string | undefined }, now: Date) {
  const fleet = await loadFleet(trx, fleetId, true);
  coversFleet(who, fleet);
  if (fleet.version !== body.expectedVersion) throw new ApiError("version_mismatch", "The fleet changed since you last saw it.", { projection: await fleetView(trx, fleet, "admin") });
  const code = body.decision === "approved" && fleet.code === null ? await freshCode(trx) : fleet.code;
  await trx
    .updateTable("fleets")
    .set({ status: body.decision, code, review_note: body.note ?? null, reviewed_at: now, reviewed_by: who.subjectId, version: fleet.version + 1, updated_at: now })
    .where("fleet_id", "=", fleetId)
    .execute();
  if (body.decision !== "approved") await cancelFleetInvitations(trx, fleetId, who.subjectId, now);
  if (body.decision === "blocked") {
    const members = await trx.selectFrom("drivers").selectAll().where("fleet_id", "=", fleetId).forUpdate().execute();
    for (const member of members) {
      const row = member as unknown as DriverRow;
      const onTrip = await trx.selectFrom("trips").select("trip_id").where("driver_id", "=", row.driver_id).where("status", "in", [...DRIVER_ASSIGNED]).executeTakeFirst();
      if (onTrip) continue; // keeps the trip to its end; the next online is refused by the blocked fleet
      await unlinkFromFleet(trx, row, now, "fleet_blocked");
    }
  }
  await audit(trx, { adminId: who.subjectId, action: "fleet.review", targetType: "fleet", targetId: fleetId, zoneId: fleet.zone_id, detail: { from: fleet.status, to: body.decision, note: body.note ?? null }, at: now });
  return fleetView(trx, await loadFleet(trx, fleetId), "admin");
}

/** POST /admin/fleets/{id}/code: a new code; the old one stops working at once. */
export async function renewFleetCode(trx: Trx, who: Admin, fleetId: string, body: { expectedVersion: number }, now: Date) {
  const fleet = await loadFleet(trx, fleetId, true);
  coversFleet(who, fleet);
  if (fleet.version !== body.expectedVersion) throw new ApiError("version_mismatch", "The fleet changed since you last saw it.", { projection: await fleetView(trx, fleet, "admin") });
  if (fleet.status !== "approved") throw new ApiError("invalid_transition", "Only an approved fleet has a code.", { reason: "fleet_not_approved", projection: await fleetView(trx, fleet, "admin") });
  const code = await freshCode(trx);
  await trx.updateTable("fleets").set({ code, version: fleet.version + 1, updated_at: now }).where("fleet_id", "=", fleetId).execute();
  await audit(trx, { adminId: who.subjectId, action: "fleet.code", targetType: "fleet", targetId: fleetId, zoneId: fleet.zone_id, detail: {}, at: now });
  return fleetView(trx, await loadFleet(trx, fleetId), "admin");
}

/** POST /admin/fleets/{id}/drivers/{driverId}/remove. */
export async function adminRemoveFleetDriver(trx: Trx, who: Admin, fleetId: string, driverId: string, now: Date): Promise<void> {
  const fleet = await loadFleet(trx, fleetId);
  coversFleet(who, fleet);
  if (driverId === fleet.owner_driver_id) throw new ApiError("invalid_transition", "The owner cannot be removed from his own fleet.", { reason: "fleet_owner" });
  const row = await loadDriver(trx, driverId, true);
  if (row.fleet_id !== fleetId) throw notFound("That driver is not in this fleet.", "driver_not_in_fleet");
  await unlinkFromFleet(trx, row, now, "removed_by_admin");
  await audit(trx, { adminId: who.subjectId, action: "fleet.remove_driver", targetType: "fleet", targetId: fleetId, zoneId: fleet.zone_id, detail: { driverId }, at: now });
}

/** GET /admin/fleets (cursor page) within the admin's zones. */
export async function listFleets(ex: Executor, who: Admin, input: { cursor?: string | undefined; limit: number; status?: string[] | undefined; country?: string | undefined; zoneId?: string | undefined; q?: string | undefined }) {
  let q = ex.selectFrom("fleets").selectAll();
  if (!who.zones.includes("*")) q = q.where("zone_id", "in", who.zones.length ? who.zones : ["-"]);
  if (input.status?.length) q = q.where("status", "in", input.status as never);
  if (input.country) q = q.where("country", "=", input.country);
  if (input.zoneId) q = q.where("zone_id", "=", input.zoneId);
  if (input.q) {
    const text = `%${input.q.trim().replace(/[%_\\]/g, "")}%`;
    q = q.where((eb) => eb.or([eb("name", "ilike", text), eb("org_number", "like", text), eb("code", "=", normalizeFleetCode(input.q!)), eb("fleet_id", "=", input.q!.trim())]));
  }
  if (input.cursor) {
    const [at, id] = Buffer.from(input.cursor, "base64url").toString("utf8").split("|");
    q = q.where(sql<boolean>`(created_at, fleet_id) < (${new Date(at!)}, ${id!})`);
  }
  const rows = await q.orderBy("created_at", "desc").orderBy("fleet_id", "desc").limit(input.limit + 1).execute();
  const page = rows.slice(0, input.limit);
  const items = [];
  for (const r of page) items.push(await fleetView(ex, r as unknown as FleetRow, "admin"));
  const last = page[page.length - 1];
  return { items, nextCursor: rows.length > input.limit && last ? Buffer.from(`${last.created_at.toISOString()}|${last.fleet_id}`).toString("base64url") : null };
}
