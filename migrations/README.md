# Migrations

`src/db/migrate.ts` applies `NNNN_name.sql` in name order under an advisory lock, each file in one transaction,
append-only (a file that changed after it was applied stops the server). Change the schema with a NEW file.

## Rule 46 (owner, 2026-11-10): nothing locks a table while the app runs, and every file has an undo

1. **Indexes** on an existing table: `CREATE INDEX CONCURRENTLY IF NOT EXISTS ...`.
2. **CHECK / FOREIGN KEY** on an existing table: `ADD CONSTRAINT ... NOT VALID;` then
   `ALTER TABLE ... VALIDATE CONSTRAINT ...;` (the validate step takes only a light lock).
3. `CONCURRENTLY` cannot run inside a transaction, so such a file starts with this exact first line:

   ```sql
   -- movera: no-transaction
   ```

   The runner then sends the file statement by statement with no BEGIN/COMMIT and writes the
   `schema_migrations` row only after the last statement. Such a file is **not atomic**: on failure what ran
   stays, nothing is recorded, and the next start runs the whole file again, so use `IF NOT EXISTS` /
   `IF EXISTS` everywhere. If an INVALID index exists afterwards (a `CONCURRENTLY` build that failed), the
   runner stops and names it; drop it with `DROP INDEX CONCURRENTLY` and start again.
4. **Undo**: every new file ends with a comment block holding the SQL that reverts it, or has a twin file in
   `migrations/undo/NNNN_name.sql`:

   ```sql
   -- undo:
   -- DROP INDEX CONCURRENTLY IF EXISTS trips_rider_created_idx;
   ```

   Files 0001–0089 predate the rule and are not checked.

## Checker

`tools/check_migrations.py` (python3, stdlib only) enforces the four points on NEW files. CI runs it on every
pull request against the files added relative to the base branch; a push to `main` skips it.

```sh
python3 tools/check_migrations.py --self-test                    # the built-in cases
python3 tools/check_migrations.py --base origin/main             # what CI checks on this branch
python3 tools/check_migrations.py migrations/0090_something.sql  # one file
```

Messages are `file:line: R1..R4 ...`; exit 1 on any finding.
