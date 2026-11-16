import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { splitSql } from "../../src/db/splitSql.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";

/**
 * v0.18.110 BQ-V44 migration 0110 (contract.json#bonusCampaigns.server; supervisor MF9, Rule 46): no transaction, the FK
 * added NOT VALID then validated, the unique index built CONCURRENTLY and VALID (pg_index.indisvalid: a failed
 * concurrent build would leave an INVALID index that IF NOT EXISTS skips), tools/check_migrations.py clean, and the
 * written undo really undoes it (then the file runs again cleanly).
 */

const FILE = fileURLToPath(new URL("../../migrations/0110_bonus_campaigns.sql", import.meta.url));
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
let database: TestDatabase;
beforeAll(async () => {
  database = await freshDatabase();
});
afterAll(async () => {
  await database?.drop();
});

const one = async <T>(q: string, args: unknown[] = []) => (await database.pool.query(q, args)).rows[0] as T;

describe("migration 0110_bonus_campaigns", () => {
  it("is a no-transaction file that sets lock_timeout 3 s and passes tools/check_migrations.py (R1-R4)", () => {
    const text = readFileSync(FILE, "utf8");
    expect(text.split("\n")[0]).toBe("-- movera: no-transaction");
    expect(text).toMatch(/SET lock_timeout = '3s';/);
    const run = spawnSync("python3", ["tools/check_migrations.py", "migrations/0110_bonus_campaigns.sql"], { cwd: ROOT, encoding: "utf8" });
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.stdout).toContain("0 finding(s)");
  });

  it("the unique index earnings_bonus_once is VALID, unique and partial on bonus_id IS NOT NULL; the FK is validated", async () => {
    const idx = await one<{ indisvalid: boolean; indisunique: boolean; def: string }>(
      "SELECT i.indisvalid, i.indisunique, pg_get_indexdef(i.indexrelid) AS def FROM pg_index i WHERE i.indexrelid = 'earnings_bonus_once'::regclass");
    expect(idx).toMatchObject({ indisvalid: true, indisunique: true });
    expect(idx.def).toMatch(/\(driver_id, bonus_id\) WHERE \(bonus_id IS NOT NULL\)/);
    const fk = await one<{ convalidated: boolean; def: string }>("SELECT convalidated, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'earnings_bonus_fk'");
    expect(fk).toEqual({ convalidated: true, def: "FOREIGN KEY (bonus_id) REFERENCES bonus_campaigns(bonus_id)" });
    const col = await one<{ is_nullable: string; column_default: string | null }>("SELECT is_nullable, column_default FROM information_schema.columns WHERE table_name = 'earnings_entries' AND column_name = 'bonus_id'");
    expect(col).toEqual({ is_nullable: "YES", column_default: null });
    for (const table of ["bonus_campaigns", "bonus_progress", "bonus_trips_counted", "bonus_rider_days"]) {
      expect(await one<{ t: string | null }>("SELECT to_regclass($1)::text AS t", [table])).toEqual({ t: table });
    }
  });

  it("the written undo removes everything; the file then runs again (re-runnable, Rule 46)", async () => {
    const text = readFileSync(FILE, "utf8");
    const undo = text.slice(text.indexOf("-- undo:") + "-- undo:".length).split("\n").map((l) => l.replace(/^--\s?/, "")).join("\n");
    for (const statement of splitSql(undo)) await database.pool.query(statement);
    expect(await one<{ t: string | null }>("SELECT to_regclass('bonus_campaigns')::text AS t")).toEqual({ t: null });
    expect(await one<{ n: string }>("SELECT count(*) AS n FROM information_schema.columns WHERE table_name = 'earnings_entries' AND column_name = 'bonus_id'")).toEqual({ n: "0" });
    await database.pool.query("DELETE FROM schema_migrations WHERE name = '0110_bonus_campaigns.sql'");
    expect(await migrate(database.pool)).toEqual(["0110_bonus_campaigns.sql"]);
    expect(await one<{ indisvalid: boolean }>("SELECT indisvalid FROM pg_index WHERE indexrelid = 'earnings_bonus_once'::regclass")).toEqual({ indisvalid: true });
  });
});
