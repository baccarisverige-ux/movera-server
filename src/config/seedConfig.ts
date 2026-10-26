import type { Trx } from "../db/db.js";
import { contractJson } from "../contract/contract.js";
import type { ConfigDoc } from "../db/schema.js";
import { CONFIG_DOCS, liveDocument, publishDraft, putDraft } from "./service.js";

/**
 * The test week's starting settings: in every open zone that has no live document yet, the contract's sample
 * document (contracts/fixtures/config) is published for that zone, so quotes and dispatch work before anyone opens
 * the settings in the admin panel. A zone that already has a live document keeps it. Not for production.
 */
const FIXTURES: Record<ConfigDoc, string> = {
  rider_app_config: "fixtures/config/rider_app_config.json",
  driver_app_config: "fixtures/config/driver_app_config.json",
  pricing: "fixtures/config/pricing_document.json",
  dispatch: "fixtures/config/dispatch_document.json",
};

export const SEED_BY = "seed";

/** Minor units of one Swedish krona in the other currencies the server knows (rough, for sample prices only). */
const PER_SEK: Record<string, { rate: number; step: number }> = {
  EUR: { rate: 0.09, step: 10 }, // 1 kr ≈ 0.09 €, prices in whole 10 cents
  TND: { rate: 0.28, step: 50 }, // 1 kr ≈ 0.28 DT (3 decimals), prices in 50 millimes
};

type SampleZone = { zoneId: string; currency: string; country: string; timeZone: string };

/**
 * The contract's sample document as the zone's own: its id, and for a zone in another currency every amount
 * converted from the Swedish sample (a document must carry the zone's currency, country and time zone,
 * config/service.ts checkDocument). Samples only: the admin sets the real prices in the panel.
 */
export function sampleForZone(sample: Record<string, unknown>, zone: SampleZone): Record<string, unknown> {
  const money = PER_SEK[zone.currency];
  const convert = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(convert);
    if (value === null || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    if (typeof record["amountMinor"] === "number" && record["currency"] === "SEK" && money !== undefined) {
      const amount = Math.round((record["amountMinor"] * money.rate) / money.step) * money.step;
      return { ...record, amountMinor: amount, currency: zone.currency };
    }
    return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, convert(v)]));
  };
  const document = (zone.currency === "SEK" ? sample : convert(sample)) as Record<string, unknown>;
  return {
    ...document,
    zoneId: zone.zoneId,
    ...("currency" in sample ? { currency: zone.currency } : {}),
    ...("country" in sample ? { country: zone.country } : {}),
    ...("timeZone" in sample ? { timeZone: zone.timeZone } : {}),
  };
}

export async function seedSampleConfig(trx: Trx, now: Date = new Date()): Promise<{ doc: ConfigDoc; zoneId: string; version: number }[]> {
  const zones = await trx.selectFrom("zones").select(["zone_id", "currency", "country", "time_zone"]).where("open", "=", true).orderBy("zone_id").execute();
  const published: { doc: ConfigDoc; zoneId: string; version: number }[] = [];
  for (const zone of zones) {
    for (const doc of CONFIG_DOCS) {
      if ((await liveDocument(trx, doc, zone.zone_id)) !== null) continue;
      const sample = contractJson<Record<string, unknown>>(FIXTURES[doc]);
      const document = sampleForZone(sample, { zoneId: zone.zone_id, currency: zone.currency, country: zone.country, timeZone: zone.time_zone });
      // A first document has no draft yet: the server then counts it as version 1 (as the panel's first save).
      const draft = await trx.selectFrom("config_drafts").select("version").where("doc", "=", doc).where("zone_id", "=", zone.zone_id).executeTakeFirst();
      const saved = await putDraft(trx, { doc, zoneId: zone.zone_id, expectedVersion: draft?.version ?? 1, document, adminId: SEED_BY }, now);
      const made = await publishDraft(trx, { doc, zoneId: zone.zone_id, expectedVersion: saved.version, note: "sample settings (seed-test)", publishedBy: SEED_BY, approvedBy: null }, now);
      published.push({ doc, zoneId: zone.zone_id, version: made.version });
    }
  }
  return published;
}
