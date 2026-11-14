/**
 * v0.18.93 round 2 (job C9, contract.json#autoArrive.confirm; supervisor must-fix M1, Rules
 * audits/impact/c9-auto-arrive-supervisor.md): ONE GPS fix never marks the driver arrived, stops the waiting clock or
 * starts it again. Pure (no imports but types), so it is tested on its own.
 *
 * A change needs the latest counting fix AND an earlier counting fix of the same trip measured at least minGapSeconds
 * before it (the newest such one, inside the position age window), with every counting fix from that earlier one to
 * the latest on the same side. For an arrival (auto, back) the car must also be slow: every one of those fixes that
 * carries a speed at most maxArriveSpeedKmh, and the straight-line speed between the earlier fix and the latest too.
 */

type Range = { fixes: number; minGapSeconds: number; maxArriveSpeedKmh: number };

/** One stored fix of the trip (trip_locations), its distance to the pickup already worked out. */
export type CountingFix = { measuredAt: Date; meters: number; speedMps: number | null; lat: number; lng: number };

export type ConfirmRule = Range & { windowSeconds: number };

/**
 * `fixes`: the trip's counting fixes (accuracy within the limit), newest first, the first one the driver's latest
 * stored fix. `side`: true when a fix is on the side that would change the state. `slow`: the arrival speed check.
 * Answers the earlier fix of the confirming pair (its measuredAt is the moment of the change), or null.
 */
export function confirmedBy(fixes: CountingFix[], side: (f: CountingFix) => boolean, rule: ConfirmRule, slow: boolean, distance: (a: CountingFix, b: CountingFix) => number): CountingFix | null {
  const latest = fixes[0];
  if (!latest || !side(latest)) return null;
  const maxMps = rule.maxArriveSpeedKmh / 3.6;
  const tooFast = (f: CountingFix) => slow && f.speedMps !== null && f.speedMps > maxMps;
  if (tooFast(latest)) return null;
  const gapMs = rule.minGapSeconds * 1000;
  const windowMs = rule.windowSeconds * 1000;
  let seen = 1;
  for (const f of fixes.slice(1)) {
    const back = latest.measuredAt.getTime() - f.measuredAt.getTime();
    if (back > windowMs) return null;
    if (!side(f) || tooFast(f)) return null;
    seen += 1;
    if (back >= gapMs && seen >= rule.fixes) {
      if (slow && distance(f, latest) / (back / 1000) > maxMps) return null;
      return f;
    }
  }
  return null;
}
