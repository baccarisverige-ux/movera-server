import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { alertBook, SOLVED_ALERTS_CAP } from "../../src/admin/alerts.js";
import { permissionsOf } from "../../src/admin/permissions.js";
import type { Principal } from "../../src/auth/guard.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";

/**
 * S7 alert cap (Rules plan/S7-RECHECK-2026-11-15.md row 1, plan/GM-REPORT.md "GM 15:59" finding 1).
 * The alert book read the server's alerts oldest first with a hard cap of 1000. Solved (green) alerts stay until an
 * admin marks them done and auto_offline makes one per offline event, so past 1000 of them every NEW alert (an SOS, a
 * ride check) was cut from the list the admin alert bar and its sound read.
 * Now: an open alert is never cut; safety kinds and Critical come first; only solved ones are capped, newest first.
 * Fails before: the SOS / ride-check / open alerts are missing from `alerts` (they were row 1001+).
 */

let database: TestDatabase;
const NOW = new Date("2026-11-15T16:00:00Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
const superAdmin: Principal = { actor: "admin", subjectId: "adm_cap_super", sessionId: "s1", zones: ["*"], role: "super", perms: permissionsOf("super") };

beforeAll(async () => {
  database = await freshDatabase();
});
afterAll(async () => {
  await database.drop();
});
beforeEach(async () => {
  await database.db.deleteFrom("admin_alerts_live").execute();
});

const db = () => database.db;

/** `count` solved auto_offline alerts, one per offline event; number 1 is the newest (solved i minutes ago). */
async function solvedOffline(count: number, country = "SE", zone = "Z001") {
  await sql`
    INSERT INTO admin_alerts_live (alert_id, cause_key, kind, country, zone_id, level, title, title_t, since, state, cause_live, solved_at, solved_t, seen_at, updated_at)
    SELECT 'auto_offline:' || ${country} || ':' || i, 'auto_offline:' || ${country} || ':' || i, 'auto_offline', ${country}, ${zone}, 'info', 'Driver went offline',
           '{"t":"Driver went offline","a":[]}'::jsonb, ${NOW}::timestamptz - (i + 5) * interval '1 minute', 'solved', false,
           ${NOW}::timestamptz - i * interval '1 minute', '{"t":"Back online","a":[]}'::jsonb, ${NOW}, ${NOW}
      FROM generate_series(1, ${count}::int) AS i`.execute(db());
}

type Row = { id: string; kind: string; level?: "critical" | "important" | "info"; state?: "open" | "solved"; since: Date; solvedAt?: Date; country?: string; zone?: string | null };
async function alert(r: Row) {
  const state = r.state ?? "open";
  await db()
    .insertInto("admin_alerts_live")
    .values({
      alert_id: r.id,
      cause_key: r.id,
      kind: r.kind,
      country: r.country ?? "SE",
      zone_id: r.zone === undefined ? "Z001" : r.zone,
      level: r.level ?? "critical",
      title: r.id,
      title_t: JSON.stringify({ t: r.id, a: [] }),
      since: r.since,
      state,
      cause_live: state === "open",
      solved_at: state === "solved" ? r.solvedAt ?? r.since : null,
      solved_t: state === "solved" ? JSON.stringify({ t: "Solved", a: [] }) : null,
      seen_at: NOW,
      updated_at: NOW,
    } as never)
    .execute();
}

type Live = { alertId: string; kind: string; level: string; state: string; since: string; solvedAt?: string };
const read = async (who: Principal = superAdmin, country = "SE") => (await alertBook(db(), who, country, NOW)).alerts as Live[];
const ids = (list: Live[]) => list.map((a) => a.alertId);

describe("S7: the alert book never cuts an open alert", () => {
  it("1001 solved auto_offline alerts and a NEW SOS: the SOS is in the list, and first", async () => {
    await solvedOffline(1001);
    await alert({ id: "sos:inc_new", kind: "sos", since: ago(0) });

    const list = await read();
    expect(ids(list)).toContain("sos:inc_new");
    expect(list[0]).toMatchObject({ alertId: "sos:inc_new", kind: "sos", level: "critical", state: "open" });
  });

  it("a new ride-check alert and a new sos_slow are kept behind 1001 older alerts", async () => {
    await solvedOffline(1001);
    await alert({ id: "ride_check:inc_rc", kind: "ride_check", since: ago(1) });
    await alert({ id: "sos_slow:inc_slow", kind: "sos_slow", level: "important", since: ago(2) });

    const list = ids(await read());
    expect(list).toContain("ride_check:inc_rc");
    expect(list).toContain("sos_slow:inc_slow");
  });

  it("more than 1000 OPEN alerts: every open one is returned, none is cut", async () => {
    await sql`
      INSERT INTO admin_alerts_live (alert_id, cause_key, kind, country, zone_id, level, title, title_t, since, state, cause_live, seen_at, updated_at)
      SELECT 'long_wait:t' || i, 'long_wait:t' || i, 'long_wait', 'SE', 'Z001', 'important', 'Waited', '{"t":"Waited","a":[]}'::jsonb,
             ${NOW}::timestamptz - (i + 10) * interval '1 minute', 'open', true, ${NOW}, ${NOW}
        FROM generate_series(1, 1200) AS i`.execute(db());
    await solvedOffline(1001);
    await alert({ id: "sos:inc_new", kind: "sos", since: ago(0) });

    const list = await read();
    const open = list.filter((a) => a.state === "open");
    expect(open).toHaveLength(1201);
    expect(open[0]!.alertId).toBe("sos:inc_new");
    expect(list.filter((a) => a.state === "solved")).toHaveLength(SOLVED_ALERTS_CAP);
  });
});

describe("S7: the order of the alert list", () => {
  it("open before solved; safety kinds first, then Critical, Important, Info; the newest first inside each", async () => {
    await alert({ id: "long_wait:info_old", kind: "long_wait", level: "info", since: ago(90) });
    await alert({ id: "long_wait:important", kind: "long_wait", level: "important", since: ago(50) });
    await alert({ id: "payment_failed:critical_old", kind: "payment_failed", level: "critical", since: ago(40) });
    await alert({ id: "payment_failed:critical_new", kind: "payment_failed", level: "critical", since: ago(5) });
    await alert({ id: "sos_slow:important", kind: "sos_slow", level: "important", since: ago(60) });
    await alert({ id: "sos:old", kind: "sos", level: "critical", since: ago(70) });
    await alert({ id: "ride_check:new", kind: "ride_check", level: "critical", since: ago(3) });
    await alert({ id: "ride_check:solved", kind: "ride_check", level: "critical", state: "solved", since: ago(300), solvedAt: ago(200) });
    await alert({ id: "long_wait:solved_new", kind: "long_wait", level: "important", state: "solved", since: ago(30), solvedAt: ago(1) });
    await alert({ id: "long_wait:solved_old", kind: "long_wait", level: "important", state: "solved", since: ago(31), solvedAt: ago(20) });

    expect(ids(await read())).toEqual([
      // open: safety (red first, then the newest), then the others by level, the newest first
      "ride_check:new",
      "sos:old",
      "sos_slow:important",
      "payment_failed:critical_new",
      "payment_failed:critical_old",
      "long_wait:important",
      "long_wait:info_old",
      // solved (green): safety first, then the newest solved first
      "ride_check:solved",
      "long_wait:solved_new",
      "long_wait:solved_old",
    ]);
  });
});

describe("S7: only solved alerts are capped, the newest kept", () => {
  it("1100 solved: the newest 1000 stay, the oldest 100 are left out; a solved safety alert is kept even when old", async () => {
    await solvedOffline(1100);
    await alert({ id: "ride_check:solved_old", kind: "ride_check", state: "solved", since: ago(5000), solvedAt: ago(4000) });

    const list = await read();
    expect(list).toHaveLength(SOLVED_ALERTS_CAP);
    expect(list[0]!.alertId).toBe("ride_check:solved_old");
    const offline = ids(list).filter((id) => id.startsWith("auto_offline:"));
    expect(offline).toHaveLength(SOLVED_ALERTS_CAP - 1);
    // Newest first: number 1 was solved last.
    expect(offline[0]).toBe("auto_offline:SE:1");
    expect(offline).toContain("auto_offline:SE:999");
    expect(offline).not.toContain("auto_offline:SE:1000");
    expect(offline).not.toContain("auto_offline:SE:1100");
  });

  it("under the cap nothing changes: every open and solved alert is returned with the same fields", async () => {
    await solvedOffline(3);
    await alert({ id: "sos:inc_1", kind: "sos", since: ago(4) });

    const list = await read();
    expect(list).toHaveLength(4);
    expect(list[0]).toEqual({ alertId: "sos:inc_1", causeKey: "sos:inc_1", kind: "sos", level: "critical", title: "sos:inc_1", titleT: { t: "sos:inc_1", a: [] }, detail: "", zoneId: "Z001", country: "SE", since: ago(4).toISOString(), state: "open", ref: {} });
    expect(list[1]).toMatchObject({ alertId: "auto_offline:SE:1", state: "solved", solvedAt: ago(1).toISOString(), solvedText: "Back online", solvedT: { t: "Back online", a: [] } });
  });
});

describe("S7: zones, groups and countries still filter before the cap", () => {
  it("another country's and another zone's solved alerts do not push out this admin's; no group, no alert", async () => {
    await solvedOffline(1001, "FR", "FR-PC");
    await solvedOffline(1001, "SE", "Z002");
    await alert({ id: "sos:z1", kind: "sos", since: ago(0), zone: "Z001" });
    await alert({ id: "auto_offline:z1", kind: "auto_offline", level: "info", state: "solved", since: ago(9000), solvedAt: ago(8000), zone: "Z001" });
    await alert({ id: "sos:nozone", kind: "sos", since: ago(0), zone: null });

    const safetyZ1: Principal = { actor: "admin", subjectId: "adm_cap_z1", sessionId: "s2", zones: ["Z001"], role: "ops", perms: permissionsOf("ops") };
    expect(ids(await read(safetyZ1))).toEqual(["sos:z1", "auto_offline:z1"]);
    // An alert without a zone: Super admins only.
    expect(ids(await read()).slice(0, 2).sort()).toEqual(["sos:nozone", "sos:z1"]);
    // Finance does not read the safety or drivers group.
    const finance: Principal = { actor: "admin", subjectId: "adm_cap_fin", sessionId: "s3", zones: ["Z001"], role: "finance", perms: permissionsOf("finance") };
    expect(await read(finance)).toEqual([]);
  });
});
