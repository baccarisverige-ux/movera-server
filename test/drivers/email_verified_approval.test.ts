import type { FastifyInstance } from "fastify";
import { Kysely, PostgresDialect } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedTestPhones } from "../../src/auth/testPhones.js";
import type { Database } from "../../src/db/schema/database.js";
import { listReminders } from "../../src/drivers/reminders.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { approveDriverDocuments } from "../support/seed.js";
import { call, signIn, testWorld } from "../support/world.js";

/**
 * G30 (contract v0.18.76, contract.json#emailVerified.approvalSetting / neverActive and
 * driverOnboarding.reminders.kinds.email_not_verified; owner Q3, Q6 and the ~14:10 answers S2, S3; supervisor round 3):
 * the per-country admin setting "driver needs a verified e-mail before approval" (off by default) and the Home line.
 */

let database: TestDatabase;
let app: FastifyInstance;
let sup: Awaited<ReturnType<typeof adminSession>>;
const clock = { now: new Date("2026-11-12T15:00:00Z") };
const PHONES = Array.from({ length: 30 }, (_, i) => `+467017408${String(i).padStart(2, "0")}`);
let nextPhone = 0;

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  await seedTestPhones(database.db, PHONES);
  sup = await adminSession(app, database.db, "super", { now: clock.now });
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

/** A Swedish driver signed in by phone, on_hold with every driver document approved and an unverified e-mail. */
async function driver(over: Record<string, unknown> = {}) {
  const session = await signIn(app, PHONES[nextPhone++]!, "driver");
  const id = (await call(app, "GET", "/driver/profile", session.headers)).json().driverId as string;
  await database.db.updateTable("drivers").set({ country: "SE", city_id: "stockholm_lan", zone_ids: ["Z001"], account_status: "on_hold", account_type: "driver", email: "Drv@Example.se", ...over } as never).where("driver_id", "=", id).execute();
  await approveDriverDocuments(database.db, id);
  return { id, headers: session.headers };
}
async function setStatus(driverId: string, accountStatus: string) {
  const v = (await call(app, "GET", `/admin/drivers/${driverId}`, sup.headers)).json().version;
  return call(app, "POST", `/admin/drivers/${driverId}/status`, sup.headers, { expectedVersion: v, accountStatus, note: "ok" });
}
async function approvalSetting(on: boolean | string) {
  const draft = (await call(app, "GET", "/admin/config/onboarding?country=SE", sup.headers)).json();
  const put = await call(app, "PUT", "/admin/config/onboarding", sup.headers, { expectedVersion: draft.version, country: "SE", document: { ...draft.document, emailVerifiedForApproval: on } });
  if (put.statusCode !== 200) return put;
  return call(app, "POST", "/admin/config/onboarding/publish", sup.headers, { expectedVersion: put.json().version, country: "SE" });
}
const reminders = (headers: Record<string, string>, version?: string) => call(app, "GET", "/driver/reminders", { ...headers, ...(version ? { "x-contract-version": version } : {}) });
const firstActivated = async (id: string) => (await database.db.selectFrom("drivers").select("first_activated_at" as never).where("driver_id", "=", id).executeTakeFirstOrThrow()) as { first_activated_at: Date | null };

describe("G30: OnboardingSettings.emailVerifiedForApproval (off by default)", () => {
  it("G30: the setting is part of the onboarding document: false by default, a boolean only", async () => {
    const draft = (await call(app, "GET", "/admin/config/onboarding?country=SE", sup.headers)).json();
    expect(draft.document.emailVerifiedForApproval).toBe(false);
    const bad = await approvalSetting("yes");
    expect(bad.statusCode).toBe(400);
  });

  it("G30: off: approval ignores the e-mail; the first activation records first_activated_at", async () => {
    const d = await driver();
    const res = await setStatus(d.id, "active");
    expect(res.statusCode, res.body).toBe(200);
    expect((await firstActivated(d.id)).first_activated_at?.toISOString()).toBe(clock.now.toISOString());
  });

  it("G30: on: a never-active driver without a verified e-mail is 409 invalid_transition email_not_verified; verified → active", async () => {
    expect((await approvalSetting(true)).statusCode).toBe(200);
    const d = await driver();
    const res = await setStatus(d.id, "active");
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toMatchObject({ code: "invalid_transition", reason: "email_not_verified" });
    // pending → suspended → active is still "never active" (owner S3).
    expect((await setStatus(d.id, "suspended")).statusCode).toBe(200);
    expect((await setStatus(d.id, "active")).json()).toMatchObject({ reason: "email_not_verified" });
    expect((await firstActivated(d.id)).first_activated_at).toBeNull();
    await database.db.updateTable("drivers").set({ email_verified_at: clock.now } as never).where("driver_id", "=", d.id).execute();
    expect((await setStatus(d.id, "active")).statusCode).toBe(200);
  });

  it("G30: on: the documents check comes first; a once-active driver is re-activated without the e-mail check", async () => {
    const fresh = await driver();
    await database.db.deleteFrom("documents").where("owner_id", "=", fresh.id).execute();
    expect((await setStatus(fresh.id, "active")).json()).toMatchObject({ code: "documents_not_approved" });
    const once = await driver();
    await database.db.updateTable("drivers").set({ first_activated_at: new Date("2026-01-01T00:00:00Z"), account_status: "suspended" } as never).where("driver_id", "=", once.id).execute();
    expect((await setStatus(once.id, "active")).statusCode).toBe(200);
    expect((await firstActivated(once.id)).first_activated_at?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    await approvalSetting(false);
  });
});

describe("G30: Home reminder email_not_verified", () => {
  it("G30: orange (due_soon, fix verify_email) for an app on 0.18.76+; nothing for older apps", async () => {
    const d = await driver({ account_status: "active", first_activated_at: new Date("2026-01-01T00:00:00Z") });
    const line = (await reminders(d.headers, "0.18.76")).json().items.find((i: { kind: string }) => i.kind === "email_not_verified");
    expect(line).toEqual({ kind: "email_not_verified", level: "due_soon", fix: { target: "verify_email" } });
    expect((await reminders(d.headers, "0.18.75")).json().items.some((i: { kind: string }) => i.kind === "email_not_verified")).toBe(false);
    expect((await reminders(d.headers)).json().items.some((i: { kind: string }) => i.kind === "email_not_verified")).toBe(false);
  });

  it("G30: no line when the e-mail is verified or there is none", async () => {
    const verified = await driver({ email_verified_at: clock.now });
    expect((await reminders(verified.headers, "0.18.76")).json().items.some((i: { kind: string }) => i.kind === "email_not_verified")).toBe(false);
    const none = await driver({ email: null });
    expect((await reminders(none.headers, "0.18.76")).json().items.some((i: { kind: string }) => i.kind === "email_not_verified")).toBe(false);
  });

  it("G30: red (blocks_online) with the setting on for a never-active driver; account_not_active is left out only next to the red line", async () => {
    await approvalSetting(true);
    const d = await driver();
    const items = (await reminders(d.headers, "0.18.76")).json().items as Array<{ kind: string; level: string }>;
    expect(items.find((i) => i.kind === "email_not_verified")).toEqual({ kind: "email_not_verified", level: "blocks_online", fix: { target: "verify_email" } });
    expect(items.some((i) => i.kind === "account_not_active")).toBe(false);
    // An older app gets no e-mail line, so it keeps account_not_active.
    const old = (await reminders(d.headers, "0.18.75")).json().items as Array<{ kind: string }>;
    expect(old.some((i) => i.kind === "email_not_verified")).toBe(false);
    expect(old.some((i) => i.kind === "account_not_active")).toBe(true);
    // A once-active (now on hold) driver gets the orange line and keeps account_not_active.
    const once = await driver({ first_activated_at: new Date("2026-01-01T00:00:00Z") });
    const onceItems = (await reminders(once.headers, "0.18.76")).json().items as Array<{ kind: string; level: string }>;
    expect(onceItems.find((i) => i.kind === "email_not_verified")?.level).toBe("due_soon");
    expect(onceItems.some((i) => i.kind === "account_not_active")).toBe(true);
    await approvalSetting(false);
    // Setting off: orange for the never-active one too, and account_not_active is back.
    const off = (await reminders(d.headers, "0.18.76")).json().items as Array<{ kind: string; level: string }>;
    expect(off.find((i) => i.kind === "email_not_verified")?.level).toBe("due_soon");
    expect(off.some((i) => i.kind === "account_not_active")).toBe(true);
  });

  it("G30 fix nit a: the e-mail line reuses the country settings already read (one onboarding read)", async () => {
    const d = await driver();
    let reads = 0;
    const counting = new Kysely<Database>({ dialect: new PostgresDialect({ pool: database.pool }), log: (e) => { if (e.level === "query" && e.query.sql.includes("config_live")) reads++; } });
    const row = await database.db.selectFrom("drivers").selectAll().where("driver_id", "=", d.id).executeTakeFirstOrThrow();
    const out = await listReminders(counting, row as never, clock.now, { contractVersion: "0.18.76" });
    expect(out.items.some((i) => i.kind === "email_not_verified")).toBe(true);
    expect(reads).toBe(1);
  });
});
