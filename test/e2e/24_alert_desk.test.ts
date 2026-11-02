import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeOsrm, Sim, type Admin, type Json } from "./harness.js";

/**
 * Alerts full flow (contract v0.18.15 §38, contract.json#alertDesk; owner 2026-11-02 Q5 "FULL FLOW": take — the
 * others see who has it, pass on, snooze, mute types, quiet hours, done). Fails before: no /admin/alerts routes (404).
 */

let sim: Sim;
let osrm: Awaited<ReturnType<typeof fakeOsrm>>;
let owner: Admin;
let nora: Admin;
let erik: Admin;
const ALERT = { kind: "long_wait", level: "important", title: "Rider waits 9 min in Z001", zoneId: "Z001", since: "2026-10-26T08:50:00Z" };

beforeAll(async () => {
  osrm = await fakeOsrm({ distance: 8000, duration: 1080 });
  sim = await Sim.start({ osrmUrl: osrm.url, now: new Date("2026-10-26T09:00:00Z") });
  owner = await sim.owner();
  nora = await sim.admin("dispatcher", ["Z001"]);
  erik = await sim.admin("ops", ["Z001"]);
});
afterAll(async () => {
  await sim.stop();
  await osrm.close();
});

const record = (book: Json, id: string) => (book["records"] as Json[]).find((r) => r["alertId"] === id);

describe("take / pass / snooze / done: every admin sees who has it", () => {
  it("Nora takes it; Erik sees her name and cannot take or solve it; she passes it to Erik; Erik snoozes and solves", async () => {
    const taken = await nora.post("/admin/alerts/long_wait:Z001/take", ALERT);
    expect(taken.status).toBe(200);
    expect(record(taken.body, "long_wait:Z001")).toMatchObject({ status: "taken", owner: nora.id, ownerName: "dispatcher admin", kind: "long_wait", zoneId: "Z001" });
    const seen = await erik.get("/admin/alerts/book");
    expect(record(seen.body, "long_wait:Z001")).toMatchObject({ owner: nora.id, ownerName: "dispatcher admin" });
    expect(seen.body["people"].map((p: Json) => p["adminId"])).toEqual(expect.arrayContaining([nora.id, erik.id]));
    for (const verb of ["take", "done", "snooze", "pass"]) {
      const res = await erik.post(`/admin/alerts/long_wait:Z001/${verb}`, { ...ALERT, minutes: 10, to: erik.id });
      expect([verb, res.status, res.body["reason"]]).toEqual([verb, 409, "alert_taken"]);
    }
    expect((await nora.post("/admin/alerts/long_wait:Z001/pass", { ...ALERT, to: nora.id })).body["reason"]).toBe("assignee_not_allowed");
    const z002 = await sim.admin("dispatcher", ["Z002"]);
    expect((await nora.post("/admin/alerts/long_wait:Z001/pass", { ...ALERT, to: z002.id })).body["reason"]).toBe("assignee_not_allowed");
    const passed = await nora.post("/admin/alerts/long_wait:Z001/pass", { ...ALERT, to: erik.id });
    expect(record(passed.body, "long_wait:Z001")).toMatchObject({ owner: erik.id });
    const snoozed = await erik.post("/admin/alerts/long_wait:Z001/snooze", { ...ALERT, minutes: 30 });
    expect(record(snoozed.body, "long_wait:Z001")).toMatchObject({ status: "snoozed", owner: erik.id, snoozeUntil: "2026-10-26T09:30:00.000Z" });
    const done = await erik.post("/admin/alerts/long_wait:Z001/done", { ...ALERT, note: "Sent a driver" });
    const r = record(done.body, "long_wait:Z001")!;
    expect(r).toMatchObject({ status: "done", owner: erik.id });
    expect((r["events"] as Json[]).map((e) => e["kind"])).toEqual(["take", "pass", "snooze", "done"]);
    expect((r["events"] as Json[]).at(-1)).toMatchObject({ text: "Sent a driver", by: erik.id, byName: "ops admin" });
    const audit = await sim.db.selectFrom("admin_audit").select("action").where("target_id", "=", "long_wait:Z001").execute();
    expect(audit.map((a) => a.action).sort()).toEqual(["alert.done", "alert.pass", "alert.snooze", "alert.take"]);
    // A new alert with the same id after done starts fresh (nobody owns it).
    expect(record((await nora.post("/admin/alerts/long_wait:Z001/take", ALERT)).body, "long_wait:Z001")!["events"]).toHaveLength(1);
  });

  it("solving an alert nobody took takes and solves it at once; SOS / ride check stay in Incidents", async () => {
    const done = await nora.post("/admin/alerts/few_drivers:Z001/done", { ...ALERT, kind: "few_drivers" });
    expect(record(done.body, "few_drivers:Z001")!["events"].map((e: Json) => e["kind"])).toEqual(["take", "done"]);
    for (const kind of ["sos", "car_lost", "ride_check"]) {
      expect((await nora.post(`/admin/alerts/${kind}:x/take`, { ...ALERT, kind })).body["reason"]).toBe("alert_in_incidents");
    }
  });
});

describe("mutes, quiet hours, settings and rules", () => {
  it("a mute is for everyone until it runs out; quiet hours are per admin", async () => {
    const muted = await nora.put("/admin/alerts/mutes/long_wait", { minutes: 60 });
    expect(muted.body["mutes"]["long_wait"]).toMatchObject({ by: nora.id, until: expect.stringMatching(/T10:00/) });
    expect((await erik.get("/admin/alerts/book")).body["mutes"]).toHaveProperty("long_wait");
    const unmuted = await nora.send("DELETE", "/admin/alerts/mutes/long_wait");
    expect(unmuted.body["mutes"]).not.toHaveProperty("long_wait");
    await nora.put("/admin/alerts/mutes/few_drivers", { minutes: 1 });
    await sim.advance(65);
    expect((await nora.get("/admin/alerts/book")).body["mutes"]).not.toHaveProperty("few_drivers");
    const quiet = await nora.put("/admin/alerts/quiet", { on: true, from: "23:00", to: "06:30" });
    expect(quiet.body["quiet"]).toEqual({ on: true, from: "23:00", to: "06:30" });
    expect((await erik.get("/admin/alerts/book")).body["quiet"]).toEqual({ on: false, from: "22:00", to: "07:00" });
    expect((await nora.put("/admin/alerts/quiet", { on: true, from: "25:00", to: "06:30" })).status).toBe(400);
  });

  it("settings and rules: alerts.manage only, one revision at a time, the same for every admin", async () => {
    const book = (await owner.get("/admin/alerts/book")).body;
    expect((await nora.put("/admin/alerts/settings", { expectedRev: book["rev"], settings: { kinds: {} } })).status).toBe(403);
    const saved = await erik.put("/admin/alerts/settings", { expectedRev: book["rev"], settings: { kinds: { long_wait: { on: false } } } });
    expect(saved.body["rev"]).toBe(book["rev"] + 1);
    expect((await erik.put("/admin/alerts/rules", { expectedRev: book["rev"], rules: [] })).body["code"]).toBe("version_mismatch");
    const rules = await erik.put("/admin/alerts/rules", { expectedRev: saved.body["rev"], rules: [{ id: "r1", name: "Few drivers Z001", on: true }] });
    expect(rules.status).toBe(200);
    const fresh = (await nora.get("/admin/alerts/book")).body;
    expect(fresh).toMatchObject({ settings: { kinds: { long_wait: { on: false } } }, rules: [{ id: "r1" }] });
  });

  it("history for the export", async () => {
    const all = await owner.get("/admin/alerts/history?from=2026-10-26T00:00:00Z&to=2026-10-27T00:00:00Z");
    expect(all.body["items"].map((r: Json) => r["alertId"])).toEqual(expect.arrayContaining(["long_wait:Z001", "few_drivers:Z001"]));
    expect((await owner.get("/admin/alerts/history?from=2026-10-27T00:00:00Z")).body["items"]).toEqual([]);
  });
});
