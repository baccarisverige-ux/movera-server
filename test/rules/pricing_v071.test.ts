import { describe, expect, it } from "vitest";
import { contractJson } from "../../src/contract/contract.js";
import { pricingProblems } from "../../src/config/pricingRules.js";
import { localTime, overlappingWindows, profileAt, scheduledSurgeAt, smartStep, type SmartSettings, type SmartState } from "../../src/pricing/surge.js";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const doc = () => structuredClone(contractJson<Json>("fixtures/config/pricing_document.json"));
const sek = (amountMinor: number) => ({ amountMinor, currency: "SEK" });

describe("smart surge (contract fixtures/smart_surge.json)", () => {
  const fixture = contractJson<{ version: string; cases: Json[]; profilePicks: Json[] }>("fixtures/smart_surge.json");
  const smart = doc().surge.smart as SmartSettings;

  it("is the v0.7.1 fixture", () => {
    expect(fixture.version).toBe("0.7.1");
    expect(fixture.cases.length).toBeGreaterThanOrEqual(2);
  });

  it.each(fixture.cases.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    const profile = smart.profiles.find((p) => p.id === c.profileId)!;
    let state: SmartState = { multiplier: 1, upSince: null, lowSince: null, lastChange: null };
    const got: number[] = [];
    for (const check of c.checks) {
      state = smartStep(smart, profile, c.maxMultiplier, state, check.atMin, check.ratio);
      got.push(state.multiplier);
    }
    expect(got).toEqual(c.expect);
  });

  it.each(fixture.profilePicks.map((p) => [`${p.weekday} ${p.minute}`, p] as const))("profile at %s", (_k, p) => {
    expect(profileAt(smart, p.weekday, p.minute)?.id).toBe(p.expect);
  });

  it("reads the zone's local weekday and minute", () => {
    // 2026-10-30 is a Friday; 21:30 UTC is 22:30 in Stockholm (CET).
    expect(localTime(new Date("2026-10-30T21:30:00Z"), "Europe/Stockholm")).toEqual({ weekday: 4, minute: 22 * 60 + 30 });
  });
});

describe("overlapping planned surges (contract fixtures/surge.json scheduledOverlap)", () => {
  const overlap = contractJson<Json>("fixtures/surge.json")["scheduledOverlap"];
  it("the higher window counts at every fixture time", () => {
    for (const c of overlap.cases as Json[]) expect(scheduledSurgeAt(overlap.windows, new Date(c.at)).multiplier, c.at).toBe(c.multiplier);
  });
  it("names the windows that overlap, for the admin's warning", () => {
    expect(overlappingWindows(overlap.windows)).toEqual([["w1", "w2"]]);
  });
});

describe("pricing document v0.7.1 checks", () => {
  it("one seat fee, only on Child Seat", () => {
    const d = doc();
    d.categories.economy.childSeatFee = sek(1500);
    d.categories.child_seat.babySeatFee = sek(1500);
    const problems = pricingProblems(d);
    expect(problems).toContain("categories.economy.childSeatFee: a seat fee exists only on Child Seat");
    expect(problems).toContain("categories.child_seat.babySeatFee: there is one seat fee (childSeatFee); the baby seat fee is gone");
  });
});
