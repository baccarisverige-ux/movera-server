import { describe, expect, it } from "vitest";
import { dispatchKm } from "../../src/dispatch/engine.js";
import { reachFrom } from "../../src/dispatch/runtime/candidates.js";
import { PICKUP_KMH } from "../../src/dispatch/runtime/shared.js";

/** S01 A4: onTripReach grouped the current trips per driver with one filter per driver (O(n²)). Same output, fast. */
const ON_BOARD = new Set(["rider_onboard", "in_trip", "approaching_dropoff"]);
const STATUSES = ["accepted", "driver_to_pickup", "arrived", "rider_onboard", "in_trip", "approaching_dropoff"];
type Cur = { trip_id: string; driver_id: string | null; status: string; distance_meters: number | null; dropoff: { lat: number; lng: number } };

/** The code before the fix, kept word for word as the reference. */
function before(trip: Parameters<typeof reachFrom>[0], drivers: Array<{ driver_id: string; lat: number; lng: number }>, current: Cur[], queued: Set<string | null>, minPct: number, now: Date) {
  const out = new Map<string, { dropKm: number; inMin: number }>();
  const pickup = trip.pickup as { lat: number; lng: number };
  const h = (km: number) => (km / PICKUP_KMH) * 3600_000;
  for (const d of drivers) {
    const mine = current.filter((c) => c.driver_id === d.driver_id);
    if (mine.length !== 1) continue;
    const c = mine[0]!;
    if (!ON_BOARD.has(c.status) || queued.has(c.trip_id)) continue;
    const leftKm = dispatchKm({ lat: d.lat, lng: d.lng }, c.dropoff);
    const totalKm = Number(c.distance_meters ?? 0) / 1000;
    const donePct = totalKm > 0 ? Math.max(0, 1 - leftKm / totalKm) * 100 : 0;
    if (donePct < minPct) continue;
    const endMs = now.getTime() + h(leftKm);
    const dropKm = dispatchKm(c.dropoff, pickup);
    if (trip.kind === "scheduled" && (trip.scheduled_at === null || endMs + h(dropKm) > trip.scheduled_at.getTime())) continue;
    out.set(d.driver_id, { dropKm, inMin: Math.max(0, Math.round((endMs - now.getTime()) / 60_000)) });
  }
  return out;
}

function world(n: number, seed: number) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const drivers = Array.from({ length: n }, (_, i) => ({ driver_id: `D${i}`, lat: 59.2 + rnd() * 0.3, lng: 17.9 + rnd() * 0.3 }));
  const current: Cur[] = [];
  for (const d of drivers) {
    const k = rnd() < 0.1 ? 0 : rnd() < 0.1 ? 2 : 1; // some with none, some with two trips
    for (let j = 0; j < k; j++) current.push({ trip_id: `${d.driver_id}-T${j}`, driver_id: d.driver_id, status: STATUSES[Math.floor(rnd() * STATUSES.length)]!, distance_meters: rnd() < 0.05 ? null : 2000 + rnd() * 30000, dropoff: rnd() < 0.5 ? { lat: d.lat + rnd() * 0.01, lng: d.lng + rnd() * 0.01 } : { lat: 59.2 + rnd() * 0.3, lng: 17.9 + rnd() * 0.3 } });
  }
  current.push({ trip_id: "orphan", driver_id: null, status: "in_trip", distance_meters: 1000, dropoff: { lat: 59.3, lng: 18 } });
  const queued = new Set<string | null>(current.filter(() => rnd() < 0.05).map((c) => c.trip_id));
  return { drivers, current, queued };
}

describe("onTripReach grouping (S01 A4)", () => {
  const now = new Date("2026-11-11T12:00:00Z");
  const trips = [
    { pickup: { lat: 59.33, lng: 18.06 }, kind: "now", scheduled_at: null },
    { pickup: { lat: 59.33, lng: 18.06 }, kind: "scheduled", scheduled_at: new Date(now.getTime() + 40 * 60_000) },
    { pickup: { lat: 59.33, lng: 18.06 }, kind: "scheduled", scheduled_at: null },
  ] as unknown as Array<Parameters<typeof reachFrom>[0]>;

  it("gives exactly the same drivers, km and minutes as the old per-driver filter", () => {
    for (const seed of [1, 7, 42]) {
      const w = world(800, seed);
      for (const trip of trips) for (const minPct of [0, 70]) {
        const got = reachFrom(trip, w.drivers, w.current, w.queued, minPct, now);
        const want = before(trip, w.drivers, w.current, w.queued, minPct, now);
        expect([...got.entries()].sort()).toEqual([...want.entries()].sort());
        if (!(trip.kind === "scheduled" && trip.scheduled_at === null)) expect(got.size).toBeGreaterThan(0);
      }
    }
  });

  it("handles 5,000 on-trip drivers well under 50 ms", () => {
    const w = world(5000, 3);
    const t0 = performance.now();
    reachFrom(trips[0]!, w.drivers, w.current, w.queued, 70, now);
    expect(performance.now() - t0).toBeLessThan(50);
  });
});
