// Types for cadences.mjs (tsconfig has no allowJs).
export type CadenceEntry = { id: string; method: string; every: number; source: string; timer?: string; immediate?: boolean; batch?: string[]; dynamic?: { field: string; min: number; max: number } };
export const CADENCES: Readonly<Record<"rider" | "driver", Record<string, CadenceEntry[]>>>;
export const REACTIONS: Readonly<Record<"rider" | "driver", Record<string, { perEvent: number; minGapSeconds: number; source: string }>>>;
export const ON_ENTER: Readonly<Record<"rider" | "driver", Record<string, { id: string; method: string; source: string }[]>>>;
export const STREAMS: Readonly<Record<"rider" | "driver", Record<string, string>>>;
export function budgetPerMinute(app: "rider" | "driver", state: string): Record<string, number>;
export function cadenceRows(): { app: string; state: string; id: string; everySeconds: number; perMinute: number; source: string }[];
