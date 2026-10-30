import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bookAndAccept, drive, PLACES, Sim, type Admin } from "./harness.js";

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

/** A multipart body with the fields and one file, as the driver app sends it. */
function multipart(fields: Record<string, string>, bytes: Buffer) {
  const boundary = "----movera-p4-boundary";
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="licence.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

describe("Phase 4: rate limits", () => {
  it("fleet join codes: after 10 wrong tries in an hour even the right code is refused (429 fleet_join_limit)", async () => {
    const driver = await sim.driver(1, null);
    // The member leaves the test fleet first, so a join is possible at all.
    expect((await driver.post("/driver/fleet/leave", { expectedVersion: (await driver.get("/driver/profile")).body["version"] })).status).toBe(200);
    for (let i = 0; i < 10; i++) {
      const res = await driver.post("/driver/fleet/join", { code: `MV-ZZZ${String(i).padStart(2, "0")}`, ownerName: "Test Åkare", ownerEmail: "akare@movera.test" });
      expect(res.body["reason"], JSON.stringify(res.body)).toBe("fleet_join_mismatch");
    }
    const right = await driver.post("/driver/fleet/join", { code: "MV-TESTA", ownerName: "Test Åkare", ownerEmail: "akare@movera.test" });
    expect(right.status, JSON.stringify(right.body)).toBe(429);
    expect(right.body["reason"]).toBe("fleet_join_limit");
  });

  it("P4-2: document uploads are limited per driver and hour (429 upload_limit), before the file is read", async () => {
    const driver = await sim.driver(2, null);
    const send = async () => {
      const { body, contentType } = multipart({ type: "driving_license" }, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("jpeg-bytes-".repeat(50))]));
      const res = await fetch(`${sim.base}/driver/documents`, { method: "POST", headers: { authorization: `Bearer ${driver.token}`, "content-type": contentType, "idempotency-key": `p4-upload-${Math.random().toString(36).slice(2)}-xxxxxxxx` }, body });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    for (let i = 0; i < 30; i++) {
      const res = await send();
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    }
    const over = await send();
    expect(over.status, JSON.stringify(over.body)).toBe(429);
    expect(over.body["reason"]).toBe("upload_limit");
    await sim.advance(3601);
    driver.session = await sim.signIn(driver.login, "driver"); // the access token ran out meanwhile
    expect((await send()).status).toBe(201);
  });
});

describe("Phase 4: server-side money validation", () => {
  it("P4-3: an admin cannot set a trip's fare below 0 (adjust, complete): 400 invalid_amount, nothing changes", async () => {
    const rider = await sim.rider(2);
    const driver = await sim.driver(0, PLACES.nearSergels);
    const { tripId } = await bookAndAccept(sim, rider, driver);
    await drive(driver, tripId, "in_trip");
    const before = await owner.trip(tripId);
    const adjust = await owner.tripCommand(tripId, "adjust", { expectedVersion: before.version, fare: { amountMinor: -5000, currency: "SEK" }, reason: "audit" });
    expect(adjust.status, JSON.stringify(adjust.body)).toBe(400);
    expect(adjust.body["reason"]).toBe("invalid_amount");
    const complete = await owner.tripCommand(tripId, "complete", { expectedVersion: before.version, fare: { amountMinor: -1, currency: "SEK" }, note: "audit" });
    expect(complete.status, JSON.stringify(complete.body)).toBe(400);
    expect(complete.body["reason"]).toBe("invalid_amount");
    const after = await owner.trip(tripId);
    expect({ v: after.version, fare: after.fare, status: after.status }).toEqual({ v: before.version, fare: before.fare, status: before.status });
    // A fare of 0 or more is still an admin's call.
    expect((await owner.tripCommand(tripId, "complete", { expectedVersion: before.version, fare: { amountMinor: 0, currency: "SEK" }, note: "audit" })).status).toBe(200);
  });
});
