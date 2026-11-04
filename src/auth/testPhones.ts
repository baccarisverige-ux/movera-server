import type { Executor } from "../db/db.js";
import type { Env } from "../env.js";

/**
 * The test group's numbers (owner decision 1): the PTS fiction range +46 70 174 06 05 … 06 10, which belongs to
 * no real subscriber. Each works in both apps. They sign in with the contract's fixed code and only outside
 * production; production never reads this table.
 */
export const TEST_PHONES: readonly string[] = ["+46701740605", "+46701740606", "+46701740607", "+46701740608", "+46701740609", "+46701740610"];

/** Most extra numbers one server takes (the big test needs 200; a typo like a whole country range is refused). */
export const MAX_EXTRA_TEST_PHONES = 1000;

const E164 = /^\+[1-9][0-9]{6,14}$/;

/**
 * Extra test numbers for the staging server's big test (owner 2026-11-03 "add even 100 numbers"), from
 * MOVERA_EXTRA_TEST_PHONES: a comma list of numbers and ranges "+46701740611-+46701740660" (both ends included,
 * same length). Answers the numbers in order without repeats, or throws with what is wrong. Never read in production
 * (env.ts refuses the setting there).
 */
export function parseExtraTestPhones(value: string | undefined): string[] {
  const out = new Set<string>();
  for (const raw of (value ?? "").split(",")) {
    const entry = raw.replace(/\s+/g, "");
    if (entry === "") continue;
    const [from, to, ...rest] = entry.split(/-(?=\+)/);
    if (rest.length > 0 || from === undefined || !E164.test(from) || (to !== undefined && !E164.test(to))) {
      throw new Error(`"${entry}" is not a number like +46701740611 or a range like +46701740611-+46701740660`);
    }
    if (to === undefined) {
      out.add(from);
    } else {
      if (to.length !== from.length) throw new Error(`range "${entry}": both ends need the same number of digits`);
      const start = BigInt(from.slice(1));
      const end = BigInt(to.slice(1));
      if (end < start) throw new Error(`range "${entry}": the first number is after the last`);
      if (end - start + 1n > BigInt(MAX_EXTRA_TEST_PHONES)) throw new Error(`range "${entry}": more than ${MAX_EXTRA_TEST_PHONES} numbers`);
      for (let n = start; n <= end; n++) out.add(`+${n.toString()}`);
    }
    if (out.size > MAX_EXTRA_TEST_PHONES) throw new Error(`more than ${MAX_EXTRA_TEST_PHONES} extra test numbers`);
  }
  return [...out];
}

/** The numbers a server seeds at start: none in production, else the six plus MOVERA_EXTRA_TEST_PHONES. */
export function testPhonesFor(env: Pick<Env, "MOVERA_ENV" | "MOVERA_EXTRA_TEST_PHONES">): string[] {
  if (env.MOVERA_ENV === "production") return [];
  return [...new Set([...TEST_PHONES, ...env.MOVERA_EXTRA_TEST_PHONES])];
}

export async function seedTestPhones(ex: Executor, phones: readonly string[] = TEST_PHONES): Promise<void> {
  if (phones.length === 0) return;
  await ex
    .insertInto("test_phones")
    .values(phones.flatMap((phone) => (["rider", "driver"] as const).map((app) => ({ phone, app, note: "test group" }))))
    .onConflict((conflict) => conflict.columns(["phone", "app"]).doNothing())
    .execute();
}
