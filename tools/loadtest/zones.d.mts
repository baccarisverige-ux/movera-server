// Types for zones.mjs (tsconfig has no allowJs).
export type LoadZone = { zoneId: string; country: string; currency: string; language: string; center: { lat: number; lng: number }; riderPrefix: string; driverPrefix: string };
export const ZONES: Readonly<Record<string, LoadZone>>;
export const DEFAULT_SHARE: string;
export function parseZoneShare(text?: string): { zoneId: string; share: number }[];
export function zoneForIndex(shares: { zoneId: string; share: number }[], i: number, n: number): LoadZone;
export function phoneNumber(zone: LoadZone, actor: "rider" | "driver", i: number): string;
export function near(zone: LoadZone, rng: () => number, r?: number): { lat: number; lng: number };
