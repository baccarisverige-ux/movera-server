// Types for simulate.mjs so test/tools/loadtest_phones.test.ts type-checks (tsconfig has no allowJs).
export type EndpointCount = { count: number; perMinute: number; budgetPerMinute: number; deviationPct: number; within: boolean };
export type StateReport = { phoneMinutes: number; gated: boolean; within: boolean; budgetPerMinute: number; perMinute: number; endpoints: Record<string, EndpointCount> };
export type PhoneReport = {
  pass: boolean;
  cadence: string;
  tolerancePct: number;
  minPhoneMinutes: number;
  gatedStates: number;
  states: Record<string, StateReport>;
  reactions: Record<string, { events: number; requests: number; perEvent: number | null; budgetPerEvent: number; capSeconds: number }>;
  other: Record<string, Record<string, number>>;
  status: Record<string, number>;
  errors: Record<string, number>;
  toolLagMs: { p50: number | null; p95: number | null; max: number | null };
  latencyFromPlannedMs: { p50: number | null; p95: number | null };
  extra: Record<string, number>;
};
export function runVirtual(options?: {
  minutes?: number;
  riderArrivalsPerMinute?: number;
  drivers?: number;
  driverOfflineShare?: number;
  zoneShare?: string;
  seed?: number;
  accessTtlSeconds?: number;
  noDriverShare?: number;
  riderDwell?: Record<string, number>;
  driverDwell?: Record<string, number>;
  /** cadence table: "old" (default) or "real" (S4e, LOADTEST_CADENCE=real) */
  cadence?: string;
}): Promise<{ report: PhoneReport; arrivals: number; expectedArrivals: number; zones: { rider: Record<string, number>; driver: Record<string, number> }; refreshCalls: number }>;
