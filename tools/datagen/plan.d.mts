// Types for plan.mjs so test/tools/datagen.test.ts type-checks (tsconfig has no allowJs).
export type ZoneSpec = { zoneId: string; share: number; country: string; currency: "SEK" | "EUR" | "TND"; digits: number; step: number; base: number; perKm: number; lat: number; lng: number; dLat: number; dLng: number; phone: string; phoneDigits: number };
export const MAX_SCALE: number;
export const DISTRIBUTION: Readonly<{
  zones: readonly ZoneSpec[];
  tripStatus: Readonly<Record<string, number>>;
  activeStatus: Readonly<Record<string, number>>;
  paymentMethod: Readonly<Record<string, number>>;
  driverAccount: Readonly<Record<string, number>>;
  categories: Readonly<Record<string, number>>;
  activeTripsPerDriver: number;
  bookedRidesShare: number;
  fleetOwnersPerDriver: number;
  fleetMemberShare: number;
  chatTripShare: number;
  ticketsPerTrip: number;
  auditPerTrip: number;
  tipShare: number;
  admins: number;
}>;
export type PlanCounts = { scale: number; months: number; riders: number; drivers: number; vehicles: number; fleets: number; admins: number; historicTrips: number; activeTrips: number; bookedRides: number; trips: number };
export function prng(seed: number): () => number;
export function streamSeed(seed: number, name: string, index?: number): number;
export function pick(rand: () => number, table: Readonly<Record<string, number>>): string;
export function planCounts(input: { scale: unknown; tripsPerRider?: unknown; months?: unknown; unsafeMax?: boolean }): PlanCounts;
export function toMinor(zone: ZoneSpec, major: number): number;
