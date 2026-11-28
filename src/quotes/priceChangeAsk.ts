import type { Executor } from "../db/db.js";
import { ApiError, badRequest } from "../http/errors.js";

/**
 * v0.18.174 (contract.json#priceChangeAsk; owner 2026-11-28 "When price more allways show", "No popup, book lower"):
 * a booking that names the quote the rider saw (`agreedQuoteId`) is compared with the fresh quote on minor units.
 * Lower or the same: booked silently at the fresh total. Higher by ANY amount: 409 price_changed_ask until the rider
 * accepts (`priceAccepted: true`). No tolerance, no setting. The agreed quote is read WITHOUT the expiry / used checks
 * (it has normally run out, which is why the app priced again); a missing one counts as a rise; another rider's (or
 * another category / kind) is quote_mismatch. Without agreedQuoteId nothing changes (older apps). This only decides
 * whether to book: the fare is always the fresh quote row, never a client number.
 */
export type PriceChangeAsk = { agreedQuoteId?: string; priceAccepted?: boolean };
export type FreshQuote = { quote_id: string; category_id: string; kind: string; total_minor: number | string | bigint; currency: string };

export async function checkPriceChange(ex: Executor, riderId: string, fresh: FreshQuote, ask: PriceChangeAsk): Promise<void> {
  if (ask.agreedQuoteId === undefined) return;
  const freshMinor = Number(fresh.total_minor);
  let agreedMinor: number | null = null;
  if (ask.agreedQuoteId === fresh.quote_id) {
    agreedMinor = freshMinor;
  } else {
    const agreed = await ex
      .selectFrom("quotes")
      .select(["rider_id", "category_id", "kind", "total_minor", "currency"])
      .where("quote_id", "=", ask.agreedQuoteId)
      .executeTakeFirst();
    if (agreed !== undefined) {
      if (agreed.rider_id !== riderId || agreed.category_id !== fresh.category_id || agreed.kind !== fresh.kind || agreed.currency !== fresh.currency) {
        throw badRequest("The ride does not match its price. Ask for a new one.", "quote_mismatch");
      }
      agreedMinor = Number(agreed.total_minor);
    }
  }
  const rise = agreedMinor === null || freshMinor > agreedMinor;
  if (rise && ask.priceAccepted !== true) {
    throw new ApiError("conflict", "The price went up. Check the new price and book again.", {
      reason: "price_changed_ask",
      details: [`fresh:${freshMinor} ${fresh.currency}`, agreedMinor === null ? "agreed:unknown" : `agreed:${agreedMinor} ${fresh.currency}`],
    });
  }
}
