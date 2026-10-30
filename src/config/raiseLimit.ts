import type { Executor } from "../db/db.js";
import { contract } from "../contract/contract.js";
import { liveDocument } from "./service.js";

/**
 * Contract v0.18.6 (owner G4-E4 "2×, admin can change", contract.json#dispatch.raisePrice): the most a rider may raise
 * the fare to is maxFactor × the booked fare, a per-zone admin setting DispatchDocument.raisePrice.maxFactor (per zone or
 * the country standard; SE and FR alike). Missing or out of range = the contract default (2). The rider app reads the
 * same number as RiderAppConfig.raisePrice.maxFactor, which the server writes from the dispatch document.
 */
type RaisePrice = { maxFactor: number; range: [number, number] };
const RAISE: RaisePrice = (contract as unknown as { dispatch: { raisePrice: RaisePrice } }).dispatch.raisePrice;
export const DEFAULT_RAISE_MAX_FACTOR = RAISE.maxFactor;

export function validFactor(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= RAISE.range[0] && value <= RAISE.range[1] ? value : null;
}

/** The raise limit of a scope (a zone, or a standard-<CC> key): its live dispatch document, else the default. */
export async function raiseMaxFactor(ex: Executor, zoneId: string): Promise<number> {
  const doc = await liveDocument<{ raisePrice?: { maxFactor?: unknown } }>(ex, "dispatch", zoneId);
  return validFactor(doc?.document.raisePrice?.maxFactor) ?? DEFAULT_RAISE_MAX_FACTOR;
}

/** A rider app document with the raise limit of its dispatch document (contract.json#configDocs.mustMatch, v0.18.6). */
export function withRaiseLimit(document: Record<string, unknown>, maxFactor: number): Record<string, unknown> {
  const current = document["raisePrice"] as { maxFactor?: unknown } | undefined;
  if (current?.maxFactor === maxFactor) return document;
  return { ...document, raisePrice: { ...(current ?? {}), maxFactor } };
}
