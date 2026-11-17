import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { Sim, type Admin } from "./harness.js";
import { appendIncidentEvent } from "../../src/safety/incidents.js";

/**
 * S7 W2 Q126 = Q-B4 (owner 2026-11-15 "Yes, open ones only (Rec.)", contract v0.18.126): the admin alarm feed
 * GET /admin/incidents/stream with no cursor (no `after`, `after=0`, no Last-Event-ID) starts from the OPEN incidents
 * (open | investigating): one event per open incident, its newest one, oldest first, then live after the newest
 * sequence. Closed incidents' history is not replayed on a page load. A cursor still replays every event after it.
 */

let sim: Sim;
let admin: Admin;
const T = new Date("2026-11-17T08:00:00Z");

async function incident(id: string, status: string): Promise<void> {
  await sql`INSERT INTO incidents (incident_id, kind, severity, status, raised_by, zone_id, opened_at, updated_at)
            VALUES (${id}, 'sos', 'critical', ${status}, 'rider', 'Z001', ${T}, ${T})`.execute(sim.db);
}
async function event(sequence: number, id: string, kind: string, status: string): Promise<void> {
  const view = { incidentId: id, kind: "sos", severity: "critical", status, zoneId: "Z001", openedAt: T.toISOString() };
  await sql`INSERT INTO incident_events (sequence, event_id, incident_id, kind, zone_id, incident, occurred_at)
            VALUES (${sequence}, ${"evt_q126_" + sequence}, ${id}, ${kind}, 'Z001', ${JSON.stringify(view)}::jsonb, ${T})`.execute(sim.db);
}

beforeAll(async () => {
  sim = await Sim.start();
  admin = await sim.admin("safety", ["Z001"]);
  // A open (opened 1, updated 5), B closed (2, 3), C investigating (4), then 300 closed cases (6..605).
  await incident("inc_q126_a", "open");
  await incident("inc_q126_b", "resolved");
  await incident("inc_q126_c", "investigating");
  await event(1, "inc_q126_a", "incident_opened", "open");
  await event(2, "inc_q126_b", "incident_opened", "open");
  await event(3, "inc_q126_b", "incident_closed", "resolved");
  await event(4, "inc_q126_c", "incident_updated", "investigating");
  await event(5, "inc_q126_a", "incident_updated", "open");
  let sequence = 6;
  for (let n = 0; n < 300; n += 1) {
    await incident(`inc_q126_old${n}`, "dismissed");
    await event(sequence++, `inc_q126_old${n}`, "incident_opened", "open");
    await event(sequence++, `inc_q126_old${n}`, "incident_closed", "dismissed");
  }
});
afterAll(async () => {
  await sim.stop();
});

const ids = (events: { id: string }[]) => events.map((e) => Number(e.id));

describe("Q126: the incident alarm feed starts from the open incidents", () => {
  it("SSE without a cursor sends only the newest event of each open incident, oldest first, then live", async () => {
    const feed = await sim.stream("/admin/incidents/stream", admin.token);
    await feed.waitFor((e) => e.id === "5");
    await new Promise((r) => setTimeout(r, 300));
    expect(ids(feed.events)).toEqual([4, 5]);
    expect(feed.events.map((e) => e.data["incident"]["incidentId"])).toEqual(["inc_q126_c", "inc_q126_a"]);

    // Live: a new change arrives after the newest sequence (605), not a replay of the closed history.
    const row = await sim.db.selectFrom("incidents").selectAll().where("incident_id", "=", "inc_q126_c").executeTakeFirstOrThrow();
    await sim.db.transaction().execute((trx) => appendIncidentEvent(trx, row, "incident_updated", T));
    await feed.waitFor((e) => e.id === "606");
    expect(ids(feed.events)).toEqual([4, 5, 606]);
    feed.close();
  });

  it("after=0 is the same as no cursor; a real cursor still replays everything after it", async () => {
    const zero = await sim.stream("/admin/incidents/stream?after=0", admin.token);
    await zero.waitFor((e) => e.id === "606");
    await new Promise((r) => setTimeout(r, 200));
    expect(ids(zero.events)).toEqual([5, 606]);
    zero.close();

    const resumed = await sim.stream("/admin/incidents/stream", admin.token, "2");
    await resumed.waitFor((e) => e.id === "606", 8000);
    expect(ids(resumed.events).slice(0, 3)).toEqual([3, 4, 5]);
    expect(resumed.events).toHaveLength(604);
    resumed.close();
  });

  it("the JSON page without a cursor is the open snapshot, never cut by limit, with the newest sequence as cursor", async () => {
    const page = await admin.get("/admin/incidents/stream?limit=1");
    expect(page.status).toBe(200);
    expect(page.body["items"].map((e: { sequence: number }) => e.sequence)).toEqual([5, 606]);
    expect(page.body["nextCursor"]).toBeNull();
    const next = await admin.get("/admin/incidents/stream?after=2&limit=2");
    expect(next.body["items"].map((e: { sequence: number }) => e.sequence)).toEqual([3, 4]);
    expect(next.body["nextCursor"]).toBe("4");
  });
});
