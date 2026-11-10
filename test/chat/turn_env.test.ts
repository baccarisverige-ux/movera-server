import { describe, expect, it } from "vitest";
import { readEnv, startupWarnings } from "../../src/env.js";

/** v0.18.56 §78 (inAppCalls.turnEnv, G9-2.4): the STUN / TURN names are checked at start-up. */
const base = { MOVERA_ENV: "development" };

describe("TURN / STUN in the start-up check", () => {
  it("T1 both TURN names or neither; a bad URL list stops the start", () => {
    expect(() => readEnv({ ...base, MOVERA_TURN_URLS: "turn:turn.example.test:3478" })).toThrow(/MOVERA_TURN_SECRET/);
    expect(() => readEnv({ ...base, MOVERA_TURN_SECRET: "x".repeat(20) })).toThrow(/MOVERA_TURN_URLS/);
    expect(() => readEnv({ ...base, MOVERA_TURN_URLS: "https://nope", MOVERA_TURN_SECRET: "x".repeat(20) })).toThrow(/MOVERA_TURN_URLS/);
    expect(() => readEnv({ ...base, MOVERA_STUN_URLS: "turn:wrong" })).toThrow(/MOVERA_STUN_URLS/);
    const ok = readEnv({ ...base, MOVERA_STUN_URLS: "stun:a.test:3478, stun:b.test", MOVERA_TURN_URLS: "turn:t.test:3478,turns:t.test:5349", MOVERA_TURN_SECRET: "x".repeat(20) });
    expect(ok.MOVERA_TURN_URLS).toContain("turns:");
  });

  it("T2 staging / production without TURN start with a visible warning; development stays quiet", () => {
    expect(startupWarnings(readEnv(base))).toEqual([]);
    const staging = readEnv({ MOVERA_ENV: "staging", DATABASE_URL: "postgres://u:p@h/d", JWT_SECRET: "j".repeat(40) });
    expect(startupWarnings(staging).join(" ")).toMatch(/MOVERA_TURN_URLS/);
  });
});
