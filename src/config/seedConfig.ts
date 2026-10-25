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

export async function seedSampleConfig(trx: Trx, now: Date = new Date()): Promise<{ doc: ConfigDoc; zoneId: string; version: number }[]> {
  const zones = await trx.selectFrom("zones").select("zone_id").where("open", "=", true).orderBy("zone_id").execute();
  const published: { doc: ConfigDoc; zoneId: string; version: number }[] = [];
  for (const zone of zones) {
    for (const doc of CONFIG_DOCS) {
      if ((await liveDocument(trx, doc, zone.zone_id)) !== null) continue;
      const sample = contractJson<Record<string, unknown>>(FIXTURES[doc]);
      const document = { ...sample, zoneId: zone.zone_id };
      // A first document has no draft yet: the server then counts it as version 1 (as the panel's first save).
      const draft = await trx.selectFrom("config_drafts").select("version").where("doc", "=", doc).where("zone_id", "=", zone.zone_id).executeTakeFirst();
      const saved = await putDraft(trx, { doc, zoneId: zone.zone_id, expectedVersion: draft?.version ?? 1, document, adminId: SEED_BY }, now);
      const made = await publishDraft(trx, { doc, zoneId: zone.zone_id, expectedVersion: saved.version, note: "sample settings (seed-test)", publishedBy: SEED_BY, approvedBy: null }, now);
      published.push({ doc, zoneId: zone.zone_id, version: made.version });
    }
  }
  return published;
}
