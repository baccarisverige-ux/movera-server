import { sql } from "kysely";
import { z } from "zod";
import type { Executor, Trx } from "../db/db.js";
import { ApiError, badRequest } from "../http/errors.js";
import { newId } from "../ids.js";
import { parseBody } from "../http/validate.js";
import "./walletSchema.js";

/**
 * The rider's wallet (contract §1 "wallet": one balance per currency, used first; v0.18.28 owner Q4) and where a refund goes (owner decision 30):
 * the wallet at once, or Swish / a bank account, paid by hand by an admin. Sweden: Swish or bank; France and
 * Tunisia: bank (IBAN) only.
 */

/** Every balance the rider holds (rider_wallets, migration 0070): one per currency, never converted (owner Q4). */
export async function walletBalances(ex: Executor, riderId: string): Promise<Array<{ amountMinor: number; currency: string }>> {
  const rows = await ex.selectFrom("rider_wallets").select(["currency", "balance_minor"]).where("rider_id", "=", riderId).where("balance_minor", "<>", "0").orderBy("currency").execute();
  return rows.map((r) => ({ amountMinor: Number(r.balance_minor), currency: r.currency }));
}

/** The rider's balance in one currency (0 when he holds none). */
export async function walletBalance(ex: Executor, riderId: string, currency: string, lock = false): Promise<number> {
  let q = ex.selectFrom("rider_wallets").select("balance_minor").where("rider_id", "=", riderId).where("currency", "=", currency);
  if (lock) q = q.forUpdate();
  const row = await q.executeTakeFirst();
  return row ? Number(row.balance_minor) : 0;
}

/** Adds (or, negative, takes) money in one currency's balance. */
export async function moveWallet(trx: Trx, riderId: string, currency: string, deltaMinor: number, now: Date) {
  await trx
    .insertInto("rider_wallets")
    .values({ rider_id: riderId, currency, balance_minor: deltaMinor, updated_at: now })
    .onConflict((oc) => oc.columns(["rider_id", "currency"]).doUpdateSet({ balance_minor: sql`rider_wallets.balance_minor + ${deltaMinor}`, updated_at: now }))
    .execute();
}

/** The currency of the rider's zone (where he last looked at the map or prices), else the given fallback. */
async function riderCurrency(ex: Executor, riderId: string, fallback: string): Promise<string> {
  const row = await ex.selectFrom("riders").leftJoin("zones", "zones.zone_id", "riders.last_seen_zone_id").select("zones.currency").where("riders.rider_id", "=", riderId).executeTakeFirstOrThrow();
  return row.currency ?? fallback;
}

/**
 * GET /wallet (v0.18.28): `balance` is the balance in `currency` (the query), else in the currency of the rider's zone;
 * `balances` lists every non-zero balance, one per currency.
 */
export async function getWallet(ex: Executor, riderId: string, fallbackCurrency: string, asked?: string) {
  const row = await ex.selectFrom("riders").select(["updated_at"]).where("rider_id", "=", riderId).executeTakeFirstOrThrow();
  const currency = asked ?? (await riderCurrency(ex, riderId, fallbackCurrency));
  const balances = await walletBalances(ex, riderId);
  const amountMinor = balances.find((b) => b.currency === currency)?.amountMinor ?? 0;
  const last = await ex.selectFrom("rider_wallets").select(sql<Date>`max(updated_at)`.as("at")).where("rider_id", "=", riderId).executeTakeFirst();
  const updatedAt = last?.at && last.at > row.updated_at ? last.at : row.updated_at;
  return { ownerId: riderId, balance: { amountMinor, currency }, balances, updatedAt: updatedAt.toISOString() };
}

export async function walletEntries(ex: Executor, riderId: string, input: { cursor?: string; limit: number; from?: string; to?: string }) {
  let q = ex.selectFrom("wallet_entries").selectAll().where("rider_id", "=", riderId);
  if (input.from) q = q.where("at", ">=", new Date(input.from));
  if (input.to) q = q.where("at", "<", new Date(input.to));
  if (input.cursor) q = q.where("entry_id", "<", input.cursor);
  const rows = await q.orderBy("entry_id", "desc").limit(input.limit + 1).execute();
  const page = rows.slice(0, input.limit);
  return {
    items: page.map((e) => ({ entryId: e.entry_id, ownerId: e.rider_id, amount: { amountMinor: Number(e.amount_minor), currency: e.currency }, kind: e.kind, ...(e.trip_id ? { tripId: e.trip_id } : {}), at: e.at.toISOString() })),
    nextCursor: rows.length > input.limit ? page[page.length - 1]!.entry_id : null,
  };
}

/** Puts money in the wallet (a refund the rider chose to keep there). */
export async function creditWallet(trx: Trx, riderId: string, amount: { amountMinor: number; currency: string }, tripId: string | null, now: Date, kind: "refund" | "adjustment" = "refund"): Promise<string> {
  // v0.18.28 (owner Q4): into the balance of the money's own currency (a France refund is EUR), never another.
  // v0.18.29 fix job 0: an admin's Add money to wallet uses this same path (kind adjustment).
  await moveWallet(trx, riderId, amount.currency, amount.amountMinor, now);
  const entryId = newId("wlt", now.getTime());
  await trx.insertInto("wallet_entries").values({ entry_id: entryId, rider_id: riderId, kind, currency: amount.currency, amount_minor: amount.amountMinor, trip_id: tripId, at: now }).execute();
  return entryId;
}

const Destination = z.discriminatedUnion("method", [
  z.object({ method: z.literal("wallet") }),
  z.object({ method: z.literal("swish"), swish: z.object({ phone: z.string().regex(/^\+46\d{7,10}$/, "a Swedish mobile number like +46701234567") }) }),
  z.object({
    method: z.literal("bank"),
    bank: z.union([
      z.object({ clearingNumber: z.string().regex(/^\d{4,5}$/), accountNumber: z.string().regex(/^\d{6,12}$/), holderName: z.string().min(2).max(120) }),
      z.object({ iban: z.string().transform((v) => v.replace(/\s+/g, "").toUpperCase()).pipe(z.string().regex(/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/)), bic: z.string().regex(/^[A-Z0-9]{8}([A-Z0-9]{3})?$/).optional(), holderName: z.string().min(2).max(120) }),
    ]),
  }),
]);

type RefundRow = { refund_id: string; trip_id: string; currency: string; amount_minor: string; reason: string; status: string; destination: string | null; payout_status: string | null; paid_at: Date | null; created_at: Date; payout_to: unknown };

/** The rider's view: the refund, where it went, and the payout account masked. */
export function riderRefundView(r: RefundRow) {
  const to = r.payout_to as { swish?: { phone: string }; bank?: { accountNumber?: string; iban?: string } } | null;
  const masked = to?.swish ? `Swish ••${to.swish.phone.slice(-4)}` : to?.bank ? `Bank ••${(to.bank.iban ?? to.bank.accountNumber ?? "").slice(-4)}` : null;
  return {
    refundId: r.refund_id,
    tripId: r.trip_id,
    amount: { amountMinor: Number(r.amount_minor), currency: r.currency },
    reason: r.reason,
    status: r.status,
    destination: r.destination,
    payoutStatus: r.payout_status,
    ...(masked ? { payoutTo: masked } : {}),
    ...(r.paid_at ? { paidAt: r.paid_at.toISOString() } : {}),
    createdAt: r.created_at.toISOString(),
    // The choices the rider has while destination is null.
    ...(r.destination === null && r.status === "done" ? { choices: [] as string[] } : {}),
  };
}

async function countryOfTrip(ex: Executor, tripId: string): Promise<string> {
  const row = await ex.selectFrom("trips").innerJoin("zones", "zones.zone_id", "trips.zone_id").select("zones.country").where("trips.trip_id", "=", tripId).executeTakeFirstOrThrow();
  return row.country;
}

const choicesFor = (country: string) => (country === "SE" ? ["wallet", "swish", "bank"] : ["wallet", "bank"]);

export async function riderRefunds(ex: Executor, riderId: string) {
  const rows = await ex.selectFrom("refunds").selectAll().where("rider_id", "=", riderId).where("status", "=", "done").orderBy("created_at", "desc").limit(100).execute();
  const items = [];
  for (const r of rows) {
    const view = riderRefundView(r);
    if ("choices" in view) view.choices = choicesFor(await countryOfTrip(ex, r.trip_id));
    items.push(view);
  }
  return { items, nextCursor: null };
}

/** POST /rider/refunds/{refundId}/destination: the rider's one choice for a refund. */
export async function chooseRefundDestination(trx: Trx, riderId: string, refundId: string, body: unknown, now: Date) {
  const choice = parseBody(Destination, body);
  const r = await trx.selectFrom("refunds").selectAll().where("refund_id", "=", refundId).forUpdate().executeTakeFirst();
  if (!r || r.rider_id !== riderId || r.status !== "done") throw new ApiError("not_found", "No such refund.", { reason: "refund_not_found" });
  if (r.destination !== null) throw new ApiError("conflict", "You already chose where this refund goes.", { reason: "destination_chosen" });
  const country = await countryOfTrip(trx, r.trip_id);
  if (!choicesFor(country).includes(choice.method)) throw badRequest("Swish is only available in Sweden; choose your wallet or a bank account.", "method_not_available");
  if (choice.method === "bank") {
    const swedish = "clearingNumber" in choice.bank;
    if (swedish !== (country === "SE")) throw badRequest(country === "SE" ? "Give your clearing and account number." : "Give your IBAN.", "bank_details_invalid");
  }
  if (choice.method === "wallet") {
    await creditWallet(trx, riderId, { amountMinor: Number(r.amount_minor), currency: r.currency }, r.trip_id, now);
    await trx.updateTable("refunds").set({ destination: "wallet" }).where("refund_id", "=", refundId).execute();
  } else {
    const payoutTo = choice.method === "swish" ? { swish: choice.swish } : { bank: choice.bank };
    await trx.updateTable("refunds").set({ destination: choice.method, payout_to: JSON.stringify(payoutTo), payout_status: "pending" }).where("refund_id", "=", refundId).execute();
  }
  const row = await trx.selectFrom("refunds").selectAll().where("refund_id", "=", refundId).executeTakeFirstOrThrow();
  return riderRefundView(row);
}

/** The admin's list of refunds to pay by hand (Swish / bank), with the full account so they can send it. */
export async function payoutsToMake(ex: Executor, input: { status: "pending" | "paid"; zones: string[] | null }) {
  let q = ex
    .selectFrom("refunds")
    .innerJoin("riders", "riders.rider_id", "refunds.rider_id")
    .innerJoin("trips", "trips.trip_id", "refunds.trip_id")
    .selectAll("refunds")
    .select(["riders.first_name", "riders.phone"])
    .where("refunds.payout_status", "=", input.status);
  // Only the admin's zones: payout accounts are personal data.
  if (input.zones) q = q.where("trips.zone_id", "in", input.zones.length ? input.zones : ["-"]);
  const rows = await q
    .orderBy("refunds.created_at")
    .limit(200)
    .execute();
  return {
    items: rows.map((r) => ({ ...riderRefundView(r), riderId: r.rider_id, riderName: r.first_name, riderPhone: r.phone, payoutTo: r.payout_to })),
    nextCursor: null,
  };
}
