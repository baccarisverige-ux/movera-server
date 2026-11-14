import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { priceFare, type PricingDocument } from "../../src/rules/fare.js";
import { awayFrom, backAt, chargedSecondsAt, geofenceOf, geofenceProblem } from "../../src/trips/ride/geofence.js";
import type { Waiting } from "../../src/trips/ride/shared.js";

/**
 * Job C9 (contract v0.18.93 §91): the server's waiting clock replays every case of fixtures/auto_arrive.json (SEK and
 * TND): away, back, the moved free / no-show moments, the paid seconds at board and the waiting line priced as the fare.
 */
type Case = {
  id: string; currency: string; perMin: { amountMinor: number; currency: string }; freeWaitMin: number; noShowAfterMin: number; waitFromSeconds: number;
  arriveMeters: number; leaveMeters: number; events: Array<{ at: number; kind: "fix" | "tap" | "board" | "no_show"; meters?: number }>;
  expect: { freeUntil: number; noShowAt: number; pausedSeconds: number; pauseCount: number; awayAtEnd: boolean; chargedSeconds?: number; waitingLine?: { amountMinor: number; currency: string }; noShow?: string };
};
const fixture = JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/auto_arrive.json`, "utf8")) as { clock: Case[]; settings: Array<{ autoArriveMeters: number; leaveMeters: number; expect: string }> };
const pricing = JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/pricing_document.json`, "utf8")) as PricingDocument;
const T0 = Date.parse("2026-11-14T10:00:00Z");
const at = (s: number) => new Date(T0 + s * 1000);
const sec = (iso: string) => (Date.parse(iso) - T0) / 1000;

/** The waiting line the fare charges for `seconds` at `perMin` (the zone's pricing in the case's currency). */
function waitingLine(c: Case, seconds: number) {
  const doc = JSON.parse(JSON.stringify(pricing).replace(/"SEK"/g, `"${c.currency}"`)) as PricingDocument;
  const fare = priceFare(doc, { categoryId: "economy", km: 3, minutes: 8, kind: "live", surgeMultiplier: 1, waitingChargedSeconds: seconds, waitingPerMin: c.perMin });
  return fare.fareLines.find((l) => l.code === "waiting")?.amount;
}

describe("C9 waiting clock = fixtures/auto_arrive.json", () => {
  for (const c of fixture.clock) {
    it(c.id, () => {
      let w: Waiting = { arrivedAt: at(0).toISOString(), waitFrom: at(c.waitFromSeconds).toISOString(), freeUntil: at(c.waitFromSeconds + c.freeWaitMin * 60).toISOString(), noShowAt: at(c.waitFromSeconds + c.noShowAfterMin * 60).toISOString(), chargedSeconds: 0 };
      let noShow: string | undefined;
      let charged: number | undefined;
      for (const e of c.events) {
        const now = at(e.at);
        if (e.kind === "fix" && !w.away && e.meters! > c.leaveMeters) w = awayFrom(w, now, now);
        else if (e.kind === "fix" && w.away && e.meters! <= c.arriveMeters) w = backAt(w, now, now);
        else if (e.kind === "tap" && w.away) w = backAt(w, now, now);
        else if (e.kind === "board") charged = chargedSecondsAt(w, now);
        else if (e.kind === "no_show") noShow = w.away ? "driver_away_from_pickup" : now.getTime() < Date.parse(w.noShowAt) ? "no_show_too_early" : "ok";
      }
      expect({ freeUntil: sec(w.freeUntil), noShowAt: sec(w.noShowAt), pausedSeconds: w.pausedSeconds ?? 0, pauseCount: w.pauseCount ?? 0, awayAtEnd: w.away !== undefined }).toEqual({
        freeUntil: c.expect.freeUntil, noShowAt: c.expect.noShowAt, pausedSeconds: c.expect.pausedSeconds, pauseCount: c.expect.pauseCount, awayAtEnd: c.expect.awayAtEnd,
      });
      if (c.expect.chargedSeconds !== undefined) {
        expect(charged).toBe(c.expect.chargedSeconds);
        expect(waitingLine(c, charged!)).toEqual(c.expect.waitingLine);
      }
      if (c.expect.noShow !== undefined) expect(noShow).toBe(c.expect.noShow);
    });
  }
  it("away.since is never before the arrival nor after now; a back moment never before away.since", () => {
    const w: Waiting = { arrivedAt: at(100).toISOString(), waitFrom: at(100).toISOString(), freeUntil: at(400).toISOString(), noShowAt: at(400).toISOString(), chargedSeconds: 0 };
    expect(awayFrom(w, at(50), at(200)).away).toEqual({ since: at(100).toISOString() });
    expect(awayFrom(w, at(900), at(200)).away).toEqual({ since: at(200).toISOString() });
    const away = awayFrom(w, at(300), at(300));
    expect(backAt(away, at(250), at(320))).toMatchObject({ pausedSeconds: 0, pauseCount: 1, freeUntil: at(400).toISOString() });
  });
});

describe("C9 settings (contract.json#autoArrive.settings)", () => {
  for (const s of fixture.settings) {
    it(`${s.autoArriveMeters} / ${s.leaveMeters} → ${s.expect}`, () => {
      const doc = { waiting: { autoArriveMeters: s.autoArriveMeters, leaveMeters: s.leaveMeters } };
      expect(geofenceProblem(doc) === null ? "ok" : "invalid_auto_arrive_distance").toBe(s.expect);
      expect(geofenceOf(doc)).toEqual(s.expect === "ok" ? { autoArriveMeters: s.autoArriveMeters, leaveMeters: s.leaveMeters } : { autoArriveMeters: 100, leaveMeters: 200 });
    });
  }
  it("not set: the defaults 100 / 200", () => {
    expect(geofenceOf(undefined)).toEqual({ autoArriveMeters: 100, leaveMeters: 200 });
    expect(geofenceProblem({ waiting: {} })).toBeNull();
  });
});
