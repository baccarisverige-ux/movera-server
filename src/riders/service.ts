import type { Executor, Trx } from "../db/db.js";
import { schemaProblem } from "../contract/schemas.js";
import { ApiError, badRequest } from "../http/errors.js";

/** The rider's own profile (contract §2 Rider, v0.5.1 outstanding / language / consents). */

type RiderRow = {
  rider_id: string;
  phone: string;
  first_name: string;
  email: string | null;
  status: "active" | "suspended";
  language: string | null;
  rating_sum: number;
  rating_count: number;
  version: number;
  outstanding_minor: string;
  outstanding_currency: string | null;
  consents: unknown;
};

/**
 * v0.18.7 (Q3, contract.json#pickupWaiting.debtByCurrency): what the rider owes per currency, oldest debt first.
 * Rider.outstanding is the first of them (riders.outstanding_minor / outstanding_currency keep that one).
 */
export async function outstandingByCurrency(ex: Executor, riderId: string): Promise<Array<{ amountMinor: number; currency: string }>> {
  const owed = await ex.selectFrom("rider_fees").select(["currency", "amount_minor"]).where("rider_id", "=", riderId).where("status", "=", "owed").orderBy("created_at").orderBy("trip_id").execute();
  const out: Array<{ amountMinor: number; currency: string }> = [];
  for (const fee of owed) {
    const entry = out.find((e) => e.currency === fee.currency);
    if (entry) entry.amountMinor += Number(fee.amount_minor);
    else out.push({ amountMinor: Number(fee.amount_minor), currency: fee.currency });
  }
  return out;
}

export function riderView(row: RiderRow, currency: string, byCurrency?: Array<{ amountMinor: number; currency: string }>): Record<string, unknown> {
  const outstanding = Number(row.outstanding_minor);
  return {
    riderId: row.rider_id,
    firstName: row.first_name,
    phone: row.phone,
    ...(row.email ? { email: row.email } : {}),
    ...(row.rating_count > 0 ? { rating: Math.round((row.rating_sum / row.rating_count) * 100) / 100 } : {}),
    status: row.status,
    version: row.version,
    // v0.18.7 (Q3): the owed fees in the rider's oldest owed currency; every currency in outstandingByCurrency.
    outstanding: outstanding > 0 ? { amountMinor: outstanding, currency: row.outstanding_currency ?? currency } : null,
    ...(byCurrency !== undefined ? { outstandingByCurrency: byCurrency } : {}),
    ...(row.language ? { language: row.language } : {}),
    consents: row.consents ?? {},
  };
}

async function loadRider(ex: Executor, riderId: string, lock = false): Promise<RiderRow> {
  let query = ex.selectFrom("riders").selectAll().where("rider_id", "=", riderId);
  if (lock) query = query.forUpdate();
  const row = await query.executeTakeFirst();
  if (row === undefined) throw new ApiError("not_found", "No such rider.", { reason: "rider_not_found" });
  return row as unknown as RiderRow;
}

export async function getRiderProfile(ex: Executor, riderId: string, currency: string) {
  return riderView(await loadRider(ex, riderId), currency, await outstandingByCurrency(ex, riderId));
}

export async function updateRiderProfile(trx: Trx, riderId: string, body: unknown, currency: string, now: Date) {
  const problem = schemaProblem("RiderProfileUpdate", body);
  if (problem !== null) throw badRequest(`The profile change is not valid: ${problem}.`, "invalid_body");
  const update = body as { expectedVersion: number; firstName?: string; email?: string; language?: string; consents?: Record<string, boolean> };
  const row = await loadRider(trx, riderId, true);
  if (row.version !== update.expectedVersion) {
    throw new ApiError("version_mismatch", "Your profile changed since you last saw it.", { projection: riderView(row, currency) });
  }
  if (update.firstName !== undefined && update.firstName.trim() === "") throw badRequest("The first name cannot be empty.", "invalid_body");
  await trx
    .updateTable("riders")
    .set({
      ...(update.firstName !== undefined ? { first_name: update.firstName.trim() } : {}),
      ...(update.email !== undefined ? { email: update.email } : {}),
      ...(update.language !== undefined ? { language: update.language } : {}),
      ...(update.consents !== undefined ? { consents: JSON.stringify({ ...((row.consents as object) ?? {}), ...update.consents }) } : {}),
      version: row.version + 1,
      updated_at: now,
    })
    .where("rider_id", "=", riderId)
    .execute();
  return riderView(await loadRider(trx, riderId), currency, await outstandingByCurrency(trx, riderId));
}

export async function requestDeletion(trx: Trx, riderId: string, now: Date) {
  await trx.updateTable("riders").set({ deletion_requested_at: now }).where("rider_id", "=", riderId).where("deletion_requested_at", "is", null).execute();
  return { status: "requested" as const };
}
