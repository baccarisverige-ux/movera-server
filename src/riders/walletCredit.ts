import { sql } from "kysely";
import { z } from "zod";
import type { Principal } from "../auth/guard.js";
import { contract } from "../contract/contract.js";
import type { Executor, Trx } from "../db/db.js";
import { ApiError, badRequest } from "../http/errors.js";
import { newId } from "../ids.js";
import { notify } from "../notifications/service.js";
import { audit } from "../admin/audit.js";
import { adminRiderView, riderInZones, zonesOf } from "../admin/lists.js";

/**
 * v0.18.16 A2 (owner G12 Q5 "Real credit + limit", Q-D "Max 250 euro and equivalent", build-spec Q1 "One admin
 * always", Q2 "One button on rider page"; contract.json#walletCredit): POST /admin/riders/{riderId}/wallet-credit.
 */
type Money = { amountMinor: number; currency: string };
const WC = (contract as unknown as {
  walletCredit: { defaultMax: Record<string, Money>; reasonMax: number; riderText: Record<string, Record<string, string>> };
}).walletCredit;
const CURRENCY: Record<string, string> = { SE: "SEK", FR: "EUR", TN: "TND" };

export const WalletCreditBody = z.object({
  amount: z.object({ amountMinor: z.number().int().positive(), currency: z.string().regex(/^[A-Z]{3}$/) }),
  reason: z.string().trim().min(1).max(WC.reasonMax),
});

/** The rider's country: the zone of his latest trip, else his last seen zone; null when unknown. */
export async function riderCountry(ex: Executor, riderId: string): Promise<string | null> {
  const trip = await ex.selectFrom("trips").innerJoin("zones", "zones.zone_id", "trips.zone_id").select("zones.country").where("trips.rider_id", "=", riderId).orderBy("trips.created_at", "desc").limit(1).executeTakeFirst();
  if (trip) return trip.country;
  const seen = await ex.selectFrom("riders").innerJoin("zones", "zones.zone_id", "riders.last_seen_zone_id").select("zones.country").where("riders.rider_id", "=", riderId).executeTakeFirst();
  return seen?.country ?? null;
}

/** CountryRules.walletCreditMax of the country standard, else the contract default for the country. */
export async function walletCreditMax(ex: Executor, country: string): Promise<Money | null> {
  const row = await ex.selectFrom("config_live").select("document").where("doc", "=", "country_rules").where("zone_id", "=", `standard-${country}`).executeTakeFirst();
  const own = (row?.document as { walletCreditMax?: Money } | undefined)?.walletCreditMax;
  if (own && own.currency === CURRENCY[country] && Number.isInteger(own.amountMinor) && own.amountMinor > 0) return own;
  return WC.defaultMax[country] ?? null;
}

const amountText = (m: Money, lang: string) => {
  const digits = m.currency === "TND" ? 1000 : 100;
  const value = (m.amountMinor / digits).toLocaleString(lang === "en" ? "en-GB" : lang === "fr" ? "fr-FR" : "sv-SE", { minimumFractionDigits: m.amountMinor % digits === 0 ? 0 : 2, maximumFractionDigits: 3 });
  return m.currency === "SEK" ? `${value} kr` : m.currency === "EUR" ? `${value} €` : `${value} DT`;
};

export async function creditRiderWallet(trx: Trx, who: Principal, riderId: string, body: z.infer<typeof WalletCreditBody>, now: Date) {
  const row = await trx.selectFrom("riders").selectAll().where("rider_id", "=", riderId).forUpdate().executeTakeFirst();
  if (!row) throw new ApiError("not_found", "No such rider.", { reason: "rider_not_found" });
  const zones = zonesOf(who);
  if (zones) {
    const seen = await trx.selectFrom("riders").select("rider_id").where("rider_id", "=", riderId).where(riderInZones(zones)).executeTakeFirst();
    if (!seen) throw new ApiError("forbidden", "This rider has not ridden in your zones.", { reason: "zone_out_of_scope" });
  }
  const country = await riderCountry(trx, riderId);
  const currency = country ? CURRENCY[country] : undefined;
  if (!country || !currency) throw new ApiError("conflict", "The rider's country is not known yet (no trip and no zone).", { reason: "rider_country_unknown" });
  if (body.amount.currency !== currency) throw badRequest(`This rider pays in ${currency}.`, "wallet_currency_mismatch");
  // One balance per rider: money already there in another currency is never mixed with this one.
  const last = await trx.selectFrom("wallet_entries").select("currency").where("rider_id", "=", riderId).orderBy("at", "desc").orderBy("entry_id", "desc").limit(1).executeTakeFirst();
  if (Number(row.wallet_minor) > 0 && last && last.currency !== currency) throw badRequest(`The rider's wallet already holds ${last.currency}.`, "wallet_currency_mismatch");
  const max = await walletCreditMax(trx, country);
  if (max && body.amount.amountMinor > max.amountMinor) {
    throw new ApiError("invalid_request", "That is more than one credit may be in this country.", { reason: "wallet_credit_too_large", details: [`max ${max.amountMinor} ${max.currency}`] });
  }
  await trx.updateTable("riders").set({ wallet_minor: sql`wallet_minor + ${body.amount.amountMinor}`, version: row.version + 1, updated_at: now }).where("rider_id", "=", riderId).execute();
  const entryId = newId("wlt", now.getTime());
  await trx.insertInto("wallet_entries").values({ entry_id: entryId, rider_id: riderId, kind: "adjustment", currency, amount_minor: body.amount.amountMinor, trip_id: null, at: now }).execute();
  const lang = ["sv", "fr", "en"].includes((row.language ?? "").slice(0, 2)) ? row.language!.slice(0, 2) : country === "FR" ? "fr" : "sv";
  const notificationId = await notify(trx, {
    audience: "rider",
    subjectId: riderId,
    kind: "wallet_credit",
    title: WC.riderText["pushTitle"]![lang]!,
    body: WC.riderText["pushBody"]![lang]!.replace("{amount}", amountText(body.amount, lang)),
    deepLink: "movera-rider://wallet",
    data: { entryId },
  }, now);
  await audit(trx, { adminId: who.subjectId, action: "rider.wallet_credit", targetType: "rider", targetId: riderId, detail: { amountMinor: body.amount.amountMinor, currency, reason: body.reason, entryId, notificationId }, at: now });
  return adminRiderView(await trx.selectFrom("riders").selectAll().where("rider_id", "=", riderId).executeTakeFirstOrThrow(), currency);
}
