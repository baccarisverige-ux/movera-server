import type { Executor } from "../db/db.js";

/**
 * The test group's numbers (owner decision 1): the PTS fiction range +46 70 174 06 05 … 06 10, which belongs to
 * no real subscriber. Each works in both apps. They sign in with the contract's fixed code and only outside
 * production; production never reads this table.
 */
export const TEST_PHONES: readonly string[] = ["+46701740605", "+46701740606", "+46701740607", "+46701740608", "+46701740609", "+46701740610"];

export async function seedTestPhones(ex: Executor, phones: readonly string[] = TEST_PHONES): Promise<void> {
  if (phones.length === 0) return;
  await ex
    .insertInto("test_phones")
    .values(phones.flatMap((phone) => (["rider", "driver"] as const).map((app) => ({ phone, app, note: "test group" }))))
    .onConflict((conflict) => conflict.columns(["phone", "app"]).doNothing())
    .execute();
}
