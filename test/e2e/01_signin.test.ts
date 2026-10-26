import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { Sim } from "./harness.js";

let sim: Sim;
beforeAll(async () => {
  sim = await Sim.start();
});
afterAll(async () => sim.stop());

describe("scenario 1: sign-in for rider, driver and admin; expired session; refresh reuse", () => {
  it("rider and driver sign in with the test code; the same phone is two separate accounts", async () => {
    const rider = await sim.rider(0);
    const driver = await sim.driver(0, null);
    expect(rider.id).toMatch(/^rdr_/);
    expect(driver.id).toMatch(/^drv_/);
    // A rider token does not open the driver app's operations, and the other way round.
    expect((await sim.request("GET", "/driver/profile", rider.token)).body).toMatchObject({ code: "forbidden", reason: "wrong_actor" });
    expect((await sim.request("GET", "/rider/profile", driver.token)).body).toMatchObject({ code: "forbidden", reason: "wrong_actor" });
    // A wrong code is refused.
    await sim.advance(31);
    const challenge = await sim.request("POST", "/auth/otp/request", undefined, { phone: TEST_PHONES[5], app: "rider" }, { key: null });
    const wrong = await sim.request("POST", "/auth/otp/verify", undefined, { phone: TEST_PHONES[5], sessionId: challenge.body["sessionId"], code: "9999" }, { key: null });
    expect(wrong.status).toBe(400);
  });

  it("the bootstrap admin signs in through the start-up password link, then with e-mail and password", async () => {
    const owner = await sim.owner();
    const me = (await owner.get("/admin/auth/me")).body;
    expect(me).toMatchObject({ role: "super", approvalExempt: true });
    // A wrong password is refused.
    const wrong = await sim.request("POST", "/admin/auth/sign-in", undefined, { email: owner.login, password: "not the password at all" }, { key: null });
    expect(wrong.status).toBe(401);
  });

  it("an expired access token answers 401 token_expired; refresh gives a working one", async () => {
    await sim.advance(31);
    const rider = await sim.rider(1);
    await sim.advance(901);
    const expired = await rider.get("/rider/profile");
    expect(expired.status).toBe(401);
    expect(expired.body["reason"]).toBe("token_expired");
    const refreshed = await sim.request("POST", "/auth/refresh", undefined, { refreshToken: rider.session.refreshToken }, { key: null });
    expect(refreshed.status).toBe(200);
    expect((await sim.request("GET", "/rider/profile", refreshed.body["accessToken"])).status).toBe(200);
  });

  it("reusing a spent refresh token ends the whole session (also the newest token); a lost-answer retry does not", async () => {
    await sim.advance(31);
    const driver = await sim.driver(1, null);
    // The app lost the answer and sends the same token again within a minute: a retry, not theft.
    const lost = await sim.request("POST", "/auth/refresh", undefined, { refreshToken: driver.session.refreshToken }, { key: null });
    expect(lost.status).toBe(200);
    const first = await sim.request("POST", "/auth/refresh", undefined, { refreshToken: driver.session.refreshToken }, { key: null });
    expect(first.status).toBe(200);
    await sim.advance(61);
    const reused = await sim.request("POST", "/auth/refresh", undefined, { refreshToken: driver.session.refreshToken }, { key: null });
    expect(reused.status).toBe(401);
    expect(reused.body["reason"]).toBe("refresh_token_reused");
    // The thief's copy and the owner's newest copy are both dead now.
    expect((await sim.request("GET", "/driver/profile", first.body["accessToken"])).body["reason"]).toBe("session_ended");
    const newest = await sim.request("POST", "/auth/refresh", undefined, { refreshToken: first.body["refreshToken"] }, { key: null });
    expect(newest.status).toBe(401);
  });

  it("admin refresh reuse ends the admin session too", async () => {
    const admin = await sim.admin("dispatcher");
    const first = await sim.request("POST", "/admin/auth/refresh", undefined, { refreshToken: admin.session.refreshToken }, { key: null });
    expect(first.status).toBe(200);
    await sim.advance(61);
    const reused = await sim.request("POST", "/admin/auth/refresh", undefined, { refreshToken: admin.session.refreshToken }, { key: null });
    expect(reused.status).toBe(401);
    expect((await sim.request("GET", "/admin/auth/me", first.body["accessToken"])).status).toBe(401);
  });
});
