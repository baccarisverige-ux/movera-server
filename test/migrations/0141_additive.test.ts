import { readFileSync } from "node:fs";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase, type TestDatabase } from "../support/db.js";

/** v0.18.172 (migration 0141, Rule 21): additive only; drivers.home_area stays, preferred_area_ids defaults to '{}'. */
let database: TestDatabase;
beforeAll(async () => {
  database = await freshDatabase();
});
afterAll(async () => {
  await database.drop();
});

describe("migration 0141", () => {
  it("keeps drivers.home_area and adds preferred_area_ids text[] NOT NULL DEFAULT '{}'", async () => {
    const cols = await sql<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>`
      SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_name = 'drivers' AND column_name IN ('home_area', 'preferred_area_ids') ORDER BY column_name`.execute(database.db);
    expect(cols.rows.map((c) => c.column_name)).toEqual(["home_area", "preferred_area_ids"]);
    const pa = cols.rows[1]!;
    expect([pa.data_type, pa.is_nullable, pa.column_default]).toEqual(["ARRAY", "NO", "'{}'::text[]"]);
  });
  it("drops nothing and rewrites no data (only CREATE ... IF NOT EXISTS and ADD COLUMN IF NOT EXISTS)", () => {
    const text = readFileSync(new URL("../../migrations/0141_driver_preferred_areas.sql", import.meta.url), "utf8");
    const statements = text.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(statements).not.toMatch(/\b(DROP|DELETE|UPDATE|TRUNCATE)\b/i);
    expect(statements).not.toMatch(/home_area/);
  });
});
