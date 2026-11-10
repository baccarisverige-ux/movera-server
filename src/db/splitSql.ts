/**
 * Splits a migration file into statements on `;` outside quotes, dollar-quotes and comments. Needed for
 * `-- movera: no-transaction` files: Postgres runs a multi-statement simple query in one implicit transaction,
 * which CREATE INDEX CONCURRENTLY refuses, so each statement must go over the wire on its own.
 */
export function splitSql(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let i = 0;
  const push = (end: number): void => {
    const text = sql.slice(start, end).trim();
    if (text !== "" && !isOnlyComments(text)) statements.push(text);
  };
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === "-" && next === "-") {
      const eol = sql.indexOf("\n", i);
      i = eol === -1 ? sql.length : eol + 1;
    } else if (ch === "/" && next === "*") {
      const close = sql.indexOf("*/", i + 2);
      i = close === -1 ? sql.length : close + 2;
    } else if (ch === "'" || ch === '"') {
      i = skipQuoted(sql, i, ch);
    } else if (ch === "$") {
      const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i));
      if (tag === null) {
        i += 1;
      } else {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        i = close === -1 ? sql.length : close + tag[0].length;
      }
    } else if (ch === ";") {
      push(i);
      start = i + 1;
      i += 1;
    } else {
      i += 1;
    }
  }
  push(sql.length);
  return statements;
}

function skipQuoted(sql: string, from: number, quote: string): number {
  let i = from + 1;
  while (i < sql.length) {
    if (sql[i] === quote) {
      if (sql[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return sql.length;
}

function isOnlyComments(text: string): boolean {
  return text
    .split("\n")
    .every((line) => line.trim() === "" || line.trim().startsWith("--"));
}
