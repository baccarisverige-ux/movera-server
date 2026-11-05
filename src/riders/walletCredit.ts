import { z } from "zod";
import type { Principal } from "../auth/guard.js";
import { contract } from "../contract/contract.js";
import type { Executor, Trx } from "../db/db.js";
import { ApiError, badRequest } from "../http/errors.js";
import { notify } from "../notifications/service.js";
import { liveDocument, standardKey } from "../config/service.js";
import { creditWallet } from "./wallet.js";
import { audit } from "../admin/audit.js";
import { adminRiderView, riderInZones, riderWallets, zonesOf } from "../admin/lists.js";

/**
 * v0.18.39 A2 (owner G12 Q5 "Real credit + limit", Q-D "Max 250 euro and equivalent", build-spec Q1 "One admin
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

/** The rider's zone and country: the zone of his latest trip, else his last seen zone; null when unknown. */
export async function riderPlace(ex: Executor, riderId: string): Promise<{ zoneId: string; country: string } | null> {
  const trip = await ex.selectFrom("trips").innerJoin("zones", "zones.zone_id", "trips.zone_id").select(["zones.zone_id", "zones.country"]).where("trips.rider_id", "=", riderId).orderBy("trips.created_at", "desc").limit(1).executeTakeFirst();
  if (trip) return { zoneId: trip.zone_id, country: trip.country };
  const seen = await ex.selectFrom("riders").innerJoin("zones", "zones.zone_id", "riders.last_seen_zone_id").select(["zones.zone_id", "zones.country"]).where("riders.rider_id", "=", riderId).executeTakeFirst();
  return seen ? { zoneId: seen.zone_id, country: seen.country } : null;
}

/**
 * CountryRules.walletCreditMax of the COUNTRY (fix job 0, owner A2-1 "Per country, in Pricing"): the country Standard's
 * value (Pricing › Tips & limits), in the country's currency; a zone's own value is ignored; else the contract default.
 */
export async function walletCreditMax(ex: Executor, country: string): Promise<Money | null> {
  const rules = await liveDocument<{ walletCreditMax?: Money }>(ex, "country_rules", standardKey(country));
  const own = rules?.document.walletCreditMax;
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
  const place = await riderPlace(trx, riderId);
  const country = place?.country;
  const currency = country ? CURRENCY[country] : undefined;
  if (!place || !country || !currency) throw new ApiError("conflict", "The rider's country is not known yet (no trip and no zone).", { reason: "rider_country_unknown" });
  if (body.amount.currency !== currency) throw badRequest(`This rider pays in ${currency}.`, "wallet_currency_mismatch");
  const max = await walletCreditMax(trx, country);
  if (max && body.amount.amountMinor > max.amountMinor) {
    throw new ApiError("invalid_request", "That is more than one credit may be in this country.", { reason: "wallet_credit_too_large", details: [`max ${max.amountMinor} ${max.currency}`] });
  }
  // Into the balance of the credit's own currency (wallet per currency, fix job 6), through the one wallet path.
  const entryId = await creditWallet(trx, riderId, { amountMinor: body.amount.amountMinor, currency }, null, now, "adjustment");
  await trx.updateTable("riders").set({ version: row.version + 1, updated_at: now }).where("rider_id", "=", riderId).execute();
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
  await audit(trx, { adminId: who.subjectId, action: "rider.wallet_credit", targetType: "rider", targetId: riderId, zoneId: place.zoneId, detail: { amountMinor: body.amount.amountMinor, currency, reason: body.reason, entryId, notificationId }, at: now });
  return adminRiderView(await trx.selectFrom("riders").selectAll().where("rider_id", "=", riderId).executeTakeFirstOrThrow(), currency, undefined, (await riderWallets(trx, [riderId])).get(riderId));
}
