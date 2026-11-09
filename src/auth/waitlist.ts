import { sql } from "kysely";
import type { Db, Executor } from "../db/db.js";
import { ApiError, badRequest } from "../http/errors.js";
import { cursorOf, readCursor } from "../admin/lists.js";
import { adminMasksRiders, maskPhone } from "../admin/masking.js";
import type { Principal } from "./guard.js";
import { PHONE, type App } from "./service.js";

/**
 * Sign-in group 1 (contract v0.15.0 §24, owner 2026-10-29).
 *
 * Decision 5: a number answered 403 sign_in_restricted can join the waiting list (POST /auth/waitlist); the admin
 * reads it (GET /admin/waitlist). Decision 6: GET /auth/test-accounts lists the test numbers with each account's
 * status, only outside production (the route is not registered on production, so it answers 404).
 */

/** contract.json#auth.waitlist.perIpPerHour */
export const WAITLIST_PER_IP_PER_HOUR = 30;

export type WaitlistReceipt = { status: "saved"; requestId: string };

export async function joinWaitlist(
  db: Db,
  input: { phone: string; app: App; locale?: "sv" | "fr" | "en" | undefined; requestId: string },
  client: { ip?: string | undefined },
  now: Date,
): Promise<WaitlistReceipt> {
  if (!PHONE.test(input.phone)) throw badRequest("Send the phone number in international form, e.g. +46701234567.", "invalid_phone");
  await db.transaction().execute(async (trx) => {
    if (client.ip !== undefined) {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`waitlist:${client.ip}`}))`.execute(trx);
      const hourAgo = new Date(now.getTime() - 3_600_000);
      const asks = await trx
        .selectFrom("sign_in_waitlist_asks")
        .select(["at"])
        .where("ip", "=", client.ip)
        .where("at", ">", hourAgo)
        .orderBy("at", "asc")
        .execute();
      if (asks.length >= WAITLIST_PER_IP_PER_HOUR) {
        const wait = Math.max(1, Math.ceil((asks[0]!.at.getTime() + 3_600_000 - now.getTime()) / 1000));
        throw new ApiError("rate_limited", "Too many requests from this address. Try again later.", { reason: "waitlist_too_many", retryAfterSeconds: wait });
      }
      await trx.insertInto("sign_in_waitlist_asks").values({ ip: client.ip, at: now }).execute();
      await trx.deleteFrom("sign_in_waitlist_asks").where("at", "<", hourAgo).execute();
    }
    await trx
      .insertInto("sign_in_waitlist")
      .values({ phone: input.phone, app: input.app, locale: input.locale ?? null, ip: client.ip ?? null, first_at: now, last_at: now })
      .onConflict((c) =>
        c.columns(["phone", "app"]).doUpdateSet((eb) => ({
          count: sql<number>`${eb.ref("sign_in_waitlist.count")} + 1`,
          last_at: now,
          ip: client.ip ?? null,
          ...(input.locale !== undefined ? { locale: input.locale } : {}),
        })),
      )
      .execute();
  });
  return { status: "saved", requestId: input.requestId };
}

export type WaitlistEntry = { phone: string; app: App; locale?: string; firstAt: string; lastAt: string; count: number };

/** GET /admin/waitlist: newest lastAt first, cursor pages. */
export async function listWaitlist(ex: Executor, input: { cursor?: string | undefined; limit: number; app?: App | undefined }, who?: Pick<Principal, "perms">): Promise<{ items: WaitlistEntry[]; nextCursor: string | null }> {
  // v0.18.54 §76: the number masked for every admin without riders.viewSensitive (pre-account: no Reveal).
  const phoneOf = adminMasksRiders(who) ? maskPhone : (phone: string) => phone;
  let query = ex.selectFrom("sign_in_waitlist").selectAll();
  if (input.app !== undefined) query = query.where("app", "=", input.app);
  if (input.cursor !== undefined) {
    const c = readCursor(input.cursor);
    query = query.where((eb) => eb.or([eb("last_at", "<", c.at), eb.and([eb("last_at", "=", c.at), eb(sql<string>`phone || ':' || app`, ">", c.id)])]));
  }
  const rows = await query
    .orderBy("last_at", "desc")
    .orderBy(sql`phone || ':' || app`)
    .limit(input.limit + 1)
    .execute();
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => ({
      phone: phoneOf(r.phone),
      app: r.app,
      ...(r.locale !== null ? { locale: r.locale } : {}),
      firstAt: r.first_at.toISOString(),
      lastAt: r.last_at.toISOString(),
      count: r.count,
    })),
    nextCursor: rows.length > input.limit && last ? cursorOf(last.last_at, `${last.phone}:${last.app}`) : null,
  };
}

export type TestAccount = { phone: string; app: App; status: "test" | "pending" | "active" | "on_hold" | "suspended"; name?: string };

/** GET /auth/test-accounts (never on production): each test number per app, with its account's status. */
export async function listTestAccounts(ex: Executor): Promise<{ accounts: TestAccount[] }> {
  const phones = await ex.selectFrom("test_phones").select(["phone", "app"]).orderBy("phone").orderBy("app", "desc").execute();
  if (phones.length === 0) return { accounts: [] };
  const numbers = [...new Set(phones.map((p) => p.phone))];
  const riders = await ex.selectFrom("riders").select(["phone", "status", "first_name"]).where("phone", "in", numbers).execute();
  const drivers = await ex.selectFrom("drivers").select(["phone", "account_status", "first_name"]).where("phone", "in", numbers).execute();
  const rider = new Map(riders.map((r) => [r.phone, r]));
  const driver = new Map(drivers.map((d) => [d.phone, d]));
  return {
    accounts: phones.map(({ phone, app }) => {
      const account = app === "rider" ? rider.get(phone) : driver.get(phone);
      if (account === undefined) return { phone, app, status: "test" as const };
      const status = "account_status" in account ? account.account_status : account.status;
      const name = account.first_name.trim();
      return { phone, app, status, ...(name ? { name } : {}) };
    }),
  };
}
