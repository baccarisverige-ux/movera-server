import { sql } from "kysely";
import type { Executor } from "../db/db.js";

/**
 * S04 A1: a bigserial `sequence` is taken at insert time, not at commit, so rows can become visible out of order
 * (T1 takes 4, T2 takes 5, T2 commits first). A reader that jumps its cursor to the highest row it saw never sees 4.
 *
 * SettledCursor keeps two things instead of one number:
 * - `floor`: every sequence at or below it is settled (its transaction committed or rolled back) and was read;
 * - `seen`: sequences above the floor already handed out (so a re-read never hands one out twice).
 * Every read starts at the floor. A checkpoint (snapshot xmax, sequence last_value) is taken at each read; once the
 * oldest running transaction (snapshot xmin) is past that xmax, every sequence up to last_value is settled, and the
 * floor moves there. No migration; one extra tiny query per read; safe with several server copies (rule 33).
 */
export class SettledCursor {
  private readonly seen = new Set<number>();
  private pending: { xmax: bigint; seq: number }[] = [];

  constructor(
    public floor: number,
    private readonly sequenceOf: string,
  ) {}

  /** Highest sequence handed out (or the floor): the SSE cursor. */
  get high(): number {
    let top = this.floor;
    for (const s of this.seen) if (s > top) top = s;
    return top;
  }

  /** Reads rows after the floor with `read`, returns only the ones not handed out before, in sequence order. */
  async next<R extends { sequence: string | number }>(ex: Executor, limit: number, read: (after: number, limit: number) => Promise<R[]>): Promise<{ rows: R[]; full: boolean }> {
    const { rows: snap } = await sql<{ xmin: string; xmax: string; last: string }>`
      SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS xmin, pg_snapshot_xmax(pg_current_snapshot())::text AS xmax,
        (SELECT CASE WHEN is_called THEN last_value ELSE 0 END FROM ${sql.table(this.sequenceOf)})::text AS last`.execute(ex);
    const s = snap[0]!;
    const xmin = BigInt(s.xmin);
    let settled = this.floor;
    this.pending = this.pending.filter((cp) => {
      if (cp.xmax > xmin) return true;
      settled = Math.max(settled, cp.seq);
      return false;
    });
    this.pending.push({ xmax: BigInt(s.xmax), seq: Number(s.last) });
    // Read after the snapshot above: every transaction settled by then is visible to this read.
    // Rows above the floor already handed out come back too: ask for that many more.
    const ask = limit + this.seen.size;
    const rows = await read(this.floor, ask);
    const full = rows.length === ask;
    if (full) settled = Math.min(settled, Number(rows[rows.length - 1]!.sequence));
    const fresh = rows.filter((row) => !this.seen.has(Number(row.sequence)));
    for (const row of fresh) this.seen.add(Number(row.sequence));
    if (settled > this.floor) {
      this.floor = settled;
      for (const q of this.seen) if (q <= settled) this.seen.delete(q);
    }
    return { rows: fresh, full };
  }

  /** Rows another reader read: keeps the ones this cursor has not handed out yet, and marks them handed out. */
  take<R extends { sequence: string | number }>(rows: R[]): R[] {
    const fresh = rows.filter((row) => Number(row.sequence) > this.floor && !this.seen.has(Number(row.sequence)));
    for (const row of fresh) this.seen.add(Number(row.sequence));
    return fresh;
  }

  /** Another reader proved everything up to `floor` settled and handed out: forget the older sequences. */
  settleTo(floor: number): void {
    if (floor <= this.floor) return;
    this.floor = floor;
    for (const q of this.seen) if (q <= floor) this.seen.delete(q);
  }
}
