import type { Db } from "../../src/db/db.js";
import type { CodeSms, CodeSmsOutcome, CodeSmsSender } from "../../src/sms/elks.js";

/** A fake SMS company for tests: keeps what it was handed; `next` decides the answer of the next sends. */
export class FakeCodeSms implements CodeSmsSender {
  readonly name = "fake";
  readonly sent: CodeSms[] = [];
  next: CodeSmsOutcome | "throw" = { accepted: true, ref: "fake-ref" };
  delayMs = 0;
  async send(message: CodeSms): Promise<CodeSmsOutcome> {
    this.sent.push(message);
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (this.next === "throw") throw new Error("the fake SMS company threw");
    return this.next;
  }
  /** The code in the newest SMS (the first run of digits in its text). */
  lastCode(): string {
    return /\d{4,8}/.exec(this.sent.at(-1)?.text ?? "")?.[0] ?? "";
  }
}

let version = 100;
/** Publishes CountryRules.smsSignIn for a country standard, as the admin's publish would store it. */
export async function setSmsSignIn(db: Db, country: string, smsSignIn: unknown, at: Date = new Date()): Promise<void> {
  const document = JSON.stringify({ country, ...(smsSignIn === undefined ? {} : { smsSignIn }) });
  await db
    .insertInto("config_live")
    .values({ doc: "country_rules", zone_id: `standard-${country}`, version: ++version, document, published_at: at, published_by: null })
    .onConflict((oc) => oc.columns(["doc", "zone_id"]).doUpdateSet({ version, document, published_at: at }))
    .execute();
}
