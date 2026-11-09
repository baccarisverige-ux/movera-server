import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { changeAdminRole } from "../../src/admin/auth.js";
import { Admin, Sim } from "./harness.js";

/**
 * Global plan step 38 (owner Q42, 2026-11-09, "Yes, at once"): an admin's rights live in the 15-minute access token, so
 * when another admin changes his role every open session of that admin ends at once; the admin signs in again and gets
 * the new role. The same when the account is deactivated. Fails before: the old token worked until it expired.
 */

let sim: Sim;
let owner: Admin;

beforeAll(async () => {
  sim = await Sim.start({ now: new Date("2026-11-09T09:00:00Z") });
  owner = await sim.owner();
});
afterAll(async () => {
  await sim.stop();
});

async function signInAgain(admin: Admin): Promise<Admin> {
  const res = await sim.request("POST", "/admin/auth/sign-in", undefined, { email: admin.login, password: "a long e2e test password" }, { key: null });
  expect(res.status).toBe(200);
  admin.session = { accessToken: res.body["accessToken"], refreshToken: res.body["refreshToken"] };
  return admin;
}

describe("role change ends the admin's sessions at once (step 38)", () => {
  it("B's token and refresh token stop; B signs in again with the new role", async () => {
    const agent = await sim.admin("support", ["Z001"]);
    const second = await signInAgain(new Admin(sim, agent.login, agent.session));
    expect((await agent.get("/admin/auth/me")).body["role"]).toBe("support");
    // Before: a support admin may not list drivers (no drivers.read); a viewer may.
    expect((await agent.get("/admin/drivers")).status).toBe(403);
    // Admin A (super) changes B's role. The server has no role route yet (contract: PATCH /admin/agents/{adminId}
    // takes firstName only), so the change is made the way a Super admin's tool would: a role update on the row.
    const now = sim.clock.now;
    await sim.db.updateTable("admins").set({ role: "viewer", updated_at: now }).where("admin_id", "=", agent.id).execute();
    // Every session of B: both tokens get 401 session_ended on the next admin call ...
    const first = await sim.request("GET", "/admin/auth/me", agent.token);
    expect(first.status).toBe(401);
    expect(first.body["reason"]).toBe("session_ended");
    const other = await sim.request("GET", "/admin/auth/me", second.token);
    expect(other.status).toBe(401);
    expect(other.body["reason"]).toBe("session_ended");
    // ... and the refresh tokens are refused.
    const refreshed = await sim.request("POST", "/admin/auth/refresh", undefined, { refreshToken: agent.session.refreshToken }, { key: null });
    expect(refreshed.status).toBe(401);
    expect(refreshed.body["reason"]).toBe("session_ended");
    const open = await sim.db.selectFrom("auth_sessions").select("revoked_reason").where("actor", "=", "admin").where("subject_id", "=", agent.id).where("revoked_at", "is", null).execute();
    expect(open).toEqual([]);
    // B signs in again and has the new role.
    await signInAgain(agent);
    const me = await agent.get("/admin/auth/me");
    expect(me.status).toBe(200);
    expect(me.body["role"]).toBe("viewer");
    // The new role's permissions apply at once: drivers.read is now allowed.
    expect((await agent.get("/admin/drivers")).status).toBe(200);
    expect((await owner.get("/admin/agents")).body["items"]).toContainEqual(expect.objectContaining({ adminId: agent.id, role: "viewer" }));
  });

  it("changeAdminRole (route/CLI helper): role update and session end in one transaction, audited", async () => {
    const agent = await sim.admin("dispatcher", ["Z001"]);
    const changed = await changeAdminRole(sim.db, agent.id, "support", sim.clock.now, owner.id);
    expect(changed).toEqual({ from: "dispatcher", ended: 2 });
    const rows = await sim.db.selectFrom("auth_sessions").select("revoked_reason").where("actor", "=", "admin").where("subject_id", "=", agent.id).execute();
    // Two sessions: the password setup opened one, the sign-in another; both end.
    expect(rows.map((r) => r.revoked_reason)).toEqual(["role_changed", "role_changed"]);
    expect((await sim.request("GET", "/admin/auth/me", agent.token)).body["reason"]).toBe("session_ended");
    const log = await sim.db.selectFrom("admin_audit").select(["admin_id", "action"]).where("target_id", "=", agent.id).where("action", "=", "admin.role").execute();
    expect(log).toEqual([{ admin_id: owner.id, action: "admin.role" }]);
    await signInAgain(agent);
    expect((await agent.get("/admin/auth/me")).body["role"]).toBe("support");
    // The same role again changes nothing and ends nothing.
    expect(await changeAdminRole(sim.db, agent.id, "support", sim.clock.now)).toEqual({ from: "support", ended: 0 });
    expect((await agent.get("/admin/auth/me")).status).toBe(200);
  });

  it("deactivation ends the sessions the same way, on every admin route", async () => {
    const boss = await sim.admin("super");
    expect((await boss.get("/admin/agents")).status).toBe(200);
    await sim.db.updateTable("admins").set({ active: false }).where("admin_id", "=", boss.id).execute();
    const res = await sim.request("GET", "/admin/agents", boss.token);
    expect(res.status).toBe(401);
    expect(res.body["reason"]).toBe("session_ended");
    const refreshed = await sim.request("POST", "/admin/auth/refresh", undefined, { refreshToken: boss.session.refreshToken }, { key: null });
    expect(refreshed.status).toBe(401);
    const rows = await sim.db.selectFrom("auth_sessions").select("revoked_reason").where("actor", "=", "admin").where("subject_id", "=", boss.id).execute();
    expect(rows.map((r) => r.revoked_reason)).toEqual(["admin_deactivated", "admin_deactivated"]);
  });
});
