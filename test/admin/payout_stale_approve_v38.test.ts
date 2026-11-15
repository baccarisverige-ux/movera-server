import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { approvePayoutRun, closePeriods } from "../../src/admin/payouts.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver } from "../support/seed.js";

/**
 * BQ-V38 stale-approve guard (contract v0.18.102, contract.json#payoutMode.approveGuard; owner item 105 / Q-M8
 * "Refresh, approve again (Rec.)", Rules decisions/session-2026-11-06.md:1119: "if the numbers changed while the admin
 * looked, Approve refreshes the card … and asks for Approve again; Movera never pays a total the admin did not see").
 * POST /admin/payouts/runs/approve carries what the admin saw (expectedCount + expectedTotal, one Money per currency);
 * when the run no longer matches, 409 conflict run_changed with the fresh card, and nothing is approved.
 */

let database: TestDatabase;
let n = 0;
beforeAll(async () => {
  database = await freshDatabase();
});
afterAll(async () => database.drop());
beforeEach(async () => {
  await database.db.deleteFrom("earnings_entries").execute();
  await database.db.deleteFrom("payouts").execute();
  await database.db.deleteFrom("admin_audit").where("action", "=", "payout.run_approve").execute();
  await database.db.deleteFrom("config_live").where("doc", "=", "country_rules").execute();
});

const finance = { actor: "admin" as const, subjectId: "adm_v38", sessionId: "s", zones: ["*"] };
const at = new Date("2026-11-02T09:00:00Z");
const manual = (country: string) =>
  database.db.insertInto("config_live").values({ doc: "country_rules", zone_id: `standard-${country}`, version: 1, document: JSON.stringify({ country, payoutMode: "manual" }), published_at: new Date(), published_by: null }).execute();
const driverIn = async (zoneIds: string[], country: string) => {
  const id = await insertDriver(database.db);
  await database.db.updateTable("drivers").set({ zone_ids: zoneIds, country }).where("driver_id", "=", id).execute();
  return id;
};
const entry = (driverId: string, when: string, currency: string, amount: number) =>
  database.db.insertInto("earnings_entries").values({ entry_id: `ern_v38_${++n}`, driver_id: driverId, trip_id: null, kind: "adjustment", currency, amount_minor: amount, gross_minor: null, commission_minor: null, cash_minor: null, at: new Date(when) }).execute();
const run = (now: string) => database.db.transaction().execute((trx) => closePeriods(trx, new Date(now)));
const approve = (body: Parameters<typeof approvePayoutRun>[2]) => database.db.transaction().execute((trx) => approvePayoutRun(trx, finance, body, at));
const statuses = async () => (await database.db.selectFrom("payouts").select("status").orderBy("payout_id").execute()).map((r) => r.status);
const approvals = async () => (await database.db.selectFrom("admin_audit").select("action").where("action", "=", "payout.run_approve").execute()).length;
const periodEndOf = async () => (await database.db.selectFrom("payouts").select("period_end").executeTakeFirstOrThrow()).period_end.toISOString();

describe("BQ-V38: approving a payout run carries the total the admin saw", () => {
  it("SEK: a second payout joins the run after the admin looked → 409 run_changed with the fresh card, nothing approved; approving the fresh card pays both", async () => {
    await manual("SE");
    const a = await driverIn(["Z001"], "SE");
    await entry(a, "2026-10-27T10:00:00Z", "SEK", 10_000);
    expect(await run("2026-11-02T08:00:00Z")).toBe(1);
    const periodEnd = await periodEndOf();
    // The admin looks now: 1 payout, 100,00 kr. Then another driver's payout of the same run is made (his own step).
    const b = await driverIn(["Z001"], "SE");
    await entry(b, "2026-10-28T10:00:00Z", "SEK", 5_000);
    expect(await run("2026-11-02T08:30:00Z")).toBe(1);
    const stale = { country: "SE", periodEnd, reason: "Checked the bank file", expectedCount: 1, expectedTotal: [{ amountMinor: 10_000, currency: "SEK" }] };
    await expect(approve(stale)).rejects.toMatchObject({
      status: 409,
      code: "conflict",
      options: { reason: "run_changed", projection: { country: "SE", periodEnd, count: 2, total: [{ amountMinor: 15_000, currency: "SEK" }] } },
    });
    expect(await statuses()).toEqual(["pending_approval", "pending_approval"]);
    expect(await approvals()).toBe(0);
    // Approve again with the fresh card: both are approved, the answer is the total the admin saw.
    const done = await approve({ ...stale, expectedCount: 2, expectedTotal: [{ amountMinor: 15_000, currency: "SEK" }] });
    expect(done).toEqual({ country: "SE", periodEnd, approved: 2, total: [{ amountMinor: 15_000, currency: "SEK" }] });
    expect(await statuses()).toEqual(["pending", "pending"]);
    expect(await approvals()).toBe(1);
  });

  it("TND: the same count but another total (12.300 DT seen, 12.350 DT now) → 409 run_changed; the matching total is approved", async () => {
    await manual("TN");
    const d = await driverIn([], "TN");
    await entry(d, "2026-10-27T10:00:00Z", "TND", 12_350);
    expect(await run("2026-11-02T08:00:00Z")).toBe(1);
    const periodEnd = await periodEndOf();
    const body = { country: "TN", periodEnd, reason: "Checked", expectedCount: 1, expectedTotal: [{ amountMinor: 12_300, currency: "TND" }] };
    await expect(approve(body)).rejects.toMatchObject({ status: 409, options: { reason: "run_changed", projection: { count: 1, total: [{ amountMinor: 12_350, currency: "TND" }] } } });
    // A currency the run does not hold, or one missing, is a change too.
    await expect(approve({ ...body, expectedTotal: [{ amountMinor: 12_350, currency: "TND" }, { amountMinor: 0, currency: "EUR" }] })).rejects.toMatchObject({ options: { reason: "run_changed" } });
    await expect(approve({ ...body, expectedTotal: [] })).rejects.toMatchObject({ options: { reason: "run_changed" } });
    expect(await statuses()).toEqual(["pending_approval"]);
    const done = await approve({ ...body, expectedTotal: [{ amountMinor: 12_350, currency: "TND" }] });
    expect(done.total).toEqual([{ amountMinor: 12_350, currency: "TND" }]);
    expect(await statuses()).toEqual(["pending"]);
  });

  it("an approve that carries no expected total (an older admin) is refused: 400 expected_total_required, nothing approved (SE)", async () => {
    await manual("SE");
    const a = await driverIn(["Z001"], "SE");
    await entry(a, "2026-10-27T10:00:00Z", "SEK", 10_000);
    expect(await run("2026-11-02T08:00:00Z")).toBe(1);
    const periodEnd = await periodEndOf();
    await expect(approve({ country: "SE", periodEnd, reason: "Checked" } as Parameters<typeof approvePayoutRun>[2])).rejects.toMatchObject({ status: 400, options: { reason: "expected_total_required" } });
    expect(await statuses()).toEqual(["pending_approval"]);
  });
});
