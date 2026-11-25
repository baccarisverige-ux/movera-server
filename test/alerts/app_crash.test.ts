import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sweepAlerts } from "../../src/alerts/detector.js";
import { recordError } from "../../src/telemetry/errors.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";

/**
 * Contract v0.18.158 (contract.json#crashCatcher.alert, alertDesk kind app_crash; owner 2026-11-24 "Add to admin all
 * kind of crash"): a NEW crash group of the rider or driver app is a server alert once its count reaches the kind's
 * Important limit (default 1); Critical from 20; solved when marked fixed or 24 h after it was first seen; the admin can
 * switch it off. Rule 36: fails on main — there is no app_crash cause.
 */
let database: TestDatabase;
const NOW = new Date("2026-11-24T10:00:00Z");
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

beforeEach(async () => {
  database = await freshDatabase();
});
afterEach(async () => {
  await database.drop();
});
const db = () => database.db;
const sweep = (when: Date = NOW) => db().transaction().execute((trx) => sweepAlerts(trx, when));
const alerts = () => db().selectFrom("admin_alerts_live").selectAll().where("kind", "=", "app_crash").orderBy("country").execute();
const report = (message: string, kind: "dart_error" | "native_crash" | "freeze" | "crash" | "error", when: Date = NOW, extra: Record<string, unknown> = {}, app: "rider" | "driver" | "server" = "rider") =>
  recordError(db(), { app, platform: app === "server" ? "server" : "ios", kind, message, body: { error: message, kind, ...extra }, device: `ip:${message}:${when.getTime()}`, at: when });
const settings = (country: string, doc: unknown) =>
  db().insertInto("admin_alert_book").values({ country, settings: JSON.stringify(doc), rules: "[]" } as never).onConflict((oc) => oc.column("country").doUpdateSet({ settings: JSON.stringify(doc) } as never)).execute();

describe("app_crash alert (v0.18.158)", () => {
  it("a new native crash group alerts at once in every country that has a zone, without a zone; no duplicate on the next sweep", async () => {
    const id = await report("NSInvalidArgumentException: invalid GOOGLE_APP_ID", "native_crash");
    await sweep();
    const rows = await alerts();
    const zoneCountries = [...new Set((await db().selectFrom("zones").select("country").execute()).map((z) => z.country))].sort();
    expect(rows.map((r) => r.country)).toEqual(zoneCountries);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const r of rows) {
      expect(r).toMatchObject({ state: "open", level: "important", zone_id: null });
      expect(r.title).toBe("New crash in the rider app (native_crash): NSInvalidArgumentException: invalid GOOGLE_APP_ID");
      expect(r.cause_key).toBe(`app_crash:${id}:${r.country}`);
    }
    await sweep(at(1));
    expect((await alerts()).length).toBe(rows.length);
  });

  it("the zone of the report puts it in that zone's country only, with the zone", async () => {
    await report("Freeze on home", "freeze", NOW, { zoneId: "FR-PC" });
    await sweep();
    const rows = await alerts();
    expect(rows.map((r) => [r.country, r.zone_id])).toEqual([["FR", "FR-PC"]]);
  });

  it("Critical from the Critical limit (20); the Important limit is the admin's setting; off makes none", async () => {
    for (let n = 0; n < 20; n++) await report("Null check operator used on a null value", "dart_error", at(n / 10), {}, "driver");
    await settings("SE", { kinds: { app_crash: { limits: { important: 1, critical: 20 } } } });
    await settings("FR", { kinds: { app_crash: { on: false } } });
    await sweep(at(3));
    const rows = await alerts();
    expect(rows.find((r) => r.country === "SE")?.level).toBe("critical");
    expect(rows.find((r) => r.country === "FR")).toBeUndefined();
    await settings("SE", { kinds: { app_crash: { limits: { important: 50, critical: null } } } });
    await sweep(at(4));
    expect((await alerts()).find((r) => r.country === "SE")?.state).toBe("solved");
  });

  it("caught errors and server errors never alert", async () => {
    await report("Payment sheet closed", "error");
    await report("Error: connect ETIMEDOUT", "error", NOW, {}, "server");
    await sweep();
    expect(await alerts()).toEqual([]);
  });

  it("solved when marked fixed, and 24 h after the group was first seen", async () => {
    const fixed = await report("StateError: Bad state", "dart_error");
    await report("Old one", "native_crash");
    await sweep();
    await db().updateTable("error_groups").set({ status: "fixed", fixed_at: at(5) }).where("error_id", "=", fixed).execute();
    await sweep(at(6));
    const after = await alerts();
    expect(after.filter((r) => r.cause_key.startsWith(`app_crash:${fixed}:`)).every((r) => r.state === "solved")).toBe(true);
    expect(after.filter((r) => !r.cause_key.startsWith(`app_crash:${fixed}:`)).every((r) => r.state === "open")).toBe(true);
    await sweep(at(24 * 60 + 1));
    expect((await alerts()).every((r) => r.state === "solved")).toBe(true);
  });
});
