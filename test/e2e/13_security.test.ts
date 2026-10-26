import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Sim, type Admin } from "./harness.js";

/** Audit Phase 4: security findings outside the route matrix (docs/audit/phase-4.md). */

let sim: Sim;
let owner: Admin;

beforeAll(async () => {
  sim = await Sim.start();
  owner = await sim.owner();
});
afterAll(async () => {
  await sim?.stop();
});

describe("Phase 4: admin password links", () => {
  it("P4-1: a Super admin limited to one zone cannot make a password link for an admin with a wider scope", async () => {
    const zoned = await sim.admin("super", ["Z002"]);
    const res = await zoned.post(`/admin/agents/${owner.id}/setup-link`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body["reason"]).toBe("zone_out_of_scope");
    const peer = await sim.admin("dispatcher", ["Z002"]);
    expect((await zoned.post(`/admin/agents/${peer.id}/setup-link`, {})).status).toBe(201);
    expect((await owner.post(`/admin/agents/${zoned.id}/setup-link`, {})).status).toBe(201);
  });
});
