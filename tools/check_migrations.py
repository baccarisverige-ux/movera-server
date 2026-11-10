#!/usr/bin/env python3
"""Owner rule 46 (global-plan step 58): no migration may lock a table while the app runs, and every migration
ships with a ready undo step. Checks NEW migration files only (never 0001-0089); python3 stdlib only.

Usage:
  tools/check_migrations.py migrations/0090_x.sql ...   check these files (exit 1 on any finding)
  tools/check_migrations.py --base origin/main           check files added since that git ref
  tools/check_migrations.py --self-test                  run the built-in cases

Rules (each message is file:line: text):
  R1  CREATE INDEX needs CONCURRENTLY, unless the file creates the table itself.
  R2  ADD CONSTRAINT ... CHECK / FOREIGN KEY needs NOT VALID, unless the file creates the table itself.
  R3  CONCURRENTLY needs the marker `-- movera: no-transaction` as the first line.
  R4  An undo step: a `-- undo:` comment followed by at least one SQL line (commented or not), or a file
      migrations/undo/<same name>.sql with at least one SQL line.
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
import tempfile

MARKER = "-- movera: no-transaction"
NAME_RE = re.compile(r"^\d{4}_[a-z0-9_]+\.sql$")
CREATE_TABLE_RE = re.compile(r"\bCREATE\s+(?:UNLOGGED\s+|TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w.\"]+)", re.I)
CREATE_INDEX_RE = re.compile(r"\bCREATE\s+(?:UNIQUE\s+)?INDEX\b(?P<rest>[^;]*?)\bON\s+(?:ONLY\s+)?([\w.\"]+)", re.I | re.S)
ADD_CONSTRAINT_RE = re.compile(
    r"\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?([\w.\"]+)(?P<body>.*?)(?=;|$)", re.I | re.S
)
CHECK_OR_FK_RE = re.compile(r"\b(CHECK\s*\(|FOREIGN\s+KEY\b|REFERENCES\s+[\w.\"]+)", re.I)
NOT_VALID_RE = re.compile(r"\bNOT\s+VALID\b", re.I)
UNDO_RE = re.compile(r"^\s*--\s*undo:", re.I)
SQL_WORD_RE = re.compile(r"\b(DROP|ALTER|DELETE|UPDATE|INSERT|CREATE|TRUNCATE|SELECT|DO)\b", re.I)


def _norm(name: str) -> str:
    return name.replace('"', "").lower().split(".")[-1]


def _strip_comments(text: str) -> str:
    """Blank out comments and string literals but keep every newline, so line numbers stay right."""
    out: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        nxt = text[i + 1] if i + 1 < n else ""
        if ch == "-" and nxt == "-":
            end = text.find("\n", i)
            end = n if end == -1 else end
            out.append(" " * (end - i))
            i = end
        elif ch == "/" and nxt == "*":
            end = text.find("*/", i + 2)
            end = n if end == -1 else end + 2
            out.append(re.sub(r"[^\n]", " ", text[i:end]))
            i = end
        elif ch == "'":
            end = i + 1
            while end < n:
                if text[end] == "'":
                    if end + 1 < n and text[end + 1] == "'":
                        end += 2
                        continue
                    break
                end += 1
            end = min(end + 1, n)
            out.append("'" + re.sub(r"[^\n]", " ", text[i + 1 : end - 1]) + "'")
            i = end
        else:
            out.append(ch)
            i += 1
    return "".join(out)


def _line_of(text: str, pos: int) -> int:
    return text.count("\n", 0, pos) + 1


def check_text(name: str, text: str, undo_file_text: str | None = None) -> list[str]:
    """Returns findings as 'name:line: message'. `undo_file_text` is migrations/undo/<name> if present."""
    findings: list[str] = []
    code = _strip_comments(text)
    created = {_norm(m.group(1)) for m in CREATE_TABLE_RE.finditer(code)}
    first_line = text.split("\n", 1)[0].rstrip()
    has_marker = first_line == MARKER
    if MARKER in text and not has_marker:
        findings.append(f"{name}:1: R3 the marker `{MARKER}` only counts as the very first line")

    for m in CREATE_INDEX_RE.finditer(code):
        line = _line_of(code, m.start())
        table = _norm(m.group(2))
        if "CONCURRENTLY" not in m.group("rest").upper() and table not in created:
            findings.append(f"{name}:{line}: R1 CREATE INDEX on existing table `{table}` locks it; use CREATE INDEX CONCURRENTLY (and the no-transaction marker)")

    for m in ADD_CONSTRAINT_RE.finditer(code):
        body = m.group("body")
        if not re.search(r"\bADD\b", body, re.I):
            continue
        table = _norm(m.group(1))
        if table in created:
            continue
        if CHECK_OR_FK_RE.search(body) and not NOT_VALID_RE.search(body):
            line = _line_of(code, m.start())
            findings.append(f"{name}:{line}: R2 ADD CONSTRAINT (CHECK/FOREIGN KEY) on existing table `{table}` scans and locks it; add NOT VALID, then VALIDATE CONSTRAINT in a later statement")

    for m in re.finditer(r"\bCONCURRENTLY\b", code, re.I):
        if not has_marker:
            findings.append(f"{name}:{_line_of(code, m.start())}: R3 CONCURRENTLY cannot run inside a transaction; put `{MARKER}` on line 1")
            break

    if not _has_undo(text) and not (undo_file_text is not None and SQL_WORD_RE.search(_strip_comments(undo_file_text) + " " + undo_file_text)):
        findings.append(f"{name}:1: R4 no undo step: add a `-- undo:` comment followed by the SQL that reverts this file, or migrations/undo/{name}")
    return findings


def _has_undo(text: str) -> bool:
    lines = text.split("\n")
    for i, line in enumerate(lines):
        if UNDO_RE.match(line):
            rest = line.split(":", 1)[1]
            following = [rest] + lines[i + 1 :]
            return any(SQL_WORD_RE.search(l) for l in following if l.strip())
    return False


def check_file(path: str) -> list[str]:
    name = os.path.basename(path)
    with open(path, encoding="utf-8") as f:
        text = f.read()
    undo_path = os.path.join(os.path.dirname(path), "undo", name)
    undo_text = None
    if os.path.isfile(undo_path):
        with open(undo_path, encoding="utf-8") as f:
            undo_text = f.read()
    return check_text(path, text, undo_text)


def new_files_since(base: str) -> list[str]:
    out = subprocess.run(["git", "diff", "--name-only", "--diff-filter=A", f"{base}...HEAD", "--", "migrations"], check=True, capture_output=True, text=True).stdout
    # Only files directly in migrations/: migrations/undo/<name>.sql are undo steps, not migrations.
    return [p for p in out.split("\n") if os.path.dirname(p) == "migrations" and NAME_RE.match(os.path.basename(p)) and os.path.isfile(p)]


# ---------------------------------------------------------------------------------------------------------------
SELF_TEST_CASES: list[tuple[str, str, list[str]]] = [
    (
        "R1 index without CONCURRENTLY",
        "CREATE INDEX trips_x ON trips (x);\n-- undo: DROP INDEX trips_x;\n",
        ["R1"],
    ),
    (
        "R1 ok: table created in the same file",
        "CREATE TABLE new_t (id int);\nCREATE INDEX new_t_id ON new_t (id);\n-- undo: DROP TABLE new_t;\n",
        [],
    ),
    (
        "R2 CHECK without NOT VALID",
        "ALTER TABLE trips ADD CONSTRAINT trips_chk CHECK (x > 0);\n-- undo: ALTER TABLE trips DROP CONSTRAINT trips_chk;\n",
        ["R2"],
    ),
    (
        "R2 FOREIGN KEY without NOT VALID",
        "ALTER TABLE trips ADD CONSTRAINT trips_fk FOREIGN KEY (rider_id) REFERENCES riders (rider_id);\n-- undo: ALTER TABLE trips DROP CONSTRAINT trips_fk;\n",
        ["R2"],
    ),
    (
        "R2 ok: NOT VALID then VALIDATE",
        "ALTER TABLE trips ADD CONSTRAINT trips_chk CHECK (x > 0) NOT VALID;\nALTER TABLE trips VALIDATE CONSTRAINT trips_chk;\n-- undo: ALTER TABLE trips DROP CONSTRAINT trips_chk;\n",
        [],
    ),
    (
        "R2 ok: ADD COLUMN only (no CHECK/FK) and column DEFAULT",
        "ALTER TABLE trips ADD COLUMN flag boolean NOT NULL DEFAULT false;\n-- undo: ALTER TABLE trips DROP COLUMN flag;\n",
        [],
    ),
    (
        "R3 CONCURRENTLY without marker",
        "CREATE INDEX CONCURRENTLY trips_x ON trips (x);\n-- undo: DROP INDEX CONCURRENTLY trips_x;\n",
        ["R3"],
    ),
    (
        "R3 marker not on line 1",
        "-- hello\n-- movera: no-transaction\nCREATE INDEX CONCURRENTLY trips_x ON trips (x);\n-- undo: DROP INDEX CONCURRENTLY trips_x;\n",
        ["R3"],
    ),
    (
        "R4 no undo at all",
        "ALTER TABLE trips ADD COLUMN flag boolean;\n",
        ["R4"],
    ),
    (
        "R4 undo header without SQL",
        "ALTER TABLE trips ADD COLUMN flag boolean;\n-- undo:\n-- (nothing)\n",
        ["R4"],
    ),
    (
        "R4 ok: undo SQL on the following commented line",
        "ALTER TABLE trips ADD COLUMN flag boolean;\n-- undo:\n-- ALTER TABLE trips DROP COLUMN flag;\n",
        [],
    ),
    (
        "comments and strings are ignored",
        "-- CREATE INDEX in_a_comment ON trips (x);\nINSERT INTO t VALUES ('CREATE INDEX i ON t (x); CHECK (1)');\n/* ALTER TABLE t ADD CONSTRAINT c CHECK (1) */\n-- undo: DELETE FROM t;\n",
        [],
    ),
    (
        "passing example (all rules)",
        "-- movera: no-transaction\n-- v0.19 step 58: index for the earnings list.\nCREATE INDEX CONCURRENTLY IF NOT EXISTS trips_rider_created_idx ON trips (rider_id, created_at);\n"
        "ALTER TABLE trips ADD CONSTRAINT trips_fare_chk CHECK (fare_minor >= 0) NOT VALID;\nALTER TABLE trips VALIDATE CONSTRAINT trips_fare_chk;\n"
        "-- undo:\n-- DROP INDEX CONCURRENTLY IF EXISTS trips_rider_created_idx;\n-- ALTER TABLE trips DROP CONSTRAINT IF EXISTS trips_fare_chk;\n",
        [],
    ),
]


def self_test() -> int:
    failed = 0
    for title, text, expected in SELF_TEST_CASES:
        got = check_text("case.sql", text)
        codes = sorted({f.split(": ", 1)[1].split(" ", 1)[0] for f in got})
        ok = codes == sorted(expected)
        print(f"{'ok  ' if ok else 'FAIL'} {title}: expected {expected or 'clean'}, got {codes or 'clean'}")
        if not ok:
            failed += 1
            for f in got:
                print("     " + f)
    # The undo-file alternative, on disk.
    with tempfile.TemporaryDirectory() as d:
        os.makedirs(os.path.join(d, "undo"))
        with open(os.path.join(d, "0999_undo_file.sql"), "w") as f:
            f.write("ALTER TABLE trips ADD COLUMN flag boolean;\n")
        with open(os.path.join(d, "undo", "0999_undo_file.sql"), "w") as f:
            f.write("ALTER TABLE trips DROP COLUMN flag;\n")
        got = check_file(os.path.join(d, "0999_undo_file.sql"))
        ok = got == []
        print(f"{'ok  ' if ok else 'FAIL'} R4 ok: matching migrations/undo/<name> file: got {got or 'clean'}")
        failed += 0 if ok else 1
    print(f"self-test: {len(SELF_TEST_CASES) + 1} cases, {failed} failed")
    return 1 if failed else 0


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return self_test()
    if "--base" in argv:
        base = argv[argv.index("--base") + 1]
        files = new_files_since(base)
        print(f"new migrations since {base}: {len(files)}")
    else:
        files = [a for a in argv if not a.startswith("--")]
    if not files:
        print("check_migrations: nothing to check")
        return 0
    findings: list[str] = []
    for path in files:
        findings += check_file(path)
    for f in findings:
        print(f)
    print(f"check_migrations: {len(files)} file(s), {len(findings)} finding(s)")
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
