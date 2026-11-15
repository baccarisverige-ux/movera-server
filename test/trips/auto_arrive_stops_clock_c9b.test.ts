import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { priceFare, type PricingDocument } from "../../src/rules/fare.js";
import { countsForNextStop, stopAwayFrom, stopBackAt, stopWaitedSeconds } from "../../src/trips/ride/stopClock.js";
import { confirmedBy, type CountingFix } from "../../src/trips/ride/fixConfirm.js";
import { AUTO_CONFIRM } from "../../src/trips/ride/geofence.js";
import { stopWaitSeconds, type StopVisit } from "../../src/trips/stops.js";
import { stopsWithVisits } from "../../src/trips/projection.js";

/**
 * Job C9b (contract v0.18.98 §92, contract.json#autoArrive.stops / #stopWaits.charge; owner 2026-11-02 "At the pickup AND
 * at stops", Rules decisions/driver-g7.md:84): the pure stop clock replays every case of fixtures/auto_arrive.json#stops
 * (SEK and TND, half-up): away, back (fix or tap), leave / complete while away, the charged seconds after the free
 * minutes and the stop_waiting line priced as the fare prices it.
 *
 * The server's contracts/ copy is synced from a tag (tools/sync_contract.sh); until v0.18.98 is tagged the fixture is read
 * from test/fixtures/contract-0.18.98/auto_arrive.json, a byte copy of movera-contracts 2ddf78d (v0.18.98 round 2: #firstTap sent + stored, #nextStopAuto). Once the copy carries
 * #stops, that one is read and must equal the byte copy.
 */
type StopCase = {
  id: string; currency: string; stopWaitPerMin: { amountMinor: number; currency: string }; stopFreeWaitMin: number; arriveMeters: number; leaveMeters: number;
  events: Array<{ at: number; kind: "fix" | "tap" | "leave" | "complete"; meters?: number }>;
  expect: { pausedSeconds: number; pauseCount: number; awayAtEnd: boolean; waitedSeconds: number; chargedSeconds: number; taps: string[]; stopLine: { amountMinor: number; currency: string } };
};
const COPY = `${CONTRACTS_DIR}/fixtures/auto_arrive.json`;
const PINNED = new URL("../fixtures/contract-0.18.98/auto_arrive.json", import.meta.url);
const copy = existsSync(COPY) ? JSON.parse(readFileSync(COPY, "utf8")) : null;
const pinned = JSON.parse(readFileSync(PINNED, "utf8"));
export const STOP_FIXTURE = (copy?.stops ? copy : pinned) as {
  nextStopAuto: Array<{ id: string; openStop: { away: boolean; pairMeters: [number, number] } | null; nextStopPairMeters: [number, number]; expect: "auto" | "none" }>;
  stops: StopCase[]; firstTap: unknown[] };
const pricing = JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/pricing_document.json`, "utf8")) as PricingDocument;
const T0 = Date.parse("2026-11-14T10:00:00Z");
const at = (s: number) => new Date(T0 + s * 1000);

/** The stop_waiting line the fare charges for `seconds` at the case's stopWaitPerMin (the zone's pricing in its currency). */
function stopLine(c: StopCase, seconds: number) {
  const doc = JSON.parse(JSON.stringify(pricing).replace(/"SEK"/g, `"${c.currency}"`)) as PricingDocument;
  (doc.categories as Record<string, { stopWaitPerMin: unknown }>)["economy"]!.stopWaitPerMin = c.stopWaitPerMin;
  const fare = priceFare(doc, { categoryId: "economy", km: 3, minutes: 8, kind: "live", surgeMultiplier: 1, stopWaitSeconds: [seconds] });
  return fare.fareLines.find((l) => l.code === "stop_waiting")?.amount ?? { amountMinor: 0, currency: c.currency };
}

describe("C9b stop clock = fixtures/auto_arrive.json#stops", () => {
  it("the fixture is the contract's (SEK and TND both present; the copy, once synced, equals the pinned bytes)", () => {
    expect(new Set(STOP_FIXTURE.stops.map((c) => c.currency))).toEqual(new Set(["SEK", "TND"]));
    if (copy?.stops) expect(copy).toEqual(pinned);
  });
  for (const c of STOP_FIXTURE.stops) {
    it(c.id, () => {
      let v: StopVisit = { stopIndex: 0, arrivedAt: at(0).toISOString(), arrivedBy: "tap" };
      const taps: string[] = [];
      let waited: number | undefined;
      for (const e of c.events) {
        const now = at(e.at);
        if (e.kind === "fix" && !v.away && e.meters! > c.leaveMeters) v = stopAwayFrom(v, now, now);
        else if (e.kind === "fix" && v.away && e.meters! <= c.arriveMeters) v = stopBackAt(v, now, now);
        else if (e.kind === "tap") {
          if (!v.away) taps.push("stop_already_arrived");
          else if (e.meters! <= c.leaveMeters) { v = stopBackAt(v, now, now); taps.push("ok"); }
          else taps.push("not_at_stop");
        } else if (e.kind === "leave") { v = { ...v, leftAt: now.toISOString() }; waited = stopWaitedSeconds(v, now); }
        else if (e.kind === "complete") waited = stopWaitedSeconds(v, now);
      }
      // Through the server's own per-stop seconds (stops.ts stopWaitSeconds) with the trip's kept free minutes.
      const end = at(c.events[c.events.length - 1]!.at);
      const [charged] = stopWaitSeconds({ stops: [{ lat: 0, lng: 0 }], stop_visits: [v], booking_rules: { stopFreeWaitMin: c.stopFreeWaitMin } }, end);
      expect({ pausedSeconds: v.pausedSeconds ?? 0, pauseCount: v.pauseCount ?? 0, awayAtEnd: v.away !== undefined, waitedSeconds: waited, chargedSeconds: charged, taps, stopLine: stopLine(c, charged!) }).toEqual(c.expect);
    });
  }
});

describe("C9b stop clock edges (contract.json#autoArrive.stops.away / back)", () => {
  const open: StopVisit = { stopIndex: 1, arrivedAt: at(100).toISOString(), arrivedBy: "auto" };
  it("away.since is never before arrivedAt nor after now; away twice keeps the first; a left stop never goes away", () => {
    expect(stopAwayFrom(open, at(50), at(200)).away).toEqual({ since: at(100).toISOString() });
    expect(stopAwayFrom(open, at(900), at(200)).away).toEqual({ since: at(200).toISOString() });
    const away = stopAwayFrom(open, at(300), at(300));
    expect(stopAwayFrom(away, at(400), at(400))).toBe(away);
    expect(stopAwayFrom({ ...open, leftAt: at(150).toISOString() }, at(300), at(300)).away).toBeUndefined();
  });
  it("back: resumeAt never before since nor after now; pausedSeconds / pauseCount add up; not away = unchanged", () => {
    const away = stopAwayFrom(open, at(300), at(300));
    expect(stopBackAt(away, at(250), at(320))).toEqual({ ...open, pausedSeconds: 0, pauseCount: 1 });
    expect(stopBackAt(away, at(900), at(400))).toEqual({ ...open, pausedSeconds: 100, pauseCount: 1 });
    const twice = stopBackAt(stopAwayFrom(stopBackAt(away, at(400), at(400)), at(500), at(500)), at(560), at(560));
    expect(twice).toEqual({ ...open, pausedSeconds: 160, pauseCount: 2 });
    expect(stopBackAt(open, at(400), at(400))).toBe(open);
  });
  it("waited: frozen at away.since (live and after leave), minus pausedSeconds, never below 0", () => {
    const away = stopAwayFrom({ ...open, pausedSeconds: 30, pauseCount: 1 }, at(300), at(300));
    expect(stopWaitedSeconds(away, at(1000))).toBe(170);
    expect(stopWaitedSeconds({ ...away, leftAt: at(800).toISOString() }, at(2000))).toBe(170);
    expect(stopWaitedSeconds({ ...open, pausedSeconds: 999 }, at(200))).toBe(0);
    expect(stopWaitedSeconds({ ...open, leftAt: at(160).toISOString() }, at(2000))).toBe(60);
  });
  it("a stop never arrived at counts 0; the old visit shape (no new fields) counts as before", () => {
    const old = [{ stopIndex: 0, arrivedAt: at(0).toISOString(), leftAt: at(240).toISOString() }];
    expect(stopWaitSeconds({ stops: [{}, {}], stop_visits: old }, at(1000))).toEqual([240, 0]);
  });
});

describe("C9b projection: stops[i] carries arrivedBy / away / pausedSeconds / pauseCount (contract.json#stopWaits.projection)", () => {
  const a = { address: "Hötorget", lat: 59.3346, lng: 18.0632 };
  const b = { address: "Odenplan", lat: 59.343, lng: 18.05 };
  it("the four fields of the visit; absent when the visit has none; a client echo in the stored stop never counts", () => {
    const visits = [
      { stopIndex: 0, arrivedAt: at(0).toISOString(), leftAt: at(500).toISOString(), arrivedBy: "auto", pausedSeconds: 120, pauseCount: 2, away: { since: at(400).toISOString() } },
      { stopIndex: 1, arrivedAt: at(600).toISOString(), arrivedBy: "tap" },
    ];
    expect(stopsWithVisits([{ ...a, away: { since: "x" }, pausedSeconds: 5 }, b], visits)).toEqual([
      { ...a, arrivedAt: at(0).toISOString(), leftAt: at(500).toISOString(), arrivedBy: "auto", away: { since: at(400).toISOString() }, pausedSeconds: 120, pauseCount: 2 },
      { ...b, arrivedAt: at(600).toISOString(), arrivedBy: "tap" },
    ]);
    expect(stopsWithVisits([a], [{ stopIndex: 0, arrivedAt: at(0).toISOString() }])).toEqual([{ ...a, arrivedAt: at(0).toISOString() }]);
  });
});

describe("C9b M1: the next stop's auto arrival = fixtures/auto_arrive.json#nextStopAuto (arriveMeters 100)", () => {
  // The pair as the job reads it (newest first), 5 s apart and standing still, so only the distance rule decides.
  for (const c of STOP_FIXTURE.nextStopAuto) {
    it(`${c.id} → ${c.expect}`, () => {
      const pair = [1, 0].map((k) => ({ fix: { measuredAt: at(5 * k), meters: c.nextStopPairMeters[k]!, speedMps: 0, lat: 0, lng: 0 } as CountingFix, open: c.openStop ? { away: c.openStop.away, meters: c.openStop.pairMeters[k]! } : null }));
      const openOf = new Map(pair.map((p) => [p.fix, p.open]));
      const first = confirmedBy(pair.map((p) => p.fix), (f) => countsForNextStop(100, f.meters, openOf.get(f) ?? null), { ...AUTO_CONFIRM, windowSeconds: 60 }, true, () => 0);
      expect(first ? "auto" : "none").toBe(c.expect);
    });
  }
});
