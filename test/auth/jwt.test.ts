import { describe, expect, it } from "vitest";
import { signAccessToken, verifyAccessToken } from "../../src/auth/jwt.js";

const SECRET = "s".repeat(40);
const T = new Date("2026-10-24T10:00:00Z");
const claims = { sub: "rdr_1", actor: "rider" as const, sid: "sid_1", zones: [] };

describe("access tokens", () => {
  it("round-trips its claims and expires after its lifetime", () => {
    const token = signAccessToken(claims, SECRET, 900, T);
    const ok = verifyAccessToken(token, SECRET, new Date(T.getTime() + 899_000));
    expect(ok).toMatchObject({ ok: true, claims: { ...claims, iss: "movera", typ: "access", exp: T.getTime() / 1000 + 900 } });
    expect(verifyAccessToken(token, SECRET, new Date(T.getTime() + 900_000))).toEqual({ ok: false, reason: "expired" });
    // Sign-out's grace: an expired token is accepted only within the grace.
    expect(verifyAccessToken(token, SECRET, new Date(T.getTime() + 900_000 + 59_000), 60).ok).toBe(true);
    expect(verifyAccessToken(token, SECRET, new Date(T.getTime() + 900_000 + 60_000), 60)).toEqual({ ok: false, reason: "expired" });
  });

  it("refuses another secret, a changed payload, another algorithm and junk", () => {
    const token = signAccessToken(claims, SECRET, 900, T);
    expect(verifyAccessToken(token, "x".repeat(40), T)).toEqual({ ok: false, reason: "bad_signature" });
    const [h, p, s] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p!, "base64url").toString()), actor: "admin" })).toString("base64url");
    expect(verifyAccessToken(`${h}.${forged}.${s}`, SECRET, T)).toEqual({ ok: false, reason: "bad_signature" });
    const none = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    expect(verifyAccessToken(`${none}.${p}.`, SECRET, T)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyAccessToken("not-a-token", SECRET, T)).toEqual({ ok: false, reason: "malformed" });
  });
});
