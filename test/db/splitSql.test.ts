import { describe, expect, it } from "vitest";
import { splitSql } from "../../src/db/splitSql.js";

describe("splitSql", () => {
  it("splits on ; and drops comment-only pieces (a leading comment stays with its statement)", () => {
    expect(splitSql("-- movera: no-transaction\nCREATE INDEX CONCURRENTLY a ON t (x);\n-- undo:\n-- DROP INDEX a;\n")).toEqual([
      "-- movera: no-transaction\nCREATE INDEX CONCURRENTLY a ON t (x)",
    ]);
  });

  it("keeps ; inside strings, identifiers, dollar-quotes and comments", () => {
    const sql = [
      "INSERT INTO t VALUES ('a;b', 'it''s');",
      'ALTER TABLE "we;ird" ADD COLUMN c int; /* not; here */',
      "CREATE FUNCTION f() RETURNS void AS $fn$ BEGIN PERFORM 1; END $fn$ LANGUAGE plpgsql;",
      "DO $$ BEGIN RAISE NOTICE 'x;'; END $$; -- trailing; comment",
      "SELECT 1",
    ].join("\n");
    expect(splitSql(sql)).toEqual([
      "INSERT INTO t VALUES ('a;b', 'it''s')",
      'ALTER TABLE "we;ird" ADD COLUMN c int',
      "/* not; here */\nCREATE FUNCTION f() RETURNS void AS $fn$ BEGIN PERFORM 1; END $fn$ LANGUAGE plpgsql",
      "DO $$ BEGIN RAISE NOTICE 'x;'; END $$",
      "-- trailing; comment\nSELECT 1",
    ]);
  });

  it("an empty or comment-only file has no statements", () => {
    expect(splitSql("")).toEqual([]);
    expect(splitSql("-- nothing\n\n-- here\n")).toEqual([]);
  });
});
