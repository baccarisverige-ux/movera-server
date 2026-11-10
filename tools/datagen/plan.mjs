// Data generator plan (global plan step 61, T2): the configured distribution, the PRNG and the row counts for a scale.
// Pure: no I/O. datagen.mjs writes the rows; test/tools/datagen.test.ts reads DISTRIBUTION and planCounts() to check
// that what landed in the database matches what was asked.

/** Hard max for --scale without --unsafe-max (scale 1 = 10k riders + 10k drivers, owner Rule 33 peak). */
export const MAX_SCALE = 3;

/**
 * The configured spread. Shares are fractions of the whole; the proof test checks the database against these.
 * Zones: Stockholm Z001 (SEK), Paris FR-PC (EUR), Greater Tunis TN-TC (TND, 3 decimals, prices in steps of 50 millimes,
 * owner order TN-9).
 */
export const DISTRIBUTION = Object.freeze({
  zones: Object.freeze([
    Object.freeze({ zoneId: "Z001", share: 0.5, country: "SE", currency: "SEK", digits: 2, step: 100, base: 45, perKm: 12, lat: 59.334, lng: 18.063, dLat: 0.12, dLng: 0.2, phone: "+4670", phoneDigits: 7 }),
    Object.freeze({ zoneId: "FR-PC", share: 0.35, country: "FR", currency: "EUR", digits: 2, step: 5, base: 3, perKm: 1.5, lat: 48.8566, lng: 2.3522, dLat: 0.15, dLng: 0.22, phone: "+336", phoneDigits: 8 }),
    Object.freeze({ zoneId: "TN-TC", share: 0.15, country: "TN", currency: "TND", digits: 3, step: 50, base: 2.5, perKm: 0.9, lat: 36.8, lng: 10.18, dLat: 0.1, dLng: 0.12, phone: "+2162", phoneDigits: 7 }),
  ]),
  /** Finished trips (history). Active and booked rides come on top (see planCounts). */
  tripStatus: Object.freeze({
    completed: 0.8,
    cancelled_by_rider: 0.08,
    expired: 0.045,
    cancelled_by_driver: 0.03,
    no_show: 0.02,
    cancelled_by_system: 0.015,
    cancelled_by_admin: 0.005,
    failed: 0.005,
  }),
  /** Live trips going on "now" (end of the range); each has its own rider and driver (unique indexes). */
  activeStatus: Object.freeze({ searching: 0.25, accepted: 0.15, driver_to_pickup: 0.25, arrived: 0.1, in_trip: 0.25 }),
  paymentMethod: Object.freeze({ card: 0.6, apple_pay: 0.15, cash: 0.15, wallet: 0.1 }),
  driverAccount: Object.freeze({ active: 0.85, pending: 0.1, on_hold: 0.03, suspended: 0.02 }),
  categories: Object.freeze({ economy: 0.55, comfort: 0.2, premium: 0.08, xl: 0.08, electric: 0.05, pet: 0.02, child_seat: 0.02 }),
  /** Per-trip / per-person rates. */
  activeTripsPerDriver: 0.015,
  bookedRidesShare: 0.005,
  fleetOwnersPerDriver: 0.02,
  fleetMemberShare: 0.3,
  chatTripShare: 0.12,
  ticketsPerTrip: 1 / 150,
  auditPerTrip: 1 / 40,
  tipShare: 0.05,
  admins: 25,
});

/** mulberry32: small, fast, deterministic. */
export function prng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A seed for one stream (e.g. "trips", chunk 17) so chunks give the same rows in any order / concurrency. */
export function streamSeed(seed, name, index = 0) {
  let h = (Number(seed) ^ 0x9e3779b9) >>> 0;
  for (const ch of `${name}#${index}`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return h;
}

/** Pick a key of a {key: share} table. */
export function pick(rand, table) {
  const r = rand();
  let acc = 0;
  let last;
  for (const [k, w] of Object.entries(table)) {
    acc += w;
    last = k;
    if (r < acc) return k;
  }
  return last;
}

/** Validated options → planned counts. Throws Error with a clear message on bad input. */
export function planCounts({ scale, tripsPerRider = 100, months = 6, unsafeMax = false }) {
  const s = Number(scale);
  if (!Number.isFinite(s) || s <= 0) throw new Error(`--scale must be a positive number, got "${scale}"`);
  if (s > MAX_SCALE && !unsafeMax) throw new Error(`--scale ${s} is above the hard max ${MAX_SCALE}; pass --unsafe-max if you really mean it`);
  const tpr = Number(tripsPerRider);
  if (!Number.isFinite(tpr) || tpr < 0 || tpr > 1000) throw new Error(`--trips-per-rider must be 0..1000, got "${tripsPerRider}"`);
  const m = Number(months);
  if (!Number.isInteger(m) || m < 1 || m > 36) throw new Error(`--months must be a whole number 1..36, got "${months}"`);
  const D = DISTRIBUTION;
  const riders = Math.max(10, Math.round(10_000 * s));
  const drivers = Math.max(10, Math.round(10_000 * s));
  const historicTrips = Math.round(riders * tpr);
  const activeTrips = Math.min(Math.floor(drivers * D.activeTripsPerDriver), Math.floor(riders / 2));
  const bookedRides = Math.round(historicTrips * D.bookedRidesShare);
  return {
    scale: s,
    months: m,
    riders,
    drivers,
    vehicles: drivers,
    fleets: Math.max(1, Math.round(drivers * D.fleetOwnersPerDriver)),
    admins: D.admins,
    historicTrips,
    activeTrips,
    bookedRides,
    trips: historicTrips + activeTrips + bookedRides,
  };
}

/** Round an amount in major units to the zone's minor step (TND: 50 millimes, 3 decimals). */
export function toMinor(zone, major) {
  const minor = Math.round(major * 10 ** zone.digits);
  return Math.max(zone.step, Math.round(minor / zone.step) * zone.step);
}
