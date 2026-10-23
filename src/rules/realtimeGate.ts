import { contractJson } from "../contract/contract.js";

/**
 * Realtime event gate, CONTRACT.md §4 "Realtime and synchronisation" and contract.json#realtime.
 *
 * Every app runs this gate on the trip event stream. The server runs it too, as a test oracle on its own SSE
 * output, so it follows contracts/reference_check.py (the events.json loop) line for line. Cases live in
 * fixtures/events.json.
 */

/** What the gate did with one event (the "expect" values of fixtures/events.json). */
export type Disposition = "accepted" | "accepted_with_gap" | "duplicate" | "blocked_after_terminal" | "invalid";

/**
 * The envelope fields the gate reads (contract.json#realtime.envelope). `status` is the trip status carried
 * by the event, i.e. `projection.status` on the wire; fixtures/events.json writes it at the top level as
 * shorthand (CONTRACT.md §4).
 */
export type GateEvent = {
  eventId: string;
  tripId: string;
  sequence: number;
  kind: string;
  status?: string;
};

/** Default number of event ids the gate remembers before it forgets the oldest. */
export const DEFAULT_SEEN_LIMIT = 512;

type RawContract = {
  realtime: { afterTerminal: unknown };
  tripStatus: { terminal: unknown };
};

function stringList(value: unknown, where: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((v): v is string => typeof v === "string")) {
    throw new Error(`${where} must be a list of strings`);
  }
  return Object.freeze([...value]);
}

const raw = contractJson<RawContract>("contract.json");

/** Kinds that still pass after the trip reached a terminal status (contract.json#realtime.afterTerminal). */
export const AFTER_TERMINAL_KINDS: ReadonlySet<string> = new Set(
  stringList(raw.realtime.afterTerminal, "contract.json#realtime.afterTerminal"),
);

/** Statuses that end the trip's lifecycle stream (contract.json#tripStatus.terminal). */
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set(
  stringList(raw.tripStatus.terminal, "contract.json#tripStatus.terminal"),
);

/**
 * Per-trip gate state machine, CONTRACT.md §4 "Gate" and contract.json#realtime.rules. Use one gate per trip
 * stream and feed it events in arrival order. It keeps only the last sequence, a terminal flag and a bounded
 * set of seen event ids; it reads no clock and touches nothing outside itself.
 */
export class RealtimeGate {
  private last = 0;
  private reachedTerminal = false;
  private readonly seen = new Set<string>();
  private readonly seenLimit: number;

  /**
   * `seenLimit` caps how many event ids are remembered (default 512); when full, the oldest id is dropped.
   * The reference keeps every id; the cap only matters after more than `seenLimit` distinct ids, and even
   * then a forgotten id is still caught by the `sequence <= last` rule unless it comes with a new sequence.
   */
  constructor(seenLimit: number = DEFAULT_SEEN_LIMIT) {
    if (!Number.isInteger(seenLimit) || seenLimit < 1) {
      throw new RangeError(`seenLimit must be an integer >= 1, got ${seenLimit}`);
    }
    this.seenLimit = seenLimit;
  }

  /** The highest sequence recorded so far (0 before any event). A resync asks for `events?after=` this. */
  get lastSequence(): number {
    return this.last;
  }

  /** True once an accepted event carried a terminal status (contract.json#tripStatus.terminal). */
  get terminal(): boolean {
    return this.reachedTerminal;
  }

  /**
   * Decides one event, in this order (CONTRACT.md §4 "Gate", contract.json#realtime.rules, reference_check.py):
   * 1. `invalid` when `sequence < 1` or `tripId` is empty. Nothing is recorded.
   * 2. `duplicate` when the `eventId` was seen or `sequence <= last`. Nothing is recorded.
   * 3. `blocked_after_terminal` when the trip is already terminal and `kind` is not in
   *    contract.json#realtime.afterTerminal. The event id and sequence ARE recorded, as in the reference.
   * 4. Otherwise `accepted_with_gap` when a sequence was already seen and `sequence > last + 1` (the caller
   *    should resync), else `accepted`. The id and sequence are recorded, and a `status` in
   *    contract.json#tripStatus.terminal makes the trip terminal from the next event on.
   */
  admit(event: GateEvent): Disposition {
    const { eventId, tripId, sequence, kind, status } = event;
    if (sequence < 1 || !tripId) return "invalid";
    if (this.seen.has(eventId) || sequence <= this.last) return "duplicate";
    if (this.reachedTerminal && !AFTER_TERMINAL_KINDS.has(kind)) {
      this.record(eventId, sequence);
      return "blocked_after_terminal";
    }
    const disposition: Disposition = this.last > 0 && sequence > this.last + 1 ? "accepted_with_gap" : "accepted";
    this.record(eventId, sequence);
    if (status !== undefined && TERMINAL_STATUSES.has(status)) this.reachedTerminal = true;
    return disposition;
  }

  private record(eventId: string, sequence: number): void {
    this.last = sequence;
    this.seen.add(eventId);
    if (this.seen.size > this.seenLimit) {
      // A Set iterates in insertion order, so the first value is the oldest id.
      const oldest = this.seen.values().next();
      if (!oldest.done) this.seen.delete(oldest.value);
    }
  }
}
