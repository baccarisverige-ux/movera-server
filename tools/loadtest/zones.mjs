// Zones the fake phones live in (global plan step 60). Owner order TN-9a (2026-11-10): "Tunis traffic in every
// stress/load test" — a configurable share of riders and drivers in Greater Tunis (TN-TC: country TN, TND, +216 test
// numbers) next to Stockholm (Z001) and Paris (FR-PC). Ids, countries and currencies as migrations/0028_zones.sql.
import { LoadtestGuardError } from "./guards.mjs";

export const ZONES = Object.freeze({
  Z001: { zoneId: "Z001", country: "SE", currency: "SEK", language: "sv", center: { lat: 59.3326, lng: 18.0649 }, riderPrefix: "+46731", driverPrefix: "+46709" },
  "FR-PC": { zoneId: "FR-PC", country: "FR", currency: "EUR", language: "fr", center: { lat: 48.8566, lng: 2.3522 }, riderPrefix: "+33612", driverPrefix: "+33698" },
  "TN-TC": { zoneId: "TN-TC", country: "TN", currency: "TND", language: "fr", center: { lat: 36.8065, lng: 10.1815 }, riderPrefix: "+21629", driverPrefix: "+21650" },
});

export const DEFAULT_SHARE = "Z001=0.5,FR-PC=0.3,TN-TC=0.2";

/** "Z001=0.5,FR-PC=0.3,TN-TC=0.2" → [{zoneId, share}] summing to 1. Unknown zones and bad numbers are refused. */
export function parseZoneShare(text = DEFAULT_SHARE) {
  const parts = String(text)
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const [zoneId, raw] = p.split("=");
      const share = Number(raw);
      if (!ZONES[zoneId]) throw new LoadtestGuardError(`--zone-share: unknown zone "${zoneId}" (known: ${Object.keys(ZONES).join(", ")})`);
      if (!Number.isFinite(share) || share < 0) throw new LoadtestGuardError(`--zone-share: bad share "${raw}" for ${zoneId}`);
      return { zoneId, share };
    });
  const total = parts.reduce((s, p) => s + p.share, 0);
  if (!parts.length || total <= 0) throw new LoadtestGuardError("--zone-share needs at least one zone with a share above 0");
  return parts.map((p) => ({ zoneId: p.zoneId, share: p.share / total }));
}

/** The zone of phone number `i` out of `n`: exact shares by position (not random), so small runs keep the share. */
export function zoneForIndex(shares, i, n) {
  const x = (i + 0.5) / n;
  let acc = 0;
  for (const s of shares) {
    acc += s.share;
    if (x < acc) return ZONES[s.zoneId];
  }
  return ZONES[shares[shares.length - 1].zoneId];
}

/** A test phone number of the zone's country: prefix + 7 digits (SE +4673…, FR +336…, TN +216 2x/5x …). */
export function phoneNumber(zone, actor, i) {
  const prefix = actor === "driver" ? zone.driverPrefix : zone.riderPrefix;
  return `${prefix}${String(i).padStart(prefix.startsWith("+216") ? 6 : 7, "0")}`;
}

/** A point within about r degrees of the zone centre (rng: () => [0, 1)). */
export function near(zone, rng, r = 0.02) {
  return { lat: zone.center.lat + (rng() - 0.5) * 2 * r, lng: zone.center.lng + (rng() - 0.5) * 3 * r };
}
