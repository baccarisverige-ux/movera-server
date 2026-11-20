// Types for guards.mjs so test/tools/loadtest_guards.test.ts type-checks (tsconfig has no allowJs).
export class LoadtestGuardError extends Error {}
export const HARD_MAX: Readonly<{ drivers: number; riders: number; seconds: number; spikeSeconds: number; rps: number; totalSeconds: number }>;
export const SERVER_ENV_ALLOW: readonly string[];
export function isLocalHost(hostname: string | undefined): boolean;
export function checkTarget(adminUrl: string | undefined, dbName: string, env?: Record<string, string | undefined>): { host: string; dbName: string };
export function dropAllowed(argv: readonly string[], dbName: string): boolean;
export function serverEnv(parentEnv: Record<string, string | undefined>, explicit: Record<string, string>): Record<string, string>;
export function redact(text: unknown): string;
export function checkLimits(input: {
  drivers?: string | number;
  riders?: string | number;
  seconds?: string | number;
  spikeSeconds?: string | number;
  steps?: (string | number)[];
  spikes?: (string | number)[];
  unsafeMax?: boolean;
}): { drivers: number; riders: number; seconds: number; spikeSeconds: number; steps: number[]; spikes: number[]; totalSeconds: number };
export const PHONE_MAX: Readonly<{ riderArrivalsPerMinute: number; accessTtlSeconds: number }>;
export function checkPhoneLimits(input: {
  drivers?: string | number;
  riders?: string | number;
  seconds?: string | number;
  riderArrivals?: string | number;
  accessTtl?: string | number;
  unsafeMax?: boolean;
}): { drivers: number; riders: number; seconds: number; riderArrivalsPerMinute: number; accessTtlSeconds: number };
export const START_SPREAD_DEFAULT_SECONDS: number;
export function driverStartSpreadMs(value: string | undefined): number;
