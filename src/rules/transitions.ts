import { contractJson } from "../contract/contract.js";

/**
 * Trip lifecycle: the single trip state machine of CONTRACT.md §3.
 *
 * Everything here is read from contract.json once, when the module loads, and checked against the literal
 * types below. If the contract adds or renames a status or actor, loading this module throws, so the types
 * can never drift from the contract silently. Exported arrays and tables are frozen at runtime; the status sets are read-only at the type level only, so callers use isTerminal() and friends rather than the sets themselves. All functions are pure.
 */

/** Every trip status, in contract order. Mirrors contract.json#tripStatus.values (checked at load). */
export const TRIP_STATUSES = Object.freeze([
  "draft",
  "quoted",
  "requested",
  "searching",
  "offered",
  "accepted",
  "driver_to_pickup",
  "arrived",
  "rider_onboard",
  "in_trip",
  "approaching_dropoff",
  "completed",
  "cancelled_by_rider",
  "cancelled_by_driver",
  "cancelled_by_admin",
  "cancelled_by_system",
  "no_show",
  "expired",
  "failed",
] as const);

/** A trip status (contract.json#tripStatus.values). */
export type TripStatus = (typeof TRIP_STATUSES)[number];

/** Who sends a command. Mirrors contract.json#actors (checked at load). */
export const ACTORS = Object.freeze(["rider", "driver", "admin", "system"] as const);

/** An actor (contract.json#actors). */
export type Actor = (typeof ACTORS)[number];

/** Trip kinds (CONTRACT.md §2 Trip.kind); also the values a transition row's `when` may take. */
export const TRIP_KINDS = Object.freeze(["live", "scheduled"] as const);

/** Whether a trip is a live ride or a scheduled reservation (CONTRACT.md §2 Trip.kind, contract.json#transitions[].when). */
export type TripKind = (typeof TRIP_KINDS)[number];

/** One row of contract.json#transitions: `command × actor × from[] → to`, optionally only for one trip kind. */
export interface TransitionRow {
  readonly command: string;
  readonly actor: Actor;
  readonly from: readonly TripStatus[];
  readonly to: TripStatus;
  /** Present only where the target differs by trip kind; the row then applies to that kind only. */
  readonly when?: TripKind;
  /** Extra condition the caller must check before applying the row, e.g. "waited >= noShowAfterMin". */
  readonly guard?: string;
  /** Name of the fee rule the row charges, e.g. "riderCancelFee". */
  readonly fee?: string;
}

/** One row of contract.json#ratingAllowed.rules. A missing `command` matches any ending command. */
export interface RatingRule {
  readonly rater: Actor;
  readonly status: TripStatus;
  readonly command?: string;
}

type RawContract = {
  tripStatus: { values: unknown[]; terminal: unknown[]; driverAssigned: unknown[]; riderOnboard: unknown[] };
  actors: unknown[];
  transitions: Array<Record<string, unknown>>;
  ratingAllowed: { rules: Array<Record<string, unknown>> };
};

/** True when `value` is one of contract.json#tripStatus.values. */
export function isTripStatus(value: unknown): value is TripStatus {
  return typeof value === "string" && (TRIP_STATUSES as readonly string[]).includes(value);
}

/** True when `value` is one of contract.json#actors. */
export function isActor(value: unknown): value is Actor {
  return typeof value === "string" && (ACTORS as readonly string[]).includes(value);
}

/** True when `value` is a trip kind, "live" or "scheduled" (CONTRACT.md §2 Trip.kind). */
export function isTripKind(value: unknown): value is TripKind {
  return typeof value === "string" && (TRIP_KINDS as readonly string[]).includes(value);
}

function status(value: unknown, where: string): TripStatus {
  if (!isTripStatus(value)) throw new Error(`contract.json ${where}: unknown trip status ${JSON.stringify(value)}`);
  return value;
}

function actor(value: unknown, where: string): Actor {
  if (!isActor(value)) throw new Error(`contract.json ${where}: unknown actor ${JSON.stringify(value)}`);
  return value;
}

function text(value: unknown, where: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`contract.json ${where}: expected a non-empty string`);
  return value;
}

function optionalText(value: unknown, where: string): string | undefined {
  return value === undefined ? undefined : text(value, where);
}

function statusList(values: unknown, where: string): readonly TripStatus[] {
  if (!Array.isArray(values)) throw new Error(`contract.json ${where}: expected an array`);
  return Object.freeze(values.map((v, i) => status(v, `${where}[${i}]`)));
}

function sameList(actual: readonly unknown[], expected: readonly string[], where: string): void {
  if (actual.length !== expected.length || actual.some((v, i) => v !== expected[i])) {
    throw new Error(`contract.json ${where} is ${JSON.stringify(actual)}; src/rules/transitions.ts expects ${JSON.stringify(expected)}`);
  }
}

const raw = contractJson<RawContract>("contract.json");
sameList(raw.tripStatus.values, TRIP_STATUSES, "#tripStatus.values");
sameList(raw.actors, ACTORS, "#actors");

/** The transition table, in contract order (contract.json#transitions, CONTRACT.md §3). Order matters: the first matching row wins. */
export const TRANSITIONS: readonly TransitionRow[] = Object.freeze(
  raw.transitions.map((row, i): TransitionRow => {
    const where = `#transitions[${i}]`;
    const when = row["when"];
    if (when !== undefined && !isTripKind(when)) throw new Error(`contract.json ${where}.when: unknown trip kind ${JSON.stringify(when)}`);
    const guard = optionalText(row["guard"], `${where}.guard`);
    const fee = optionalText(row["fee"], `${where}.fee`);
    return Object.freeze({
      command: text(row["command"], `${where}.command`),
      actor: actor(row["actor"], `${where}.actor`),
      from: statusList(row["from"], `${where}.from`),
      to: status(row["to"], `${where}.to`),
      ...(when !== undefined ? { when } : {}),
      ...(guard !== undefined ? { guard } : {}),
      ...(fee !== undefined ? { fee } : {}),
    });
  }),
);

/** The rating rules (contract.json#ratingAllowed.rules), in contract order. */
export const RATING_RULES: readonly RatingRule[] = Object.freeze(
  raw.ratingAllowed.rules.map((rule, i): RatingRule => {
    const where = `#ratingAllowed.rules[${i}]`;
    const command = optionalText(rule["command"], `${where}.command`);
    return Object.freeze({
      rater: actor(rule["rater"], `${where}.rater`),
      status: status(rule["status"], `${where}.status`),
      ...(command !== undefined ? { command } : {}),
    });
  }),
);

/** Statuses after which nothing moves the trip any more (contract.json#tripStatus.terminal). */
export const TERMINAL: ReadonlySet<TripStatus> = new Set(statusList(raw.tripStatus.terminal, "#tripStatus.terminal"));

/**
 * Statuses in which a driver holds the trip (contract.json#tripStatus.driverAssigned). From these on (and in any
 * terminal status) admin assign / radar-group is locked (CONTRACT.md §3.1 "Lock").
 */
export const DRIVER_ASSIGNED: ReadonlySet<TripStatus> = new Set(statusList(raw.tripStatus.driverAssigned, "#tripStatus.driverAssigned"));

/** Statuses in which the rider is in the car (contract.json#tripStatus.riderOnboard). */
export const RIDER_ONBOARD: ReadonlySet<TripStatus> = new Set(statusList(raw.tripStatus.riderOnboard, "#tripStatus.riderOnboard"));

/** True when the status is terminal (contract.json#tripStatus.terminal; CONTRACT.md §3 "Terminal"). */
export function isTerminal(status: TripStatus): boolean {
  return TERMINAL.has(status);
}

/**
 * The transition row that applies, or null (CONTRACT.md §3, contract.json#transitions).
 *
 * A row matches when its command and actor are equal to the ones given, the current status is in its `from`
 * list, and it either has no `when` or its `when` equals the trip kind. Rows are tried in table order and the
 * first match wins. Returning the row (not just the target) lets the caller check its `guard` and charge its `fee`.
 */
export function findTransition(status: TripStatus, command: string, actor: Actor, kind: TripKind): TransitionRow | null {
  for (const row of TRANSITIONS) {
    if (row.command === command && row.actor === actor && row.from.includes(status) && (row.when === undefined || row.when === kind)) {
      return row;
    }
  }
  return null;
}

/**
 * The status after `actor` sends `command` to a trip of kind `kind` that is in `status`, or null when the
 * table has no row for it (CONTRACT.md §3, contract.json#transitions). Null means `409 invalid_transition`
 * and the trip keeps its status. Same rule as `findTransition`.
 */
export function nextStatus(status: TripStatus, command: string, actor: Actor, kind: TripKind): TripStatus | null {
  return findTransition(status, command, actor, kind)?.to ?? null;
}

/**
 * Whether `rater` may rate a trip that ended in `terminalStatus` through the command `endedByCommand`
 * (contract.json#ratingAllowed). Allowed when the status is terminal and one rule has this rater and status,
 * and either names no command or names exactly this one. `endedByCommand` is the last command that changed
 * the trip's status (null if none did). Anything else is `409 invalid_transition`; e.g. a plain rider
 * `cancel` is never rated, but a rider `end_early` is, by the rider only.
 */
export function mayRate(rater: Actor, terminalStatus: TripStatus, endedByCommand: string | null): boolean {
  if (!TERMINAL.has(terminalStatus)) return false;
  return RATING_RULES.some(
    (rule) =>
      rule.rater === rater &&
      rule.status === terminalStatus &&
      (rule.command === undefined || rule.command === endedByCommand),
  );
}
